import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.js';
import { connect, readConnectConfig, resolveConnectConfig } from '../src/connect.js';

function fixture(t, supplied = { account: 'example_class', gpus: 2 }) {
  const directory = mkdtempSync(join(tmpdir(), 'gl-resources-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(supplied));
  return { directory, path };
}

const failOperations = {
  runConnect: () => assert.fail('must not connect'),
  updateSsh: () => assert.fail('must not update SSH'),
  prepareSsh: () => assert.fail('must not authenticate'),
  runStop: () => assert.fail('must not cancel'),
  query: () => assert.fail('must not query'),
  managedQuery: () => assert.fail('must not query'),
};

test('defaults, file and overrides merge in order without mutating either input', t => {
  const { path } = fixture(t);
  const before = readFileSync(path, 'utf8');
  const overrides = { cpus: 8, gpus: 3 };
  assert.deepEqual(readConnectConfig(path, overrides), {
    account: 'example_class', partition: 'spgpu', gpus: 3, cpus: 8, memory: '24G', time: '03:00:00',
  });
  assert.equal(readConnectConfig(path).gpus, 2);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(overrides, { cpus: 8, gpus: 3 });
});

test('CLI applies all six resource overrides only to this connection', async t => {
  const { path } = fixture(t);
  const expected = { account: 'other_class', partition: 'other_gpu', gpus: 3, cpus: 12, memory: '64G', time: '06:30:00' };
  const overrides = Object.entries(expected).flatMap(([key, value]) => [`--${key}`, String(value)]);
  let calls = 0;
  for (const flags of [overrides, []]) {
    const code = await main(['connect', '--config', path, ...flags, '--json', '--no-wait'], {
      ...failOperations,
      runConnect: async options => {
        calls++;
        assert.deepEqual(options.config, flags.length ? expected : readConnectConfig(path));
        return { ready: false, state: 'PENDING', jobId: '12345' };
      },
      out: () => {}, err: text => assert.match(text, /Requested resources:/),
    });
    assert.equal(code, 0);
  }
  assert.equal(calls, 2);
});

test('config preview prints effective configuration without creating job state or executing operations', async t => {
  const { directory, path } = fixture(t);
  const before = readFileSync(path, 'utf8');
  const output = [];
  assert.equal(await main(['connect', '--config', path, '--gpus', '4', '--dry-run', '--json', '--state-dir', join(directory, 'state'), '--prepare-ssh'], {
    ...failOperations, out: text => output.push(text), err: text => assert.fail(text),
  }), 0);
  assert.deepEqual(JSON.parse(output[0]), { ...readConnectConfig(path), gpus: 4 });
  assert.deepEqual(readdirSync(directory), ['config.json']);
  assert.equal(readFileSync(path, 'utf8'), before);
  const text = [];
  assert.equal(await main(['connect', '--config', path, '--dry-run'], {
    ...failOperations, out: line => text.push(line), err: line => assert.fail(line),
  }), 0);
  assert.match(text[0], /CPU memory: 24G/);
  assert.match(text[0], /Time limit: 03:00:00/);
});

test('invalid resource values fail before any operation, including preview', async t => {
  const { path } = fixture(t);
  for (const flags of [
    ['--gpus', '0'], ['--gpus', '1.5'], ['--gpus', '1e2'], ['--cpus', '-1'],
    ['--cpus', '9007199254740992'], ['--cpus', ''], ['--memory', '0G'], ['--memory', '24GB'],
    ['--time', '00:00:00'], ['--time', '03:60:00'], ['--time', '3h'],
    ['--account', ''], ['--account', 'foo;bar'], ['--partition', '-invalid'],
    ['--gpus'],
  ]) {
    const output = [], errors = [];
    const code = await main(['connect', '--config', path, '--dry-run', ...flags], {
      ...failOperations, out: text => output.push(text), err: text => errors.push(text),
    });
    assert.equal(code, 2, JSON.stringify(flags));
    assert.deepEqual(output, []);
    assert.equal(errors.length, 1);
  }
});

test('new flags are rejected for status and stop rather than silently ignored', async () => {
  for (const command of ['stop', 'status']) {
    for (const flags of [['--dry-run'], ['--gpus', '2'], ['--account', 'example']]) {
      assert.equal(await main([command, ...flags], { ...failOperations, err: () => {} }), 2);
    }
  }
});

test('normal connect displays resources before execution and keeps JSON stdout clean', async t => {
  const { path } = fixture(t);
  for (const json of [false, true]) {
    const output = [], diagnostics = [];
    const code = await main(['connect', '--config', path, '--gpus', '3', ...(json ? ['--json'] : [])], {
      ...failOperations,
      runConnect: async () => {
        assert.match(diagnostics[0], /Requested resources:/);
        assert.match(diagnostics[0], /GPUs: 3/);
        assert.equal(output.length, 0);
        return { jobId: '12345', state: 'PENDING', ready: false };
      },
      out: text => output.push(text), err: text => diagnostics.push(text),
    });
    assert.equal(code, 0);
    if (json) {
      assert.equal(output.length, 1);
      assert.equal(JSON.parse(output[0]).jobId, '12345');
    }
  }
});

test('removed print-config flag is rejected without connecting', async () => {
  const errors = [];
  assert.equal(await main(['connect', '--print-config'], {
    ...failOperations, err: text => errors.push(text),
  }), 2);
  assert.match(errors[0], /print-config/);
});

test('only the merged config is validated, with required account and valid object shape', t => {
  assert.equal(resolveConnectConfig({ account: 'example', gpus: 0 }, { gpus: 2 }).gpus, 2);
  for (const supplied of [null, [], 'example', {}, { account: 123 }, { account: 'example', gpus: '2' }, { account: 'example', memory: ['24G'] }, { account: 'example', time: ['03:00:00'] }]) {
    assert.throws(() => resolveConnectConfig(supplied));
  }
  const { path } = fixture(t, { account: 'example', cpus: 0 });
  assert.equal(readConnectConfig(path, { cpus: 4 }).cpus, 4);
  writeFileSync(path, '{bad JSON');
  assert.throws(() => readConnectConfig(path));
  assert.throws(() => readConnectConfig(path + '.missing'), { code: 'ENOENT' });
});

test('custom resources reach submission and persistence; mismatched requests never replace a live job', async t => {
  const { directory, path } = fixture(t);
  const config = readConnectConfig(path, { gpus: 3, cpus: 12, memory: '64G', time: '06:30:00' });
  const options = { config, stateDir: directory, host: 'gl-login', timeout: 120, noWait: true };
  const state = () => JSON.parse(readFileSync(join(directory, readdirSync(directory).find(file => file.endsWith('.json') && file !== 'config.json')), 'utf8'));
  let submits = 0;
  const remote = (_options, command) => {
    if (command === 'true') return { body: '' };
    assert.ok(!command.includes('scancel'));
    if (command.includes('sbatch')) {
      submits++;
      for (const arg of ['--gres=gpu:3', '--cpus-per-task=12', '--mem=64G', '--time=06:30:00', '--account=example_class', '--partition=spgpu']) assert.ok(command.includes(arg));
      return { body: '12345' };
    }
    return { body: `12345|RUNNING|gl1504|${state().name}|None` };
  };
  await connect(options, { remote });
  assert.deepEqual(state().config, config);
  await connect(options, { remote });
  await assert.rejects(connect({ ...options, config: readConnectConfig(path) }, { remote }), /different resources/);
  assert.equal(submits, 1);
});
