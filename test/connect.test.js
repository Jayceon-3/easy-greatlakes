import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { connect, readConnectConfig, buildSubmitCommand } from '../src/connect.js';
import { main } from '../src/cli.js';

const config = readConnectConfig('gl-dev.config.json');
function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'gl-connect-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const options = { config, host: 'gl-login', timeout: 120, stateDir, noWait: true };
  const state = () => {
    const file = readdirSync(stateDir).find(name => name.endsWith('.json'));
    return file ? JSON.parse(readFileSync(join(stateDir, file), 'utf8')) : null;
  };
  const writeState = (value) => {
    const file = readdirSync(stateDir).find(name => name.endsWith('.json'));
    writeFileSync(join(stateDir, file), JSON.stringify(value));
  };
  return { options, state, writeState };
}
function queue(state, status = 'RUNNING') {
  return { body: `12345|${status}|${status === 'RUNNING' ? 'gl1504' : ''}|${state.name}|Resources` };
}

test('default resources match the confirmed 3-hour preset', () => {
  assert.deepEqual(config, { account: 'eecs442f26_class', partition: 'spgpu', gpus: 1, cpus: 4, memory: '24G', time: '03:00:00' });
});

test('submission saves intent before SSH and returns allocated node; rerun reuses it', async t => {
  const { options, state } = fixture(t);
  let submits = 0;
  const remote = (_options, command) => {
    if (command.includes('sbatch')) {
      submits++;
      assert.equal(state().phase, 'submitting');
      assert.match(command, /--time=03:00:00/);
      assert.match(command, /--wrap=sleep infinity/);
      return { body: '12345' };
    }
    return queue(state());
  };
  const first = await connect(options, { remote });
  assert.equal(first.node, 'gl1504');
  assert.equal(first.ready, true);
  assert.equal(state().jobId, '12345');
  assert.equal((await connect(options, { remote })).jobId, '12345');
  assert.equal(submits, 1);
});

test('pending jobs return with no-wait and can later resume without another submission', async t => {
  const { options, state } = fixture(t);
  await connect(options, { remote: (_o, cmd) => cmd.includes('sbatch') ? { body: '12345' } : queue(state(), 'PENDING') });
  let polls = 0;
  const result = await connect({ ...options, noWait: false }, {
    remote: (_o, cmd) => { assert.doesNotMatch(cmd, /sbatch/); return queue(state(), polls++ ? 'RUNNING' : 'PENDING'); },
    sleep: async ms => assert.equal(ms, 30000),
  });
  assert.equal(result.ready, true);
  assert.equal(polls, 2);
});

test('uncertain submission is recovered by unique job name', async t => {
  const { options, state } = fixture(t);
  await assert.rejects(connect(options, { remote: () => { throw new Error('connection lost'); } }), { code: 'SUBMISSION_UNKNOWN' });
  assert.equal(state().phase, 'submitting');
  const result = await connect(options, { remote: (_o, cmd) => { assert.doesNotMatch(cmd, /sbatch/); return queue(state()); } });
  assert.equal(result.jobId, '12345');
  assert.equal(state().phase, 'active');
});

test('uncertain submission with no matching job never resubmits', async t => {
  const { options } = fixture(t);
  await assert.rejects(connect(options, { remote: () => ({ body: 'malformed' }) }), { code: 'SUBMISSION_UNKNOWN' });
  await assert.rejects(connect(options, { remote: (_o, cmd) => { assert.doesNotMatch(cmd, /sbatch/); return { body: '' }; } }), { code: 'SUBMISSION_UNKNOWN' });
});

test('SSH failures and malformed queue output never trigger a replacement', async t => {
  const { options, state } = fixture(t);
  await connect(options, { remote: (_o, cmd) => cmd.includes('sbatch') ? { body: '12345' } : queue(state()) });
  for (const response of [null, { body: 'unexpected text' }]) {
    await assert.rejects(connect(options, { remote: (_o, cmd) => {
      assert.doesNotMatch(cmd, /sbatch/);
      if (!response) throw new Error('SSH failed');
      return response;
    } }));
  }
});

test('expired known allocation can be replaced; unrelated jobs are ignored', async t => {
  const { options, state, writeState } = fixture(t);
  await connect(options, { remote: (_o, cmd) => cmd.includes('sbatch') ? { body: '12345' } : queue(state()) });
  writeState({ ...state(), createdAt: 0 });
  let calls = 0;
  const result = await connect(options, { remote: (_o, cmd) => {
    calls++;
    if (calls === 1) return { body: '999|RUNNING|gl9999|manual-job|None' };
    if (cmd.includes('sbatch')) return { body: '12345' };
    return queue(state());
  } });
  assert.equal(result.ready, true);
  assert.equal(calls, 3);
});

test('newly submitted invisible jobs are not immediately replaced', async t => {
  const { options } = fixture(t);
  await assert.rejects(connect(options, { remote: (_o, cmd) => ({ body: cmd.includes('sbatch') ? '12345' : '' }) }), { code: 'JOB_NOT_VISIBLE' });
  await assert.rejects(connect(options, { remote: (_o, cmd) => { assert.doesNotMatch(cmd, /sbatch/); return { body: '' }; } }), { code: 'JOB_NOT_VISIBLE' });
});

test('changing resources while a managed job exists is rejected', async t => {
  const { options, state } = fixture(t);
  await connect(options, { remote: (_o, cmd) => cmd.includes('sbatch') ? { body: '12345' } : queue(state()) });
  await assert.rejects(connect({ ...options, config: { ...config, memory: '32G' } }, {
    remote: (_o, cmd) => { assert.doesNotMatch(cmd, /sbatch/); return queue(state()); },
  }), /different resources/);
});

test('concurrent connect is locked; abort releases lock while retaining saved job', async t => {
  const { options, state } = fixture(t);
  const controller = new AbortController();
  await assert.rejects(connect({ ...options, noWait: false, signal: controller.signal }, {
    remote: (_o, cmd) => cmd.includes('sbatch') ? { body: '12345' } : queue(state(), 'PENDING'),
    sleep: async () => {
      await assert.rejects(connect(options), /Another connect/);
      controller.abort();
    },
  }), { code: 'INTERRUPTED' });
  assert.equal(state().jobId, '12345');
  assert.equal(readdirSync(options.stateDir).some(name => name.endsWith('.lock')), false);
});

test('wait timeout returns pending allocation without cancelling it', async t => {
  const { options, state } = fixture(t);
  let clock = 100000;
  const result = await connect({ ...options, noWait: false, waitTimeout: 30 }, {
    now: () => clock,
    remote: (_o, cmd) => cmd.includes('sbatch') ? { body: '12345' } : queue(state(), 'PENDING'),
    sleep: async () => { clock += 30000; },
  });
  assert.equal(result.ready, false);
  assert.equal(result.state, 'PENDING');
});

test('generated submission command quotes shell arguments and preserves defaults', t => {
  const directory = mkdtempSync(join(tmpdir(), 'gl-submit-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'sbatch'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const result = spawnSync('/bin/sh', ['-c', buildSubmitCommand(config, "name'with;punctuation")], {
    stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0);
  const args = result.stdout.trim().split('\n');
  assert.ok(args.includes("--job-name=name'with;punctuation"));
  assert.ok(args.includes('--wrap=sleep infinity'));
  assert.ok(args.includes('--mem=24G'));
  assert.ok(args.includes('--time=03:00:00'));
});

test('CLI connect supports JSON and sends progress to stderr', async () => {
  const stdout = [], stderr = [];
  const code = await main(['connect', '--json', '--no-wait'], {
    out: line => stdout.push(line), err: line => stderr.push(line),
    runConnect: async (options, { progress }) => {
      assert.equal(options.config.time, '03:00:00');
      assert.equal(options.noWait, true);
      progress('Waiting');
      return { jobId: '12345', state: 'PENDING', ready: false };
    },
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout[0]).jobId, '12345');
  assert.deepEqual(stderr, ['Waiting']);
});

test('corrupt persisted state fails before any SSH or submission', async t => {
  const { options, state, writeState } = fixture(t);
  await connect(options, { remote: (_o, cmd) => cmd.includes('sbatch') ? { body: '12345' } : queue(state()) });
  writeState({ version: 999 });
  let called = false;
  await assert.rejects(connect(options, { remote: () => { called = true; } }), /Invalid saved state/);
  assert.equal(called, false);
});

test('wrong identity and unavailable job states never trigger a replacement', async t => {
  const { options, state } = fixture(t);
  await connect(options, { remote: (_o, cmd) => cmd.includes('sbatch') ? { body: '12345' } : queue(state()) });
  for (const [row, code] of [
    [`999|RUNNING|gl1504|${state().name}|None`, 'IDENTITY_MISMATCH'],
    [`12345|COMPLETING|gl1504|${state().name}|None`, 'JOB_UNAVAILABLE'],
    [`12345|PENDING||${state().name}|Resources\n12345|PENDING||${state().name}|Resources`, 'DUPLICATE_JOBS'],
  ]) {
    await assert.rejects(connect(options, { remote: (_o, cmd) => {
      assert.doesNotMatch(cmd, /sbatch/);
      return { body: row };
    } }), { code });
  }
});

test('invalid configuration and polling options fail before connect execution', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gl-config-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const update of [{ account: '' }, { cpus: 0 }, { gpus: 0 }, { memory: '0G' }, { time: '00:00:00' }]) {
    const path = join(directory, 'config.json');
    writeFileSync(path, JSON.stringify({ ...config, ...update }));
    assert.throws(() => readConnectConfig(path));
  }
  let called = false;
  const result = await main(['connect', '--poll-interval', '1'], {
    err: () => {}, runConnect: () => { called = true; },
  });
  assert.equal(result, 2);
  assert.equal(called, false);
});
