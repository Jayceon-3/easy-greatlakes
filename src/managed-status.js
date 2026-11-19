import { withStateLock, loadState } from './state.js';
import { runRemote, QueryError } from './ssh.js';
import { parseManagedQueue } from './connect.js';
import { validateOptions } from './status.js';

// Inspect the same state scope as connect/stop without submitting or cancelling.
export function queryManagedStatus(options, { remote = runRemote } = {}) {
  validateOptions({ ...options, jobId: '1' });
  return withStateLock(options, async statePath => {
    const checkAbort = () => {
      if (options.signal?.aborted) throw new QueryError('INTERRUPTED', 'Status query interrupted; saved job state was retained.');
    };
    checkAbort();
    const saved = loadState(statePath);
    if (!saved) return { host: options.host, jobId: null, node: null, state: 'NO_MANAGED_JOB', found: false,
      note: 'No saved managed job. Jobs submitted manually are not automatically selected.' };
    const { body } = remote(options, 'LC_ALL=C squeue --local --noheader --user="$USER" --format=\'%i|%T|%N|%j|%r|%M|%l|%L\'');
    checkAbort();
    const rows = body.split('\n').filter(Boolean).map(line => line.split('|').map(field => field.trim()));
    if (rows.some(row => row.length !== 8)) throw new QueryError('INVALID_OUTPUT', 'Unexpected queue output; job status could not be determined.');
    // Verify identity and timing from one queue snapshot, including when a prior
    // submission has a saved name but its JobID was not received locally.
    const job = parseManagedQueue(rows.map(row => row.slice(0, 5).join('|')).join('\n'), saved.name, saved.jobId);
    if (!job) return { host: options.host, jobId: saved.jobId ?? null, jobName: saved.name, node: null,
      state: saved.phase === 'submitting' ? 'SUBMISSION_UNKNOWN' : 'NOT_IN_QUEUE', found: false,
      note: saved.phase === 'submitting'
        ? 'The previous submission is unresolved. Inspect squeue/sacct by job name; saved state was retained.'
        : 'The saved job is not in the current queue. This does not establish why it ended; check sacct. Saved state was retained.' };
    const [, , , , , elapsed, timeLimit, timeLeft] = rows.find(row => row[0] === job.jobId);
    return { host: options.host, ...job, found: true, elapsed, timeLimit, timeLeft };
  });
}
