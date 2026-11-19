import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function loadState(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state.version !== 1 || !/^gldev-[a-f0-9]{24}$/.test(state.name ?? '') ||
        !['submitting', 'active', 'stopping'].includes(state.phase) || !Number.isFinite(state.createdAt) ||
        (state.phase !== 'submitting' && !/^[1-9]\d*$/.test(state.jobId ?? ''))) {
      throw new Error('Invalid saved state; inspect it before continuing.');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function withStateLock(options, action) {
  const { host, sshConfig } = options;
  const stateDir = resolve(options.stateDir ?? join(homedir(), '.local/state/easy-greatlakes'));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const scope = createHash('sha256').update(JSON.stringify([host, sshConfig ? resolve(sshConfig) : null])).digest('hex').slice(0, 24);
  const statePath = join(stateDir, `${scope}.json`);
  const lockPath = `${statePath}.lock`;
  // Keep a stable inode for the kernel lock: unlinking an advisory lock file
  // would let concurrent recovery processes lock different inodes.
  const guard = openSync(`${lockPath}.guard`, 'a+', 0o600);
  let lock;
  try {
    const result = spawnSync('flock', ['--nonblock', '3'], {
      stdio: ['inherit', 'pipe', 'inherit', guard], timeout: 5000,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new Error('Could not acquire the local kernel lock. The WSL CLI requires flock (util-linux).');
    }
    if (result.status === 1) throw new Error(`Another connect or stop may be running. Lock: ${lockPath}. Wait for that local CLI process to finish.`);
    try {
      lock = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ownerText = readFileSync(lockPath, 'utf8').trim();
      if (!/^[1-9]\d*$/.test(ownerText) || !Number.isSafeInteger(Number(ownerText))) {
        throw new Error(`Incomplete or invalid lock owner at ${lockPath}. Inspect the local process before removing this lock.`);
      }
      const owner = Number(ownerText);
      let exited = false;
      try { process.kill(owner, 0); }
      catch (probeError) {
        if (probeError.code === 'ESRCH') exited = true;
        else if (probeError.code !== 'EPERM') throw probeError;
      }
      if (!exited) throw new Error(`Another connect or stop may be running (local PID ${owner}). Lock: ${lockPath}. No lock or job state was removed.`);
      // Kernel guard serializes stale-owner recovery and remains held throughout
      // the action, so two new CLI invocations cannot both reclaim this marker.
      unlinkSync(lockPath);
      lock = openSync(lockPath, 'wx', 0o600);
    }
    try {
      writeFileSync(lock, String(process.pid));
      return await action(statePath);
    } finally {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  } finally {
    closeSync(guard); // Also released by the OS if this process is killed.
  }
}

export function clearState(path) {
  unlinkSync(path);
}
