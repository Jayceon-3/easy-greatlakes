import { runRemote, QueryError } from './ssh.js';
export { QueryError } from './ssh.js';

// Only ordinary, single-node batch jobs are supported by this first prototype.
export function validateOptions({ jobId, host, timeout }) {
  if (!/^[1-9]\d{0,19}$/.test(jobId ?? '')) {
    throw new Error('JobID must be a positive integer; this version does not support array or heterogeneous jobs.');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host ?? '')) {
    throw new Error('--host must be an SSH host alias or hostname.');
  }
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) {
    throw new Error('--timeout must be an integer between 1 and 3600 seconds.');
  }
}

export function parseQueue(output, jobId, marker) {
  const lines = output.split(/\r?\n/).map(line => line.trim());
  const start = lines.indexOf(`${marker}_BEGIN`);
  const end = lines.indexOf(`${marker}_END`);
  if (start < 0 || end <= start) {
    throw new QueryError('INVALID_OUTPUT', 'Incomplete Slurm query output; job status could not be determined.');
  }
  const rows = lines.slice(start + 1, end).filter(Boolean);
  let job = null;
  for (const row of rows) {
    const fields = row.split('|').map(field => field.trim());
    if (fields.length !== 7 || !fields[0] || !/^[A-Z][A-Z_]*$/.test(fields[1])) {
      throw new QueryError('INVALID_OUTPUT', 'Unexpected Slurm output format; job status could not be determined.');
    }
    if (fields[0] !== jobId) continue;
    if (job) throw new QueryError('INVALID_OUTPUT', 'Duplicate JobID in query output; job status could not be determined.');
    const [id, state, rawNode, elapsed, timeLimit, timeLeft, reason] = fields;
    job = {
      jobId: id,
      state,
      node: !rawNode || /^(\(null\)|N\/A|None)$/i.test(rawNode) ? null : rawNode,
      elapsed,
      timeLimit,
      timeLeft,
      reason,
    };
  }
  return job;
}

export function queryStatus(options, execute) {
  validateOptions(options);
  const { jobId, host } = options;
  const { output, marker } = runRemote(options,
    'LC_ALL=C squeue --local --noheader --user="$USER" --format=\'%i|%T|%N|%M|%l|%L|%r\'', execute);
  const job = parseQueue(output, jobId, marker);
  return job
    ? { host, found: true, ...job }
    : { host, found: false, jobId, state: 'NOT_IN_QUEUE', node: null,
      note: "This JobID is not in the current user's queue. It may have ended or belong to another user; check sacct for details." };
}
