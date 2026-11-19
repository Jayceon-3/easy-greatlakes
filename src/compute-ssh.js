import { spawnSync } from 'node:child_process';
import { runRemote, QueryError } from './ssh.js';

export function prepareComputeSsh(options, { execute = spawnSync, remote = runRemote, progress = () => {} } = {}) {
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
  progress(`Authenticate gl-compute (${options.node}) in this WSL terminal. Verify any new host fingerprint against a trusted cluster record before accepting it.`);
  const master = execute('ssh', [...args, '-o', 'StrictHostKeyChecking=ask', '-MNf', 'gl-compute'], {
    stdio: 'inherit', timeout: options.timeout * 1000, killSignal: 'SIGKILL',
  });
  if (master.error || master.status !== 0) {
    throw new QueryError('SSH_PREPARE_FAILED', 'Compute-node authentication did not complete. The allocation is retained; retry in the WSL Connect terminal.');
  }
  const checked = execute('ssh', [...args, '-O', 'check', 'gl-compute'], {
    stdio: 'inherit', timeout: 10000, killSignal: 'SIGKILL',
  });
  if (checked.error || checked.status !== 0) throw new QueryError('SSH_MULTIPLEX_FAILED', 'No reusable compute SSH master was found after authentication. Check ControlPath; the allocation is retained.');
  const verified = remote({ ...options, host: 'gl-compute' }, 'hostname');
  if (verified.body !== options.node) throw new QueryError('SSH_NODE_MISMATCH', 'The SSH connection reaches a different node. No remote window will be opened.');
  progress(`Authenticated reusable SSH connection ready for ${options.node}.`);
  return { ready: true, host: 'gl-compute', node: options.node };
}
