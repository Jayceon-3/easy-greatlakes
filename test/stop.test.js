import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { connect, readConnectConfig } from '../src/connect.js';
import { stop, buildCancelCommand } from '../src/stop.js';
import { main } from '../src/cli.js';

async function fixture(t, phase = 'active') {
  const stateDir = mkdtempSync(join(tmpdir(), 'gl-stop-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const options = { host: 'gl-login', timeout: 120, stateDir, config: readConnectConfig('gl-dev.config.json'), noWait: true };
  const path = () => join(stateDir, readdirSync(stateDir).find(name => name.endsWith('.json')));
  const state = () => JSON.parse(readFileSync(path(), 'utf8'));
  const row = (status = 'RUNNING') => `12345|${status}|gl1504|${state().name}|None`;
  if (phase === 'submitting') {
    await assert.rejects(connect(options, { remote: (_o, cmd) => {
      if (cmd === 'true') return { body: '' };
      throw new Error('lost response');
    } }));
  } else if (phase !== 'none') {
    await connect(options, { remote: (_o, cmd) => ({ body: cmd === 'true' ? '' : cmd.includes('sbatch') ? '12345' : row() }) });
  }
  return { options, state, row, path, write: value => writeFileSync(path(), JSON.stringify(value)),
    hasState: () => readdirSync(stateDir).some(name => name.endsWith('.json')) };
}

test('running and pending jobs are cancelled by exact ID, name and remote owner', async t => {
  for (const status of ['RUNNING', 'PENDING']) {
    const f = await fixture(t);
    let cancelled = false;
    const result = await stop(f.options, { remote: (_o, cmd) => {
      if (cmd.startsWith('scancel')) {
        assert.equal(f.state().phase, 'stopping');
        assert.equal(cmd, `scancel --user="$USER" '--name=${f.state().name}' '12345'`);
        cancelled = true;
        return { body: '' };
      }
      return { body: cancelled ? '' : `${f.row(status)}\n999|RUNNING|gl1504|unrelated-important-job|None` };
    } });
    assert.equal(result.released, true);
    assert.equal(result.cancelled, true);
    assert.equal(f.hasState(), false);
    assert.equal((await stop(f.options)).state, 'NO_MANAGED_JOB');
  }
});

test('no state is a successful no-op and does not connect to SSH', async t => {
  const f = await fixture(t, 'none');
  const result = await stop(f.options, { remote: () => assert.fail('must not call SSH') });
  assert.equal(result.state, 'NO_MANAGED_JOB');
});

test('expected JobID is a guard, never permission to cancel an arbitrary job', async t => {
  for (const phase of ['none', 'active']) {
    const f = await fixture(t, phase);
    await assert.rejects(stop({ ...f.options, expectedJobId: '999' }, { remote: () => assert.fail('must not call SSH') }));
  }
});

test('older absent job clears stale state without cancelling any other job', async t => {
  const f = await fixture(t);
  f.write({ ...f.state(), createdAt: 0 });
  const result = await stop(f.options, { remote: (_o, cmd) => {
    assert.doesNotMatch(cmd, /scancel/);
    return { body: '999|RUNNING|gl1504|important-job|None' };
  } });
  assert.equal(result.cancelled, false);
  assert.equal(result.state, 'NOT_IN_QUEUE');
  assert.equal(f.hasState(), false);
});

test('query failure, malformed output and identity mismatches retain state without cancelling', async t => {
  const f = await fixture(t);
  for (const body of [null, 'malformed', `12345|RUNNING|gl1504|renamed-job|None`, `999|RUNNING|gl1504|${f.state().name}|None`]) {
    await assert.rejects(stop(f.options, { remote: (_o, cmd) => {
      assert.doesNotMatch(cmd, /scancel/);
      if (body === null) throw new Error('SSH failed');
      return { body };
    } }));
    assert.equal(f.hasState(), true);
    assert.equal(f.state().phase, 'active');
  }
});

test('recent invisible or unresolved submissions are retained', async t => {
  for (const phase of ['active', 'submitting']) {
    const f = await fixture(t, phase);
    await assert.rejects(stop(f.options, { remote: (_o, cmd) => {
      assert.doesNotMatch(cmd, /scancel/);
      return { body: '' };
    } }), { code: phase === 'active' ? 'JOB_NOT_VISIBLE' : 'SUBMISSION_UNKNOWN' });
    assert.equal(f.hasState(), true);
  }
});

test('unknown submission can be recovered by name and then cancelled', async t => {
  const f = await fixture(t, 'submitting');
  let cancelled = false;
  const result = await stop(f.options, { remote: (_o, cmd) => {
    if (cmd.startsWith('scancel')) { cancelled = true; return { body: '' }; }
    return { body: cancelled ? '' : f.row() };
  } });
  assert.equal(result.jobId, '12345');
  assert.equal(result.released, true);
});

test('lost cancellation response retains stopping state; retry verifies release', async t => {
  const f = await fixture(t);
  await assert.rejects(stop(f.options, { remote: (_o, cmd) => {
    if (cmd.startsWith('scancel')) throw new Error('response lost');
    return { body: f.row() };
  } }), { code: 'CANCEL_UNCONFIRMED' });
  assert.equal(f.state().phase, 'stopping');
  const result = await stop(f.options, { remote: (_o, cmd) => {
    assert.doesNotMatch(cmd, /scancel/);
    return { body: '' };
  } });
  assert.equal(result.released, true);
  assert.equal(f.hasState(), false);
});

test('no-wait retains state until release is confirmed and connect cannot reuse it', async t => {
  const f = await fixture(t);
  const remote = (_o, cmd) => ({ body: cmd.startsWith('scancel') ? '' : f.row('COMPLETING') });
  const result = await stop(f.options, { remote });
  assert.equal(result.released, false);
  assert.equal(result.cancellationRequested, true);
  await assert.rejects(connect(f.options, { remote }), { code: 'CANCEL_PENDING' });
  assert.equal(f.state().phase, 'stopping');
});

test('confirmation query failures preserve stopping state', async t => {
  const f = await fixture(t);
  let queries = 0;
  await assert.rejects(stop(f.options, { remote: (_o, cmd) => {
    if (cmd.startsWith('scancel')) return { body: '' };
    if (queries++) throw new Error('network failed');
    return { body: f.row() };
  } }));
  assert.equal(f.state().phase, 'stopping');
});

test('wait polls to completion, holds shared lock, and cancellation is sent only once', async t => {
  const f = await fixture(t);
  let queries = 0, cancels = 0;
  const result = await stop({ ...f.options, noWait: false }, {
    remote: (_o, cmd) => {
      if (cmd.startsWith('scancel')) { cancels++; return { body: '' }; }
      return { body: queries++ < 2 ? f.row() : '' };
    },
    sleep: async ms => {
      assert.equal(ms, 15000);
      await assert.rejects(stop(f.options), /Another connect or stop/);
      await assert.rejects(connect(f.options), /Another connect or stop/);
    },
  });
  assert.equal(result.released, true);
  assert.equal(cancels, 1);
});

test('wait timeout and interrupt retain state and release the local lock', async t => {
  for (const abort of [false, true]) {
    const f = await fixture(t);
    let clock = Date.now();
    const controller = new AbortController();
    const action = stop({ ...f.options, noWait: false, waitTimeout: 15, signal: controller.signal }, {
      now: () => clock,
      remote: (_o, cmd) => ({ body: cmd.startsWith('scancel') ? '' : f.row() }),
      sleep: async () => { clock += 15000; if (abort) controller.abort(); },
    });
    if (abort) await assert.rejects(action, { code: 'INTERRUPTED' });
    else assert.equal((await action).released, false);
    assert.equal(f.state().phase, 'stopping');
    assert.equal(readdirSync(f.options.stateDir).some(name => name.endsWith('.lock')), false);
  }
});

test('cancel shell command passes exactly one job ID and scoped filters', t => {
  const directory = mkdtempSync(join(tmpdir(), 'gl-cancel-shell-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'scancel'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const jobName = 'gldev-' + 'a'.repeat(24);
  const result = spawnSync('/bin/sh', ['-c', buildCancelCommand({ jobId: '12345', jobName })], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, USER: 'test-user' },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split('\n'), ['--user=test-user', `--name=${jobName}`, '12345']);
  assert.throws(() => buildCancelCommand({ jobId: '123;id', jobName }));
  assert.throws(() => buildCancelCommand({ jobId: '12345', jobName: 'manual-job' }));
});

test('CLI stop uses the saved scope without requiring a config file and supports JSON', async () => {
  const out = [], err = [];
  const code = await main(['stop', '--config', '/does/not/exist', '--job-id', '12345', '--json'], {
    out: line => out.push(line), err: line => err.push(line),
    runStop: async (options, { progress }) => {
      assert.equal(options.expectedJobId, '12345');
      assert.equal(options.waitTimeout, 120);
      assert.equal(options.pollInterval, 15);
      progress('Target: 12345');
      return { jobId: '12345', released: true, state: 'NOT_IN_QUEUE' };
    },
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out[0]).released, true);
  assert.deepEqual(err, ['Target: 12345']);
});
