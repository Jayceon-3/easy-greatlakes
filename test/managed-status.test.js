import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStateLock, saveState } from '../src/state.js';
import { queryManagedStatus } from '../src/managed-status.js';
import { main } from '../src/cli.js';

const name = `gldev-${'a'.repeat(24)}`;
const resources = { account: 'custom_class', partition: 'custom_gpu', gpus: 2, cpus: 8, memory: '48G', time: '06:00:00' };
async function fixture(t, state) {
  const stateDir = mkdtempSync(join(tmpdir(), 'gl-managed-status-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const options = { host: 'gl-login', timeout: 120, stateDir };
  let statePath;
  await withStateLock(options, path => {
    statePath = path;
    if (state) saveState(path, { version: 1, phase: 'active', name, jobId: '12345', createdAt: 1, ...state });
  });
  return { options, statePath };
}

test('no managed state returns without SSH', async t => {
  const { options } = await fixture(t);
  const result = await queryManagedStatus(options, { remote: () => assert.fail('must not query') });
  assert.equal(result.state, 'NO_MANAGED_JOB');
  assert.equal(result.found, false);
});

test('managed status verifies ID and name, preserves state and handles pending jobs', async t => {
  const { options, statePath } = await fixture(t, {});
  const original = readFileSync(statePath, 'utf8');
  for (const [state, node] of [['RUNNING', 'gl1504'], ['PENDING', '(null)']]) {
    const result = await queryManagedStatus(options, {
      remote: (_options, command) => {
        assert.ok(command.includes('squeue'));
        assert.ok(!command.includes('scancel'));
        assert.ok(command.includes('%M|%l|%L'));
        return { body: `12345|${state}|${node}|${name}|None|00:05|3:00:00|2:59:55` };
      },
    });
    assert.equal(result.jobId, '12345');
    assert.equal(result.found, true);
    assert.equal(result.elapsed, '00:05');
    assert.equal(result.timeLimit, '3:00:00');
    assert.equal(result.timeLeft, '2:59:55');
    assert.equal(result.node, node === '(null)' ? null : node);
  }
  await assert.rejects(queryManagedStatus(options, { remote: () => ({ body: '12345|RUNNING|gl1504|manual-job|None|00:05|3:00:00|2:59:55' }) }), { code: 'IDENTITY_MISMATCH' });
  await assert.rejects(queryManagedStatus(options, { remote: () => { throw new Error('SSH failed'); } }), /SSH failed/);
  assert.equal(readFileSync(statePath, 'utf8'), original);
});

test('absent or unresolved jobs are reported without deleting their records', async t => {
  for (const phase of ['active', 'submitting']) {
    const { options, statePath } = await fixture(t, { phase });
    const original = readFileSync(statePath, 'utf8');
    const result = await queryManagedStatus(options, { remote: () => ({ body: '' }) });
    assert.equal(result.found, false);
    assert.equal(result.state, phase === 'active' ? 'NOT_IN_QUEUE' : 'SUBMISSION_UNKNOWN');
    assert.equal(readFileSync(statePath, 'utf8'), original);
  }
});

test('CLI status without JobID returns managed status JSON and respects state scope', async () => {
  const output = [];
  const code = await main(['status', '--json', '--state-dir', '/tmp/example'], {
    managedQuery: async options => {
      assert.equal(options.stateDir, '/tmp/example');
      return { host: 'gl-login', jobId: '12345', found: true, state: 'RUNNING' };
    }, out: text => output.push(text), err: text => assert.fail(text),
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(output[0]).jobId, '12345');
});

test('incomplete submission is resolved by name without saving recovered state', async t => {
  const { options, statePath } = await fixture(t, { phase: 'submitting', jobId: undefined });
  const original = readFileSync(statePath, 'utf8');
  const result = await queryManagedStatus(options, {
    remote: () => ({ body: `12345|PENDING|(null)|${name}|Resources|0:00|3:00:00|3:00:00` }),
  });
  assert.equal(result.jobId, '12345');
  assert.equal(result.reason, 'Resources');
  assert.equal(result.state, 'PENDING');
  assert.equal(readFileSync(statePath, 'utf8'), original);
});

test('malformed output and duplicate identities report errors without changing records', async t => {
  const { options, statePath } = await fixture(t, {});
  const original = readFileSync(statePath, 'utf8');
  const row = `12345|RUNNING|gl1504|${name}|None|0:05|3:00:00|2:59:55`;
  for (const body of ['bad output', row + '\n' + row]) {
    await assert.rejects(queryManagedStatus(options, { remote: () => ({ body }) }));
    assert.equal(readFileSync(statePath, 'utf8'), original);
  }
});

test('CLI managed status prints useful timing and absence messages', async () => {
  const cases = [
    { found: true, jobId: '12345', jobName: name, node: 'gl1504', state: 'RUNNING', elapsed: '0:05', timeLimit: '3:00:00', timeLeft: '2:59:55', reason: 'None' },
    { found: false, jobId: null, node: null, state: 'NO_MANAGED_JOB', note: 'No saved managed job.' },
    { found: false, jobId: '12345', node: null, state: 'SUBMISSION_UNKNOWN', note: 'Previous submission is unresolved.' },
  ];
  for (const result of cases) {
    const output = [];
    const code = await main(['status'], {
      managedQuery: async () => result,
      out: text => output.push(text), err: text => assert.fail(text),
    });
    assert.equal(code, 0);
    const text = output.join('\n');
    assert.ok(!text.includes('undefined'));
    assert.ok(text.includes(result.state));
    if (result.found) {
      assert.match(text, /Time left: 2:59:55/);
      assert.match(text, /Time limit: 3:00:00/);
      assert.match(text, /Elapsed: 0:05/);
    } else assert.ok(text.includes(result.note));
  }
});

test('managed query failure emits an error rather than a false ended status', async () => {
  const output = [], errors = [];
  const code = await main(['status', '--json'], {
    managedQuery: async () => { throw Object.assign(new Error('SSH failed; status unknown'), { code: 'SSH_FAILED' }); },
    out: text => output.push(text), err: text => errors.push(text),
  });
  assert.equal(code, 1);
  assert.deepEqual(output, []);
  assert.equal(JSON.parse(errors[0]).error.code, 'SSH_FAILED');
});

test('status reports submitted resources in running, pending and absent jobs without altering state', async t => {
  const { options, statePath } = await fixture(t, { config: resources });
  const before = readFileSync(statePath, 'utf8');
  for (const state of ['RUNNING', 'PENDING', 'NOT_IN_QUEUE']) {
    const result = await queryManagedStatus(options, {
      remote: () => ({ body: state === 'NOT_IN_QUEUE' ? '' : `12345|${state}|gl1504|${name}|None|0:05|3:00:00|2:59:55` }),
    });
    assert.deepEqual(result.requestedConfig, resources);
    // Live time limit can differ; retain the original requested runtime.
    if (result.found) assert.equal(result.timeLimit, '3:00:00');
    assert.equal(readFileSync(statePath, 'utf8'), before);
    const stdout = [];
    assert.equal(await main(['status', '--json'], {
      managedQuery: async () => result, out: text => stdout.push(text), err: text => assert.fail(text),
    }), 0);
    assert.deepEqual(JSON.parse(stdout[0]).requestedConfig, resources);
    const text = [];
    await main(['status'], { managedQuery: async () => result, out: line => text.push(line), err: line => assert.fail(line) });
    assert.match(text.join('\n'), /Requested resources \(saved at submission\)/);
    assert.match(text.join('\n'), /GPUs: 2/);
    assert.match(text.join('\n'), /CPU memory: 48G/);
    assert.match(text.join('\n'), /Requested time limit: 06:00:00/);
  }
});

test('legacy or invalid resource snapshots are unavailable, without synthesizing defaults', async t => {
  for (const config of [undefined, null, {}, { account: 'example' }, { ...resources, gpus: 0 }]) {
    const { options } = await fixture(t, { config });
    const result = await queryManagedStatus(options, { remote: () => ({ body: '' }) });
    assert.equal(result.requestedConfig, null);
    const output = [];
    await main(['status'], { managedQuery: async () => result, out: text => output.push(text), err: text => assert.fail(text) });
    assert.match(output.join('\n'), /Requested resources: unavailable/);
  }
});

test('unresolved submissions retain resource snapshots and explicit ID queries do not gain managed config', async t => {
  const { options } = await fixture(t, { phase: 'submitting', jobId: undefined, config: resources });
  const result = await queryManagedStatus(options, { remote: () => ({ body: '' }) });
  assert.equal(result.state, 'SUBMISSION_UNKNOWN');
  assert.deepEqual(result.requestedConfig, resources);
  const output = [];
  assert.equal(main(['status', '99999', '--json'], {
    managedQuery: () => assert.fail('must not read managed state'),
    query: () => ({ jobId: '99999', state: 'NOT_IN_QUEUE', found: false }),
    out: text => output.push(text), err: text => assert.fail(text),
  }), 0);
  assert.equal(Object.hasOwn(JSON.parse(output[0]), 'requestedConfig'), false);
});

test('definitively rejected request is distinct from unresolved submission', async t => {
  const { options } = await fixture(t, { phase: 'rejected', jobId: undefined, config: resources, rejectionReason: 'Job violates accounting/QOS policy' });
  const result = await queryManagedStatus(options, { remote: () => ({ body: '' }) });
  assert.equal(result.state, 'SUBMISSION_REJECTED');
  assert.equal(result.found, false);
  assert.deepEqual(result.requestedConfig, resources);
  assert.match(result.note, /accounting\/QOS/);
});
