import test from 'node:test';
import assert from 'node:assert/strict';
import { queryStatus, parseQueue } from '../src/status.js';
import { main } from '../src/cli.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const options = { jobId: '66262642', host: 'gl-login', timeout: 120 };
const running = '66262642|RUNNING|gl1504|12:34|3:00:00|2:47:26|None';

function successfulRemote(rows, observe = () => {}) {
  return (file, args, spawnOptions) => {
    observe(file, args, spawnOptions);
    const marker = args.at(-1).match(/GLDEV_[a-f0-9]+/)[0];
    return { status: 0, stdout: `Login banner\r\n${marker}_BEGIN\r\n${rows}\r\n${marker}_END\r\nGoodbye\r\n` };
  };
}

test('running job is selected by exact ID; banners and CRLF are ignored', () => {
  const result = queryStatus(options, successfulRemote(`166262642|RUNNING|gl9999|0:01|2:00:00|1:59:59|None\n${running}`));
  assert.equal(result.state, 'RUNNING');
  assert.equal(result.node, 'gl1504');
  assert.equal(result.timeLimit, '3:00:00');
  assert.equal(result.found, true);
});

test('pending job has no allocated node and preserves pending reason', () => {
  const result = queryStatus(options, successfulRemote('66262642|PENDING||0:00|3:00:00|3:00:00|Resources'));
  assert.equal(result.node, null);
  assert.equal(result.state, 'PENDING');
  assert.equal(result.reason, 'Resources');
});

test('empty queue or another job does not invent an end reason', () => {
  for (const rows of ['', '123|RUNNING|gl1000|0:01|2:00:00|1:59:59|None']) {
    const result = queryStatus(options, successfulRemote(rows));
    assert.equal(result.state, 'NOT_IN_QUEUE');
    assert.equal(result.found, false);
    assert.match(result.note, /sacct/);
  }
});

test('SSH and remote command failures cannot be mistaken for an empty queue', () => {
  for (const [status, code] of [[255, 'SSH_FAILED'], [1, 'QUERY_FAILED'], [127, 'QUERY_FAILED']]) {
    assert.throws(() => queryStatus(options, () => ({ status, stdout: '' })), { code });
  }
});

test('timeout, missing executable, buffer errors and signals are query failures', () => {
  for (const [result, code] of [
    [{ error: { code: 'ETIMEDOUT' } }, 'TIMEOUT'],
    [{ error: { code: 'ENOENT' } }, 'SSH_NOT_FOUND'],
    [{ error: { code: 'ENOBUFS', message: 'buffer full' } }, 'EXECUTION_FAILED'],
    [{ status: null, signal: 'SIGINT' }, 'INTERRUPTED'],
  ]) {
    assert.throws(() => queryStatus(options, () => result), { code });
  }
});

test('missing markers, malformed rows and duplicate IDs fail closed', () => {
  for (const output of [
    '', 'Welcome!', 'm_BEGIN\n',
    'm_BEGIN\nUnexpected output\nm_END',
    `m_BEGIN\n${running}\n${running}\nm_END`,
  ]) {
    assert.throws(() => parseQueue(output, options.jobId, 'm'), { code: 'INVALID_OUTPUT' });
  }
});

test('invalid IDs, hosts and timeout are rejected before SSH execution', () => {
  for (const override of [
    { jobId: '1; touch /tmp/unsafe' }, { jobId: '0' }, { jobId: '123_1' },
    { host: '-oProxyCommand=anything' }, { host: 'host;id' },
    { timeout: 0 }, { timeout: Infinity }, { timeout: 1.5 },
  ]) {
    let called = false;
    assert.throws(() => queryStatus({ ...options, ...override }, () => { called = true; }));
    assert.equal(called, false);
  }
});

test('SSH inherits authentication streams and passes config as a separate argument', () => {
  queryStatus({ ...options, sshConfig: '/tmp/path with spaces/config' }, successfulRemote(running, (file, args, settings) => {
    assert.equal(file, 'ssh');
    assert.equal(args[args.indexOf('-F') + 1], '/tmp/path with spaces/config');
    assert.equal(args.at(-2), 'gl-login');
    assert.match(args.at(-1), /--user="\$USER"/);
    assert.match(args.at(-1), /exit "\$gl_query_status"/);
    assert.doesNotMatch(args.at(-1), /sbatch|scancel|66262642/);
    assert.deepEqual(settings.stdio, ['inherit', 'pipe', 'inherit']);
    assert.equal(settings.timeout, 120000);
  }));
});

function invoke(argv, query) {
  const stdout = [], stderr = [];
  const code = main(argv, { query, out: line => stdout.push(line), err: line => stderr.push(line) });
  return { code, stdout, stderr };
}

test('CLI emits JSON suitable for later extension integration', () => {
  const result = invoke(['status', '66262642', '--json'], opts => queryStatus(opts, successfulRemote(running)));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout[0]).node, 'gl1504');
  assert.deepEqual(result.stderr, []);
});

test('CLI has distinct exits for usage and query failures; JSON errors go to stderr', () => {
  for (const argv of [['connect', 'extra'], ['status'], ['status', 'x'], ['status', '1', '--unknown']]) {
    const result = invoke(argv, () => { throw new Error('must not query'); });
    assert.equal(result.code, 2);
    assert.deepEqual(result.stdout, []);
  }
  const result = invoke(['status', '66262642', '--json'], opts => queryStatus(opts, () => ({ status: 255 })));
  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, []);
  assert.equal(JSON.parse(result.stderr[0]).error.code, 'SSH_FAILED');
});

test('help does not connect to SSH', () => {
  const result = invoke(['--help'], () => { throw new Error('must not query'); });
  assert.equal(result.code, 0);
  assert.match(result.stdout[0], /gl-dev status/);
});

test('generated remote shell command preserves squeue output and nonzero exit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gl-dev-test-'));
  try {
    writeFileSync(join(directory, 'squeue'), '#!/bin/sh\nprintf "%s\\n" "$GL_TEST_ROW"\nexit "$GL_TEST_EXIT"\n', { mode: 0o700 });
    for (const remoteExit of ['0', '1', '127']) {
      const execute = (_file, args) => spawnSync('/bin/sh', ['-c', args.at(-1)], {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'inherit'],
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GL_TEST_ROW: running, GL_TEST_EXIT: remoteExit },
      });
      if (remoteExit === '0') assert.equal(queryStatus(options, execute).state, 'RUNNING');
      else assert.throws(() => queryStatus(options, execute), { code: 'QUERY_FAILED' });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
