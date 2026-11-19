import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withStateLock } from '../src/state.js';

async function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'gl-state-recovery-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const options = { host: 'gl-login', stateDir };
  let path;
  await withStateLock(options, statePath => { path = statePath; writeFileSync(path, '{"jobId":"12345"}'); });
  return { options, path, lock: path + '.lock' };
}

function exitedPid(directory) {
  const path = join(directory, 'exited-pid');
  const result = spawnSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path)}, String(process.pid))`], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'],
  });
  assert.equal(result.status, 0);
  const pid = readFileSync(path, 'utf8');
  assert.match(pid, /^[1-9]\d*$/);
  return pid;
}

test('legacy dead-owner lock is reclaimed automatically without changing job state', async t => {
  const f = await fixture(t);
  writeFileSync(f.lock, exitedPid(f.options.stateDir));
  const original = readFileSync(f.path, 'utf8');
  let ran = false;
  await withStateLock(f.options, path => {
    ran = true;
    assert.equal(readFileSync(f.lock, 'utf8'), String(process.pid));
    assert.equal(readFileSync(path, 'utf8'), original);
  });
  assert.equal(ran, true);
  assert.equal(existsSync(f.lock), false);
  assert.equal(readFileSync(f.path, 'utf8'), original);
});

test('live legacy owner is preserved and action never runs', async t => {
  const f = await fixture(t);
  writeFileSync(f.lock, String(process.pid));
  await assert.rejects(withStateLock(f.options, () => assert.fail('must not run')), /local PID/);
  assert.equal(readFileSync(f.lock, 'utf8'), String(process.pid));
});

test('empty and malformed owner records are not blindly removed', async t => {
  const f = await fixture(t);
  for (const owner of ['', '-1', 'not-a-pid', '123456789012345678901234567890']) {
    writeFileSync(f.lock, owner);
    await assert.rejects(withStateLock(f.options, () => assert.fail('must not run')), /invalid lock owner/);
    assert.equal(readFileSync(f.lock, 'utf8'), owner);
  }
});

test('kernel lock releases after SIGKILL, allowing automatic recovery of its marker', async t => {
  const f = await fixture(t);
  const source = `import { withStateLock } from ${JSON.stringify(new URL('../src/state.js', import.meta.url).href)};
    await withStateLock(${JSON.stringify(f.options)}, () => process.kill(process.pid, 'SIGKILL'));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['inherit', 'pipe', 'inherit'], timeout: 5000,
  });
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(existsSync(f.lock), true);
  await withStateLock(f.options, () => {});
  assert.equal(existsSync(f.lock), false);
});

test('two contenders recovering the same dead marker cannot both enter', async t => {
  const f = await fixture(t);
  writeFileSync(f.lock, exitedPid(f.options.stateDir));
  let release, entered = 0;
  const first = withStateLock(f.options, async () => { entered++; await new Promise(resolve => { release = resolve; }); });
  await assert.rejects(withStateLock(f.options, () => { entered++; }), /Another connect or stop/);
  assert.equal(entered, 1);
  release();
  await first;
  assert.equal(readdirSync(f.options.stateDir).filter(name => name.endsWith('.guard')).length, 1);
});

test('action failure releases both locks for a subsequent retry', async t => {
  const f = await fixture(t);
  await assert.rejects(withStateLock(f.options, () => { throw new Error('failure'); }), /failure/);
  await withStateLock(f.options, () => {});
  assert.equal(existsSync(f.lock), false);
});
