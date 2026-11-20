import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, watch, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { buildRecordedSubmission } from '../src/remote-submission.js';
import { buildSubmitCommand, connect, readConnectConfig } from '../src/connect.js';

const config = readConnectConfig('gl-dev.config.json');
const name = `gldev-${'a'.repeat(24)}`;
function fixture(t, source = 'echo call >> "$HOME/count"\nprintf "12345\\n"') {
  const home = mkdtempSync(join(tmpdir(), 'gl-receipt-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'bin'));
  writeFileSync(join(home, 'bin/sbatch'), `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}` };
  const command = buildRecordedSubmission(config, name, buildSubmitCommand(config, name));
  const run = (cmd = command) => spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env, timeout: 5000 });
  const calls = () => readFileSync(join(home, 'count'), 'utf8').trim().split('\n').length;
  return { home, env, command, run, calls };
}

test('real remote shell persists acceptance and returns the same ID without another sbatch', t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '12345');
  }
  assert.equal(f.calls(), 1);
  assert.equal(readFileSync(join(f.home, '.local/state/easy-greatlakes/requests', name, 'status'), 'utf8'), 'accepted 12345\n');
  const changed = { ...config, gpus: 2 };
  assert.notEqual(f.run(buildRecordedSubmission(changed, name, buildSubmitCommand(changed, name))).status, 0);
  assert.equal(f.calls(), 1);
});

test('ambiguous or failed submissions are never submitted twice', t => {
  for (const output of ['exit 1', 'printf "malformed\\n"']) {
    const f = fixture(t, `echo call >> "$HOME/count"\n${output}`);
    assert.notEqual(f.run().status, 0);
    assert.notEqual(f.run().status, 0);
    assert.equal(f.calls(), 1);
  }
});

test('concurrent receipt replay cannot pass the remote lock', async t => {
  const f = fixture(t, 'echo call >> "$HOME/count"\nwhile [ ! -f "$HOME/release" ]; do sleep 0.02; done\nprintf "12345\\n"');
  const started = new Promise((resolve, reject) => {
    const watcher = watch(f.home, () => {
      if (existsSync(join(f.home, 'count'))) { clearTimeout(timer); watcher.close(); resolve(); }
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Fake sbatch did not start')); }, 3000);
  });
  const child = spawn('/bin/sh', ['-c', f.command], { env: f.env });
  const done = new Promise(resolve => child.on('close', resolve));
  t.after(() => { if (existsSync(f.home)) writeFileSync(join(f.home, 'release'), ''); });
  await started;
  const competing = f.run();
  writeFileSync(join(f.home, 'release'), '');
  assert.equal(competing.status, 75);
  assert.equal(await done, 0);
  assert.equal(f.run().stdout.trim(), '12345');
  assert.equal(f.calls(), 1);
});

test('connect recovers a lost JobID response from the receipt without changing request name', async t => {
  const f = fixture(t);
  const stateDir = join(f.home, 'client');
  const state = () => JSON.parse(readFileSync(join(stateDir, readdirSync(stateDir).find(file => file.endsWith('.json'))), 'utf8'));
  let loseResponse = true;
  const remote = (_options, command) => {
    if (command === 'true') return { body: '' };
    if (command.includes('squeue')) {
      // Simulate a temporarily invisible queue until receipt recovery completes.
      return { body: state().phase === 'submitting' ? '' : `12345|RUNNING|gl1504|${state().name}|None` };
    }
    const result = f.run(command);
    assert.equal(result.status, 0, result.stderr);
    if (loseResponse) { loseResponse = false; throw new Error('SSH disconnected after acceptance'); }
    return { body: result.stdout.trim() };
  };
  const options = { config, host: 'gl-login', timeout: 120, stateDir, noWait: true };
  await assert.rejects(connect(options, { remote }), { code: 'SUBMISSION_UNKNOWN' });
  const original = state();
  const result = await connect(options, { remote });
  assert.equal(result.jobId, '12345');
  assert.equal(state().name, original.name);
  assert.equal(f.calls(), 1);
});

test('request that never reached the remote shell is submitted on ordinary retry', async t => {
  const f = fixture(t);
  const stateDir = join(f.home, 'client');
  const state = () => JSON.parse(readFileSync(join(stateDir, readdirSync(stateDir).find(file => file.endsWith('.json'))), 'utf8'));
  let disconnected = false;
  const remote = (_options, command) => {
    if (command === 'true') return { body: '' };
    if (command.includes('squeue')) return { body: state().phase === 'active' ? `12345|RUNNING|gl1504|${state().name}|None` : '' };
    if (!disconnected) { disconnected = true; throw new Error('Disconnected before remote execution'); }
    const result = f.run(command);
    assert.equal(result.status, 0, result.stderr);
    return { body: result.stdout.trim() };
  };
  const options = { config, host: 'gl-login', timeout: 120, stateDir, noWait: true };
  await assert.rejects(connect(options, { remote }), { code: 'SUBMISSION_UNKNOWN' });
  const originalName = state().name;
  await connect(options, { remote });
  assert.equal(state().name, originalName);
  assert.equal(f.calls(), 1);
});

test('accepted receipt with no visible queue entry restores the ID without submitting a replacement', async t => {
  const f = fixture(t);
  const stateDir = join(f.home, 'client');
  const state = () => JSON.parse(readFileSync(join(stateDir, readdirSync(stateDir).find(file => file.endsWith('.json'))), 'utf8'));
  let lost = false;
  const remote = (_options, command) => {
    if (command === 'true' || command.includes('squeue')) return { body: '' };
    const result = f.run(command);
    assert.equal(result.status, 0, result.stderr);
    if (!lost) { lost = true; throw new Error('Response lost'); }
    return { body: result.stdout.trim() };
  };
  const options = { config, stateDir, host: 'gl-login', timeout: 120, noWait: true };
  await assert.rejects(connect(options, { remote }), { code: 'SUBMISSION_UNKNOWN' });
  const original = state();
  await assert.rejects(connect({ ...options, config: { ...config, gpus: 2 } }, { remote }), /original resource parameters/);
  await assert.rejects(connect(options, { remote }), { code: 'JOB_NOT_VISIBLE' });
  assert.equal(state().jobId, '12345');
  assert.equal(state().name, original.name);
  assert.equal(state().phase, 'active');
  assert.equal(f.calls(), 1);
});

test('policy rejection is persisted, can be inspected, and never executes the same request twice', t => {
  const f = fixture(t, 'echo call >> "$HOME/count"\necho "sbatch: error: Batch job submission failed: Job violates accounting/QOS policy (limit)" >&2\nexit 1');
  for (const command of [f.command, buildRecordedSubmission(config, name, '', { probeOnly: true }), f.command]) {
    const result = f.run(command);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^REJECTED\n/);
    assert.match(result.stdout, /accounting\/QOS/);
  }
  assert.equal(f.calls(), 1);
});

test('transport failures remain unresolved, not rejected', t => {
  const f = fixture(t, 'echo call >> "$HOME/count"\necho "sbatch: error: Batch job submission failed: Socket timed out on send/recv operation" >&2\nexit 1');
  assert.equal(f.run().status, 76);
  const probe = f.run(buildRecordedSubmission(config, name, '', { probeOnly: true }));
  assert.equal(probe.stdout.trim(), 'UNRESOLVED');
  assert.equal(f.run().status, 76);
  assert.equal(f.calls(), 1);
});

test('rejected request permits changed resources on the next ordinary connect, including after response loss', async t => {
  for (const lostResponse of [false, true]) {
    const f = fixture(t, 'echo call >> "$HOME/count"\necho "sbatch: error: Batch job submission failed: Job violates accounting/QOS policy (limit)" >&2\nexit 1');
    const stateDir = join(f.home, 'client');
    const state = () => JSON.parse(readFileSync(join(stateDir, readdirSync(stateDir).find(file => file.endsWith('.json'))), 'utf8'));
    let lose = lostResponse;
    const remote = (_options, command) => {
      if (command === 'true') return { body: '' };
      if (command.includes('squeue')) return { body: state().phase === 'active' ? `12345|RUNNING|gl1504|${state().name}|None` : '' };
      const result = f.run(command);
      if (result.status) throw new Error('Remote failed');
      if (lose) { lose = false; throw new Error('SSH disconnected'); }
      return { body: result.stdout.trim() };
    };
    const options = { config, stateDir, host: 'gl-login', timeout: 120, noWait: true };
    await assert.rejects(connect(options, { remote }), { code: lostResponse ? 'SUBMISSION_UNKNOWN' : 'SUBMISSION_REJECTED' });
    const originalName = state().name;
    writeFileSync(join(f.home, 'bin/sbatch'), '#!/bin/sh\necho call >> "$HOME/count"\nprintf "12345\\n"', { mode: 0o700 });
    const nextConfig = { ...config, time: '01:00:00' };
    await connect({ ...options, config: nextConfig, reuseManaged: lostResponse }, { remote });
    assert.notEqual(state().name, originalName);
    assert.deepEqual(state().config, nextConfig);
    assert.equal(f.calls(), 2);
    assert.ok(readdirSync(stateDir).some(file => file.endsWith('.bak')));
  }
});
