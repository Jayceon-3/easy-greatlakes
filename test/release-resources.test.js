import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createReleaseResources } = require('../vscode-extension/release-resources.cjs');
const { buildRequest, runWslConnect } = require('../vscode-extension/wsl-connect.cjs');
const job = { host: 'gl-login', found: true, jobId: '12345', jobName: `gldev-${'a'.repeat(24)}`, state: 'RUNNING', node: 'gl1504' };

function fixture({ confirm = 'Release Resources', lookup = job, result = { jobId: '12345', released: true, state: 'NOT_IN_QUEUE' }, failure } = {}) {
  const calls = { actions: [], warnings: [], info: [], errors: [], logs: [] };
  let distribution = 'Ubuntu-22.04';
  const vscode = {
    workspace: { getConfiguration: () => ({ get: key => key === 'wslDistribution' ? distribution : undefined }) },
    window: {
      showWarningMessage: async (...args) => { calls.warnings.push(args); distribution = 'Changed-During-Confirmation'; return confirm; },
      showInformationMessage: async text => calls.info.push(text),
      showErrorMessage: async text => calls.errors.push(text),
    },
  };
  const run = createReleaseResources(vscode, { appendLine: text => calls.logs.push(text) }, {
    bridge: async (_v, settings, _o, request) => {
      assert.equal(settings.get('wslDistribution'), 'Ubuntu-22.04');
      calls.actions.push(request);
      if (failure) throw new Error(failure);
      return request.action === 'status' ? lookup : result;
    },
  });
  return { calls, run };
}

test('release confirms exact target then stops only that ID with frozen WSL settings', async () => {
  const { calls, run } = fixture();
  await run();
  assert.deepEqual(calls.actions, [{ action: 'status' }, { action: 'stop', expectedJobId: '12345' }]);
  assert.match(calls.warnings[0][0], /12345/);
  assert.equal(calls.warnings[0][1].modal, true);
  assert.match(calls.warnings[0][1].detail, /gl1504/);
  assert.match(calls.warnings[0][1].detail, /terminates processes/);
  assert.match(calls.info[0], /Resources are released/);
  assert.deepEqual(calls.errors, []);
});

test('dismissing confirmation never invokes stop', async () => {
  const cancelled = fixture({ confirm: null });
  await cancelled.run();
  assert.deepEqual(cancelled.calls.actions, [{ action: 'status' }]);
  assert.deepEqual(cancelled.calls.info, []);
});

test('missing, ended or unresolved jobs do not prompt or cancel', async () => {
  for (const state of ['NO_MANAGED_JOB', 'NOT_IN_QUEUE', 'SUBMISSION_UNKNOWN']) {
    const { calls, run } = fixture({ lookup: { found: false, state } });
    await run();
    assert.equal(calls.warnings.length, 0);
    assert.deepEqual(calls.actions, [{ action: 'status' }]);
  }
});

test('query failures report an error without prompting or cancelling', async () => {
  const { calls, run } = fixture({ failure: 'SSH query failed' });
  await run();
  assert.equal(calls.warnings.length, 0);
  assert.equal(calls.actions.length, 1);
  assert.match(calls.errors[0], /SSH query failed/);
});

test('unconfirmed release and mismatched results are never reported as released', async () => {
  const pending = fixture({ result: { jobId: '12345', released: false, state: 'COMPLETING' } });
  await pending.run();
  assert.match(pending.calls.info[0], /not confirmed/);
  const mismatch = fixture({ result: { jobId: '99999', released: true } });
  await mismatch.run();
  assert.equal(mismatch.calls.info.length, 0);
  assert.match(mismatch.calls.errors[0], /did not match/);
});

test('repeated clicks cannot create multiple confirmation or cancellation flows', async () => {
  let resolve;
  let lookups = 0;
  const vscode = {
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    window: { showInformationMessage() {}, showWarningMessage: async () => undefined, showErrorMessage: text => assert.fail(text) },
  };
  const run = createReleaseResources(vscode, { appendLine() {} }, {
    bridge: () => { lookups++; return new Promise(done => { resolve = done; }); },
  });
  const first = run();
  await run();
  assert.equal(lookups, 1);
  resolve(job);
  await first;
});

test('stop launcher requires an explicit valid JobID and has no connect side effects', () => {
  const settings = { get: (_key, fallback) => fallback };
  for (const expectedJobId of [undefined, '', '1; rm anything', '-1']) {
    assert.throws(() => buildRequest(settings, undefined, { action: 'stop', expectedJobId }));
  }
  const request = buildRequest(settings, undefined, { action: 'stop', expectedJobId: '12345' });
  assert.match(request.script, /stop --json --job-id '12345'/);
  assert.match(request.script, /Great Lakes Release failed/);
  assert.doesNotMatch(request.script, /prepare-ssh|sbatch|ssh -O|connect --json/);
});

test('bridge validates status and stop results separately from connect results', async () => {
  for (const [action, result, valid] of [
    ['status', job, true],
    ['status', { host: 'gl-login', found: false, jobId: null, state: 'NO_MANAGED_JOB' }, true],
    ['status', { ...job, jobId: 'bad' }, false],
    ['stop', { host: 'gl-login', jobId: '12345', state: 'NOT_IN_QUEUE', released: true }, true],
    ['stop', { host: 'gl-login', jobId: '12345', state: 'COMPLETING', released: false, cancellationRequested: true }, true],
    ['stop', { host: 'gl-login', jobId: '99999', state: 'NOT_IN_QUEUE', released: true }, false],
    ['stop', { host: 'gl-login', jobId: '12345', state: 'RUNNING', released: true }, false],
    ['stop', { host: 'gl-login', jobId: '12345', state: 'NOT_IN_QUEUE', released: 'true' }, false],
  ]) {
    const vscode = { window: { createTerminal: () => ({ show() {} }), onDidCloseTerminal: () => ({ dispose() {} }) } };
    const task = runWslConnect(vscode, { get: (_key, fallback) => fallback }, { appendLine() {} }, {
      action, expectedJobId: '12345', platform: 'win32', prepare: async () => {},
      files: { readFile: async path => path.endsWith('\\exit') ? '0' : JSON.stringify(result), rm: async () => {} },
    });
    if (valid) assert.deepEqual(await task, result);
    else await assert.rejects(task, /Invalid CLI/);
  }
});
