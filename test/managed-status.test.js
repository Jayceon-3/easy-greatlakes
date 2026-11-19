import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStateLock, saveState } from '../src/state.js';
import { queryManagedStatus } from '../src/managed-status.js';
import { main } from '../src/cli.js';

const name = `gldev-${'a'.repeat(24)}`;
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
