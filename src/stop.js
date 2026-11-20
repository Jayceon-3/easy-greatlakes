import { setTimeout as delay } from 'node:timers/promises';
import { runRemote, shellQuote, QueryError } from './ssh.js';
import { loadState, saveState, clearState, withStateLock } from './state.js';
import { parseManagedQueue } from './connect.js';
import { validateOptions } from './status.js';

export function buildCancelCommand(job) {
  // Require all three: exact ID, unique managed name, and current remote owner.
  validateOptions({ jobId: job.jobId, host: 'gl-login', timeout: 120 });
  if (!/^gldev-[a-f0-9]{24}$/.test(job.jobName)) throw new Error('Invalid managed job name.');
  return `scancel --user="$USER" ${shellQuote(`--name=${job.jobName}`)} ${shellQuote(job.jobId)}`;
}

export async function stop(options, {
  remote = runRemote, sleep = delay, now = Date.now, progress = () => {},
} = {}) {
  validateOptions({ jobId: options.expectedJobId ?? '1', host: options.host, timeout: options.timeout });
  const interval = options.pollInterval ?? 15;
  const waitTimeout = options.waitTimeout ?? 120;
  if (!Number.isInteger(interval) || interval < 15 || interval > 300) throw new Error('Poll interval must be 15 to 300 seconds.');
  if (!Number.isInteger(waitTimeout) || waitTimeout < 0 || waitTimeout > 86400) throw new Error('Wait timeout must be 0 to 86400 seconds.');
  return withStateLock(options, async statePath => {
    const checkAbort = () => {
      if (options.signal?.aborted) throw new QueryError('INTERRUPTED', 'Stop interrupted. Cancellation may already have been sent; rerun stop to verify release.');
    };
    checkAbort();
    let state = loadState(statePath);
    if (!state) {
      if (options.expectedJobId) throw new QueryError('NO_MANAGED_JOB', 'No saved managed job matches --job-id. No cancellation was sent.');
      return { host: options.host, state: 'NO_MANAGED_JOB', jobId: null, released: true, cancelled: false, statePath };
    }
    if (options.expectedJobId && state.jobId && options.expectedJobId !== state.jobId) {
      throw new QueryError('IDENTITY_MISMATCH', 'The saved JobID does not match --job-id. No cancellation was sent.');
    }
    const query = () => {
      checkAbort();
      const { body } = remote(options, 'LC_ALL=C squeue --local --noheader --user="$USER" --format=\'%i|%T|%N|%j|%r\'');
      return parseManagedQueue(body, state.name, state.jobId);
    };
    let job = query();
    if (state.phase === 'rejected' && job) throw new QueryError('IDENTITY_MISMATCH', 'A rejected request unexpectedly matches a queued job. No cancellation was sent.');
    if (!job) {
      if (state.phase === 'submitting') throw new QueryError('SUBMISSION_UNKNOWN', `Submission is unresolved. Inspect squeue/sacct for ${state.name}; saved state was retained.`);
      if (!['stopping', 'rejected'].includes(state.phase) && now() - state.createdAt < 60000) {
        throw new QueryError('JOB_NOT_VISIBLE', 'The recent job is not visible yet. Retry shortly; saved state was retained.');
      }
      clearState(statePath);
      return { host: options.host, jobId: state.jobId, state: 'NOT_IN_QUEUE', released: true, cancelled: false, statePath };
    }
    if (options.expectedJobId && options.expectedJobId !== job.jobId) {
      throw new QueryError('IDENTITY_MISMATCH', 'Recovered JobID does not match --job-id. No cancellation was sent.');
    }
    checkAbort();
    progress(`Cancelling managed job ${job.jobId} (${job.jobName}, ${job.state}, node ${job.node ?? 'not allocated'}) on ${options.host}.`);
    state = { ...state, phase: 'stopping', jobId: job.jobId };
    saveState(statePath, state); // Keep identity even when scancel's response is lost.
    try {
      remote(options, buildCancelCommand(job));
    } catch (error) {
      throw new QueryError('CANCEL_UNCONFIRMED', `${error.message} Cancellation is unconfirmed; saved state was retained. Rerun stop to verify.`);
    }
    const started = now();
    for (;;) {
      job = query();
      if (!job) {
        clearState(statePath);
        return { host: options.host, jobId: state.jobId, state: 'NOT_IN_QUEUE', released: true, cancelled: true, statePath };
      }
      if (options.noWait || now() - started >= waitTimeout * 1000) {
        return { host: options.host, ...job, released: false, cancellationRequested: true, statePath };
      }
      progress(`Job ${job.jobId}: ${job.state}. Waiting ${interval}s for release; Ctrl+C stops local waiting only.`);
      try { await sleep(interval * 1000, undefined, { signal: options.signal }); }
      catch (error) { checkAbort(); throw error; }
    }
  });
}
