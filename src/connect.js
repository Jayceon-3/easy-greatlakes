import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { saveState, loadState, withStateLock } from './state.js';
import { setTimeout as delay } from 'node:timers/promises';
import { runRemote, shellQuote, QueryError } from './ssh.js';
import { validateOptions } from './status.js';

export const DEFAULT_RESOURCES = Object.freeze({
  partition: 'spgpu', gpus: 1, cpus: 4, memory: '24G', time: '03:00:00',
});

export function readConnectConfig(path) {
  const supplied = JSON.parse(readFileSync(path, 'utf8'));
  const config = { ...DEFAULT_RESOURCES, ...supplied };
  for (const key of ['account', 'partition']) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config[key] ?? '')) {
      throw new Error(`Configuration field ${key} must be a nonempty account or partition name.`);
    }
  }
  for (const key of ['gpus', 'cpus']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer.`);
  }
  if (!/^\d+[MG]$/.test(config.memory) || parseInt(config.memory) < 1) throw new Error('memory must use a positive M or G value, such as 24G.');
  if (!/^\d{2,3}:[0-5]\d:[0-5]\d$/.test(config.time) || !/[1-9]/.test(config.time)) throw new Error('time must be a positive HH:MM:SS value.');
  return Object.fromEntries(['account', ...Object.keys(DEFAULT_RESOURCES)].map(key => [key, config[key]]));
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
  const { config, host, timeout, signal } = options;
  validateOptions({ jobId: '1', host, timeout });
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
    let job = state ? query(state) : null; // A query error always stops here.
    if (state?.phase === 'stopping' && job) throw new QueryError('CANCEL_PENDING', 'The managed job is stopping. Run stop to confirm release before connecting again.');
    if (state && job) {
      if (JSON.stringify(state.config) !== JSON.stringify(config)) throw new Error('The managed allocation uses different resources. Cancel it before changing the preset.');
      if (state.phase === 'submitting') {
        state = { ...state, phase: 'active', jobId: job.jobId };
        saveState(statePath, state);
      }
      progress(`Reusing job ${job.jobId} (${job.state}).`);
    } else if (state?.phase === 'submitting') {
      throw new QueryError('SUBMISSION_UNKNOWN', `Previous submission result is unknown. Inspect squeue/sacct for job name ${state.name}. No new job was submitted. State: ${statePath}`);
    } else if (state && state.phase !== 'stopping' && now() - state.createdAt < 60000) {
      throw new QueryError('JOB_NOT_VISIBLE', 'The recently submitted job is not visible yet. Retry connect shortly; no new job was submitted.');
    } else {
      checkAbort();
      state = { version: 1, phase: 'submitting', name: `gldev-${randomUUID().replaceAll('-', '').slice(0, 24)}`, config, createdAt: now() };
      saveState(statePath, state); // Persist intent before the network mutation.
      progress(`Submitting ${state.name}: ${config.gpus} GPU, ${config.cpus} CPUs, ${config.memory}, ${config.time}.`);
      let response;
      try {
        response = remote(options, buildSubmitCommand(config, state.name)).body;
        if (!/^[1-9]\d*$/.test(response)) throw new Error('Unexpected sbatch response.');
      } catch (error) {
        // Even a timeout can occur after Slurm accepted the job. Reconcile by name
        // on the next invocation instead of blindly submitting a second request.
        throw new QueryError('SUBMISSION_UNKNOWN', `${error.message} Submission may have succeeded. Rerun connect to reconcile job name ${state.name}; do not submit manually. State: ${statePath}`);
      }
      state = { ...state, phase: 'active', jobId: response };
      saveState(statePath, state);
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
