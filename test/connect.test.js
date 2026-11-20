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
  if (!state) return { body: '' }; // Login preflight has no saved request yet.
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
  await assert.rejects(connect(options, { remote: (_o, command) => {
    if (command === 'true') return { body: '' };
    throw new Error('connection lost');
  } }), { code: 'SUBMISSION_UNKNOWN' });
  assert.equal(state().phase, 'submitting');
  const result = await connect(options, { remote: (_o, cmd) => { assert.doesNotMatch(cmd, /sbatch/); return queue(state()); } });
  assert.equal(result.jobId, '12345');
  assert.equal(state().phase, 'active');
});

test('uncertain submission with no matching job never resubmits', async t => {
  const { options, state, writeState } = fixture(t);
  await assert.rejects(connect(options, { remote: () => ({ body: 'malformed' }) }), { code: 'SUBMISSION_UNKNOWN' });
  writeState({ ...state(), remoteSubmissionVersion: undefined }); // Legacy request without remote receipts.
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
  assert.equal(calls, 4);
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
  assert.match(stderr[0], /Requested resources:/);
  assert.match(stderr[0], /GPUs: 1/);
  assert.deepEqual(stderr.slice(1), ['Waiting']);
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

test('VPN/login failure before submission creates no intent and the next connect can submit', async t => {
  const { options, state } = fixture(t);
  for (const code of ['SSH_FAILED', 'TIMEOUT', 'INTERRUPTED']) {
    await assert.rejects(connect(options, { remote: (_o, command) => {
      assert.equal(command, 'true');
      assert.equal(state(), null);
      throw Object.assign(new Error('Login unavailable'), { code });
    } }), { code });
    assert.equal(state(), null);
  }
  let submits = 0;
  await connect(options, { remote: (_o, command) => {
    if (command === 'true') return { body: '' };
    if (command.includes('sbatch')) { submits++; return { body: '12345' }; }
    return queue(state());
  } });
  assert.equal(submits, 1);
});

test('aborting after preflight does not leave a submission intent', async t => {
  const { options, state } = fixture(t);
  const controller = new AbortController();
  await assert.rejects(connect({ ...options, signal: controller.signal }, {
    remote: (_o, command) => {
      assert.equal(command, 'true');
      controller.abort();
      return { body: '' };
    },
  }), { code: 'INTERRUPTED' });
  assert.equal(state(), null);
});

test('confirmed unsubmitted request is backed up and retried after a successful empty queue query', async t => {
  const { options, state, writeState } = fixture(t);
  await assert.rejects(connect(options, { remote: (_o, cmd) => {
    if (cmd === 'true') return { body: '' };
    throw new Error('lost response');
  } }), { code: 'SUBMISSION_UNKNOWN' });
  writeState({ ...state(), remoteSubmissionVersion: undefined });
  const original = state();
  let submitted = false;
  await connect({ ...options, retryUnsubmitted: original.name }, { remote: (_o, cmd) => {
    assert.ok(!cmd.includes('scancel'));
    if (cmd === 'true') return { body: '' };
    if (cmd.includes('sbatch')) {
      submitted = true;
      assert.notEqual(state().name, original.name);
      return { body: '12345' };
    }
    return submitted ? queue(state()) : { body: '999|RUNNING|gl9999|manual-important|None' };
  } });
  const backup = readdirSync(options.stateDir).find(file => file.endsWith('.bak'));
  assert.deepEqual(JSON.parse(readFileSync(join(options.stateDir, backup), 'utf8')), original);
  assert.equal(state().phase, 'active');
});

test('confirmed retry cannot bypass query errors or a different saved request', async t => {
  const { options, state } = fixture(t);
  await assert.rejects(connect(options, { remote: (_o, cmd) => {
    if (cmd === 'true') return { body: '' };
    throw new Error('lost response');
  } }));
  const original = state();
  await assert.rejects(connect({ ...options, retryUnsubmitted: `gldev-${'0'.repeat(24)}` }, {
    remote: () => assert.fail('wrong request must not reach SSH'),
  }), { code: 'IDENTITY_MISMATCH' });
  await assert.rejects(connect({ ...options, retryUnsubmitted: original.name }, {
    remote: (_o, cmd) => { assert.ok(cmd.includes('squeue')); throw new Error('VPN unavailable'); },
  }), /VPN unavailable/);
  assert.deepEqual(state(), original);
  assert.ok(!readdirSync(options.stateDir).some(file => file.endsWith('.bak')));
  // If the supposedly unsubmitted request exists, reuse it instead of resubmitting.
  const result = await connect({ ...options, retryUnsubmitted: original.name }, {
    remote: (_o, cmd) => { assert.ok(cmd.includes('squeue')); return queue(state()); },
  });
  assert.equal(result.jobId, '12345');
  assert.equal(state().name, original.name);
});

test('CLI forwards exact confirmed request names and rejects invalid recovery flags', async () => {
  const request = `gldev-${'a'.repeat(24)}`;
  assert.equal(await main(['connect', '--retry-unsubmitted', request], {
    runConnect: async options => {
      assert.equal(options.retryUnsubmitted, request);
      return { jobId: '12345', state: 'PENDING', ready: false };
    }, out: () => {}, err: () => {},
  }), 0);
  for (const argv of [['connect', '--retry-unsubmitted', 'bad'], ['stop', '--retry-unsubmitted', request], ['status', '--retry-unsubmitted', request]]) {
    assert.equal(await main(argv, {
      runConnect: () => assert.fail('invalid recovery must not connect'),
      runStop: () => assert.fail('invalid recovery must not stop'),
      managedQuery: () => assert.fail('invalid recovery must not query'),
      err: () => {},
    }), 2);
  }
});

test('reuse-managed uses custom CLI allocation resources even when defaults differ', async t => {
  for (const status of ['RUNNING', 'PENDING']) {
    const { options, state } = fixture(t);
    const custom = { ...config, gpus: 2, cpus: 8, memory: '48G', time: '01:00:00' };
    await connect({ ...options, config: custom }, {
      remote: (_o, cmd) => cmd === 'true' ? { body: '' } : cmd.includes('sbatch') ? { body: '12345' } : queue(state(), status),
    });
    const original = state();
    const logs = [];
    const result = await connect({ ...options, reuseManaged: true }, {
      remote: (_o, cmd) => { assert.ok(cmd.includes('squeue')); return queue(state(), status); },
      progress: line => logs.push(line),
    });
    assert.equal(result.jobId, '12345');
    assert.equal(result.ready, status === 'RUNNING');
    assert.deepEqual(state(), original);
    assert.ok(logs.some(line => line.includes('2 GPU') && line.includes('01:00:00')));
  }
});

test('reuse-managed submits defaults when no job exists or the saved job ended', async t => {
  const { options, state, writeState } = fixture(t);
  let submitting = false;
  const remote = (_o, cmd) => {
    if (cmd === 'true') return { body: '' };
    if (cmd.includes('sbatch')) {
      submitting = true;
      assert.equal(state().config.gpus, 1);
      assert.equal(state().config.time, '03:00:00');
      return { body: '12345' };
    }
    return submitting ? queue(state()) : { body: '' };
  };
  await connect({ ...options, reuseManaged: true }, { remote });
  const originalName = state().name;
  writeState({ ...state(), config: { ...config, gpus: 2 }, createdAt: 0 });
  submitting = false;
  await connect({ ...options, reuseManaged: true }, { remote });
  assert.notEqual(state().name, originalName);
  assert.deepEqual(state().config, config);
});

test('reuse-managed never falls back on failed queries or invalid saved resources', async t => {
  const { options, state, writeState } = fixture(t);
  await connect(options, { remote: (_o, cmd) => cmd === 'true' ? { body: '' } : cmd.includes('sbatch') ? { body: '12345' } : queue(state()) });
  await assert.rejects(connect({ ...options, reuseManaged: true }, {
    remote: (_o, cmd) => { assert.ok(cmd.includes('squeue')); throw new Error('SSH failed'); },
  }), /SSH failed/);
  writeState({ ...state(), config: { account: 'example' } });
  await assert.rejects(connect({ ...options, reuseManaged: true }, {
    remote: (_o, cmd) => { assert.ok(cmd.includes('squeue')); return queue(state()); },
  }), { code: 'INVALID_SAVED_CONFIG' });
});

test('CLI reuse-managed forwards preference and rejects conflicting flags', async () => {
  assert.equal(await main(['connect', '--reuse-managed'], {
    runConnect: async options => {
      assert.equal(options.reuseManaged, true);
      return { jobId: '12345', state: 'PENDING', ready: false };
    }, out: () => {}, err: () => {},
  }), 0);
  for (const argv of [['status', '--reuse-managed'], ['connect', '--reuse-managed', '--dry-run'], ['connect', '--reuse-managed', '--gpus', '2']]) {
    assert.equal(await main(argv, { runConnect: () => assert.fail('must not connect'), err: () => {} }), 2);
  }
});
