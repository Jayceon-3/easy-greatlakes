import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { saveState, loadState, withStateLock } from './state.js';
import { setTimeout as delay } from 'node:timers/promises';
import { runRemote, shellQuote, QueryError } from './ssh.js';
import { validateOptions } from './status.js';
import { buildRecordedSubmission } from './remote-submission.js';

export const DEFAULT_RESOURCES = Object.freeze({
  partition: 'spgpu', gpus: 1, cpus: 4, memory: '24G', time: '03:00:00',
});

export function resolveConnectConfig(supplied = {}, overrides = {}) {
  for (const value of [supplied, overrides]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resource configuration must be a JSON object.');
  }
  const config = { ...DEFAULT_RESOURCES, ...supplied, ...overrides };
  for (const key of ['account', 'partition']) {
    if (typeof config[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config[key])) {
      throw new Error(`Configuration field ${key} must be a nonempty account or partition name.`);
    }
  }
  for (const key of ['gpus', 'cpus']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer.`);
  }
  if (typeof config.memory !== 'string' || !/^\d+[MG]$/.test(config.memory) || parseInt(config.memory) < 1) throw new Error('memory must use a positive M or G value, such as 24G.');
  if (typeof config.time !== 'string' || !/^\d{2,3}:[0-5]\d:[0-5]\d$/.test(config.time) || !/[1-9]/.test(config.time)) throw new Error('time must be a positive HH:MM:SS value.');
  return Object.fromEntries(['account', ...Object.keys(DEFAULT_RESOURCES)].map(key => [key, config[key]]));
}

export function readConnectConfig(path, overrides = {}) {
  return resolveConnectConfig(JSON.parse(readFileSync(path, 'utf8')), overrides);
}

export function buildSubmitCommand(config, name) {
  const args = [
    '--parsable', `--job-name=${name}`, `--account=${config.account}`,
    `--partition=${config.partition}`, `--gres=gpu:${config.gpus}`,
    '--nodes=1', '--ntasks=1', `--cpus-per-task=${config.cpus}`,
    `--mem=${config.memory}`, `--time=${config.time}`, '--chdir=.',
    '--output=slurm-%j.out', '--wrap=sleep infinity',
  ];
  // Use home for predictable logs. Each argument is quoted for the remote shell.
  return `(cd "$HOME" && sbatch ${args.map(shellQuote).join(' ')})`;
}

export function parseManagedQueue(body, name, jobId) {
  const matches = [];
  for (const line of body.split('\n').filter(Boolean)) {
    const fields = line.split('|').map(value => value.trim());
    if (fields.length !== 5 || !/^[A-Z][A-Z_]*$/.test(fields[1])) {
      throw new QueryError('INVALID_OUTPUT', 'Unexpected queue output; refusing to change managed jobs.');
    }
    if (jobId && fields[0] === jobId && fields[3] !== name) {
      throw new QueryError('IDENTITY_MISMATCH', 'Saved JobID now has a different job name.');
    }
    if (fields[3] !== name) continue;
    if (!/^[1-9]\d*$/.test(fields[0]) || (jobId && fields[0] !== jobId)) {
      throw new QueryError('IDENTITY_MISMATCH', 'Managed job identity does not match saved state.');
    }
    const [id, state, rawNode, jobName, reason] = fields;
    matches.push({ jobId: id, state, node: !rawNode || rawNode === '(null)' ? null : rawNode, jobName, reason });
  }
  if (matches.length > 1) throw new QueryError('DUPLICATE_JOBS', 'Multiple jobs match the saved request; inspect the queue before continuing.');
  return matches[0] ?? null;
}

export async function connect(options, {
  remote = runRemote, sleep = delay, now = Date.now, progress = () => {},
} = {}) {
  const { host, timeout, signal } = options;
  let config = options.config;
  validateOptions({ jobId: '1', host, timeout });
  if (options.retryUnsubmitted !== undefined && !/^gldev-[a-f0-9]{24}$/.test(options.retryUnsubmitted)) {
    throw new Error('--retry-unsubmitted must identify the exact unsubmitted request name.');
  }
  const interval = options.pollInterval ?? 30;
  const waitTimeout = options.waitTimeout ?? 1800;
  if (!Number.isInteger(interval) || interval < 15 || interval > 300) throw new Error('Poll interval must be 15 to 300 seconds.');
  if (!Number.isInteger(waitTimeout) || waitTimeout < 0 || waitTimeout > 86400) throw new Error('Wait timeout must be 0 to 86400 seconds.');
  return withStateLock(options, async (statePath) => {
    const checkAbort = () => { if (signal?.aborted) throw new QueryError('INTERRUPTED', 'Waiting interrupted. The Slurm job is retained; rerun connect to resume.'); };
    const query = (state) => {
      checkAbort();
      const { body } = remote(options, 'LC_ALL=C squeue --local --noheader --user="$USER" --format=\'%i|%T|%N|%j|%r\'');
      return parseManagedQueue(body, state.name, state.jobId);
    };
    let state = loadState(statePath);
    if (options.retryUnsubmitted && (state?.phase !== 'submitting' || state.name !== options.retryUnsubmitted)) {
      throw new QueryError('IDENTITY_MISMATCH', 'The confirmed unsubmitted request does not match saved submitting state. No new job was submitted.');
    }
    let job = state ? query(state) : null; // A query error always stops here.
    if (options.reuseManaged && state && (job || state.phase === 'submitting')) {
      const keys = ['account', 'partition', 'gpus', 'cpus', 'memory', 'time'];
      if (!state.config || !keys.every(key => Object.hasOwn(state.config, key))) {
        throw new QueryError('INVALID_SAVED_CONFIG', 'The managed request lacks a complete resource configuration. State retained; no new job was submitted.');
      }
      config = resolveConnectConfig(state.config);
      progress(`Using saved resources for ${state.name}: ${config.gpus} GPU, ${config.cpus} CPUs, ${config.memory}, ${config.time}; account ${config.account}, partition ${config.partition}.`);
    }
    const submitRecorded = request => {
      checkAbort();
      let response;
      try {
        response = remote(options, buildRecordedSubmission(request.config, request.name, buildSubmitCommand(request.config, request.name))).body;
      } catch (error) {
        throw new QueryError('SUBMISSION_UNKNOWN', `${error.message} Request ${request.name} is retained. Rerun the same connect command to recover its remote submission record. State: ${statePath}`);
      }
      if (response.startsWith('REJECTED\n')) {
        const rejectionReason = response.slice('REJECTED\n'.length);
        saveState(statePath, { ...request, phase: 'rejected', rejectionReason });
        throw new QueryError('SUBMISSION_REJECTED', `Slurm rejected the resource request:\n${rejectionReason}\nAdjust resources or retry later using connect. No JobID was created.`);
      }
      if (!/^[1-9]\d*$/.test(response)) throw new QueryError('SUBMISSION_UNKNOWN', 'Unexpected recorded submission response; request retained.');
      const accepted = { ...request, phase: 'active', jobId: response };
      saveState(statePath, accepted);
      return accepted;
    };
    if (state?.phase === 'submitting' && !job && state.remoteSubmissionVersion === 1) {
      // Inspect old receipt BEFORE comparing this invocation's resource values.
      // A confirmed rejection is terminal and permits a new configuration.
      const receipt = remote(options, buildRecordedSubmission(state.config, state.name, '', { probeOnly: true })).body;
      if (receipt.startsWith('REJECTED\n')) {
        state = { ...state, phase: 'rejected', rejectionReason: receipt.slice('REJECTED\n'.length) };
        saveState(statePath, state);
      } else if (receipt === 'UNRESOLVED') {
        throw new QueryError('SUBMISSION_UNKNOWN', `Remote receipt for ${state.name} is still unresolved; no new job was submitted.`);
      } else if (receipt !== 'NOT_SUBMITTED' && !/^[1-9]\d*$/.test(receipt)) {
        throw new QueryError('SUBMISSION_UNKNOWN', 'Unexpected remote receipt; no new job was submitted.');
      }
    }
    if (state?.phase === 'rejected') {
      if (job) throw new QueryError('IDENTITY_MISMATCH', 'A supposedly rejected request has a queued job. State retained; inspect before continuing.');
      checkAbort();
      saveState(`${statePath}.rejected-${state.name}.bak`, state);
      progress(`Previous request ${state.name} was rejected by Slurm. Preparing a new request with the current resources.`);
      state = null;
      config = options.config;
    }
    if (state?.phase === 'submitting' && !job && state.remoteSubmissionVersion === 1) {
      if (JSON.stringify(state.config) !== JSON.stringify(config)) throw new Error('The unresolved request uses different resources. Retry with the original resource parameters.');
      progress(`Recovering remote submission record for ${state.name}...`);
      state = submitRecorded(state);
      job = query(state);
      if (!job) throw new QueryError('JOB_NOT_VISIBLE', `Recovered JobID ${state.jobId}, but it is not in the queue. Check sacct; no replacement was submitted during this invocation.`);
    }
    if (state?.phase === 'submitting' && !job) {
      if (options.retryUnsubmitted !== state.name) {
        throw new QueryError('SUBMISSION_UNKNOWN', `Previous submission result is unknown. Inspect squeue/sacct for job name ${state.name}. If you have confirmed it was never submitted, retry with --retry-unsubmitted ${state.name}. No new job was submitted. State: ${statePath}`);
      }
      checkAbort();
      const backup = `${statePath}.unsubmitted-${state.name}.bak`;
      saveState(backup, state);
      progress(`Confirmed unsubmitted request ${state.name}; saved backup: ${backup}. Preparing a new request.`);
      state = null;
    }
    if (state?.phase === 'stopping' && job) throw new QueryError('CANCEL_PENDING', 'The managed job is stopping. Run stop to confirm release before connecting again.');
    if (state && job) {
      if (JSON.stringify(state.config) !== JSON.stringify(config)) throw new Error('The managed allocation uses different resources. Cancel it before changing the preset.');
      if (state.phase === 'submitting') {
        state = { ...state, phase: 'active', jobId: job.jobId };
        saveState(statePath, state);
      }
      progress(`Reusing job ${job.jobId} (${job.state}).`);
    } else if (state && state.phase !== 'stopping' && now() - state.createdAt < 60000) {
      throw new QueryError('JOB_NOT_VISIBLE', 'The recently submitted job is not visible yet. Retry connect shortly; no new job was submitted.');
    } else {
      checkAbort();
      // Finish VPN/SSH/Okta checks before persisting any new submission intent.
      // Failure here cannot have submitted a job: the only remote command is true.
      progress('Checking login connection before submitting resources...');
      remote(options, 'true');
      checkAbort();
      state = { version: 1, remoteSubmissionVersion: 1, phase: 'submitting', name: `gldev-${randomUUID().replaceAll('-', '').slice(0, 24)}`, config, createdAt: now() };
      saveState(statePath, state); // Persist intent before the network mutation.
      progress(`Submitting ${state.name}: ${config.gpus} GPU, ${config.cpus} CPUs, ${config.memory}, ${config.time}.`);
      state = submitRecorded(state);
      progress(`Submitted job ${state.jobId}. State: ${statePath}`);
    }
    const started = now();
    for (;;) {
      checkAbort();
      if (!job) job = query(state);
      if (!job) throw new QueryError('JOB_NOT_VISIBLE', `Job ${state.jobId} is not in the queue. Check sacct; no replacement was submitted during this invocation.`);
      const result = { host, ...job, statePath };
      if (job.state === 'RUNNING' && job.node) {
        if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(job.node)) throw new Error('Expected a single compute node, received a node list.');
        return { ...result, ready: true };
      }
      if (!['PENDING', 'CONFIGURING', 'RUNNING'].includes(job.state)) {
        throw new QueryError('JOB_UNAVAILABLE', `Job ${job.jobId} is ${job.state}. No replacement was submitted.`);
      }
      if (options.noWait || now() - started >= waitTimeout * 1000) return { ...result, ready: false };
      progress(`Job ${job.jobId}: ${job.state} (${job.reason}). Waiting ${interval}s; Ctrl+C retains the job.`);
      try { await sleep(interval * 1000, undefined, { signal }); }
      catch (error) { checkAbort(); throw error; }
      job = null;
    }
  });
}
