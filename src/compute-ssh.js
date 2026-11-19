import { spawnSync } from 'node:child_process';
import { lstatSync, unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runRemote, QueryError } from './ssh.js';

function removeStaleSocket(path, args, { execute, files, progress }) {
  // ssh -G expands ControlPath tokens. Never guess a path or remove other files.
  if (!isAbsolute(path)) throw new QueryError('SSH_MULTIPLEX_FAILED', 'Automatic socket recovery requires an absolute ControlPath.');
  let original;
  try { original = files.lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!original.isSocket() || original.uid !== process.getuid()) {
    throw new QueryError('SSH_MULTIPLEX_FAILED', `Refusing to remove ControlPath ${path}: it is not a socket owned by the current user.`);
  }
  const probe = execute('ssh', [...args, '-S', path, '-O', 'check', 'gl-compute'], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' }, timeout: 10000, killSignal: 'SIGKILL',
  });
  if (!probe.error && !probe.signal && probe.status === 0) return;
  // A timeout, permission error, or failed command does not establish staleness.
  if (probe.error || probe.signal || probe.status !== 255 ||
      !probe.stderr?.split(/\r?\n/).includes(`Control socket connect(${path}): Connection refused`)) {
    throw new QueryError('SSH_MULTIPLEX_FAILED', `Could not confirm that ControlPath ${path} is stale; it was preserved. ${probe.stderr ?? ''}`);
  }
  try {
    const current = files.lstatSync(path);
    if (!current.isSocket() || current.dev !== original.dev || current.ino !== original.ino || current.uid !== original.uid) {
      throw new QueryError('SSH_MULTIPLEX_FAILED', 'ControlPath changed during recovery; it was preserved. Retry Connect.');
    }
    files.unlinkSync(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  progress(`Removed stale SSH control socket: ${path}`);
}

export function prepareComputeSsh(options, { execute = spawnSync, remote = runRemote, progress = () => {}, files = { lstatSync, unlinkSync } } = {}) {
  if (!/^gl\d+$/.test(options.node)) throw new Error('Expected a single Great Lakes compute node.');
  const args = options.sshConfig ? ['-F', options.sshConfig] : [];
  const effective = execute('ssh', ['-G', '-T', ...args, 'gl-compute'], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], timeout: 10000, killSignal: 'SIGKILL',
  });
  if (effective.error || effective.status !== 0) throw new QueryError('SSH_PREPARE_FAILED', 'Could not inspect gl-compute SSH settings.');
  const fields = new Map((effective.stdout ?? '').trim().split(/\r?\n/).map(line => {
    const space = line.indexOf(' '); return [line.slice(0, space), line.slice(space + 1).trim()];
  }));
  if (fields.get('hostname') !== options.node) throw new QueryError('SSH_NODE_MISMATCH', 'gl-compute no longer points at the allocated node; refusing to authenticate another target.');
  if (!['auto', 'true', 'yes', 'ask', 'autoask'].includes(fields.get('controlmaster')) ||
      !fields.get('controlpath') || fields.get('controlpath') === 'none' ||
      !fields.get('controlpersist') || ['0', 'no', 'false'].includes(fields.get('controlpersist'))) {
    throw new QueryError('SSH_MULTIPLEX_REQUIRED', 'Enable ControlMaster auto, ControlPath ~/.ssh/cm-%C and ControlPersist 30m for gl-login/gl-compute before preparing the Remote SSH connection.');
  }
  removeStaleSocket(fields.get('controlpath'), args, { execute, files, progress });
  progress(`Authenticate gl-compute (${options.node}) in this WSL terminal. Verify any new host fingerprint against a trusted cluster record before accepting it.`);
  const authenticate = () => execute('ssh', [...args, '-o', 'StrictHostKeyChecking=ask', '-MNf', 'gl-compute'], {
    stdio: 'inherit', timeout: options.timeout * 1000, killSignal: 'SIGKILL',
  });
  let master = authenticate();
  // SSH reports transport failures (including Broken pipe) with 255. Keep the
  // real terminal attached; retry once without killing any shared connections.
  // This can also retry authentication failures, which use the same exit code.
  if (!master.error && !master.signal && master.status === 255) {
    progress('SSH authentication/transport failed (exit 255). Retrying once with the same allocation; password/Okta may be requested again. Existing SSH masters are preserved.');
    removeStaleSocket(fields.get('controlpath'), args, { execute, files, progress });
    master = authenticate();
  }
  if (master.error || master.status !== 0) {
    throw new QueryError('SSH_PREPARE_FAILED', 'Compute-node authentication did not complete. The allocation is retained; retry in the WSL Connect terminal.');
  }
  const checked = execute('ssh', [...args, '-O', 'check', 'gl-compute'], {
    stdio: 'inherit', timeout: 10000, killSignal: 'SIGKILL',
  });
  if (checked.error || checked.status !== 0) throw new QueryError('SSH_MULTIPLEX_FAILED', 'No reusable compute SSH master was found after authentication. Check ControlPath; the allocation is retained.');
  const verified = remote({ ...options, host: 'gl-compute' }, 'hostname');
  // Great Lakes hostname may return the short name or its full cluster domain.
  if (![options.node, `${options.node}.arc-ts.umich.edu`].includes(verified.body)) {
    throw new QueryError('SSH_NODE_MISMATCH', `Expected ${options.node}, but SSH hostname returned ${JSON.stringify(verified.body)}. No remote window will be opened.`);
  }
  progress(`Authenticated reusable SSH connection ready for ${options.node}.`);
  return { ready: true, host: 'gl-compute', node: options.node };
}
