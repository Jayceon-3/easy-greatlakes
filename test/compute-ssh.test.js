import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareComputeSsh } from '../src/compute-ssh.js';
import { main } from '../src/cli.js';

const options = { node: 'gl1502', timeout: 120 };
const config = 'hostname gl1502\ncontrolmaster auto\ncontrolpath /home/jason/.ssh/cm-token\ncontrolpersist 1800\n';

function socketFixture({ probe, replacement, socket = true, uid = process.getuid() } = {}) {
  const path = '/home/jason/.ssh/cm-token';
  const calls = [], removed = [], logs = [];
  let stats = 0;
  const stat = { dev: 1, ino: 10, uid, isSocket: () => socket };
  const run = () => prepareComputeSsh(options, {
    files: {
      lstatSync: checked => { assert.equal(checked, path); return stats++ === 0 ? stat : { ...stat, ...replacement }; },
      unlinkSync: checked => removed.push(checked),
    },
    execute: (_file, args, settings) => {
      calls.push(args);
      assert.ok(!args.includes('exit'));
      if (args.includes('-G')) return { status: 0, stdout: config };
      if (args.includes('-S')) {
        assert.equal(args[args.indexOf('-S') + 1], path);
        assert.equal(settings.env.LC_ALL, 'C');
        return probe;
      }
      if (args.includes('-MNf') && probe.status === 255) assert.deepEqual(removed, [path]);
      return { status: 0 };
    },
    remote: () => ({ body: 'gl1502.arc-ts.umich.edu' }),
    progress: line => logs.push(line),
  });
  return { run, calls, removed, logs, path };
}

test('refused stale socket is removed before authenticating a replacement connection', () => {
  const fixture = socketFixture({ probe: { status: 255, stderr: 'Control socket connect(/home/jason/.ssh/cm-token): Connection refused\n' } });
  assert.equal(fixture.run().ready, true);
  assert.deepEqual(fixture.removed, [fixture.path]);
  assert.match(fixture.logs[0], /Removed stale SSH control socket/);
});

test('live SSH socket is preserved', () => {
  const fixture = socketFixture({ probe: { status: 0, stderr: 'Master running (pid=123)' } });
  assert.equal(fixture.run().ready, true);
  assert.deepEqual(fixture.removed, []);
});

test('ambiguous probe failures never remove a socket or start authentication', () => {
  for (const probe of [
    { status: 255, stderr: 'Permission denied' },
    { status: null, error: { code: 'ETIMEDOUT' } },
    { status: null, signal: 'SIGTERM' },
    { status: 1, stderr: 'Connection refused' },
  ]) {
    const fixture = socketFixture({ probe });
    assert.throws(fixture.run, { code: 'SSH_MULTIPLEX_FAILED' });
    assert.deepEqual(fixture.removed, []);
    assert.ok(!fixture.calls.some(args => args.includes('-MNf')));
  }
});

test('non-sockets, foreign sockets and replaced sockets are preserved', () => {
  for (const settings of [{ socket: false }, { uid: process.getuid() + 1 }, { replacement: { ino: 11 } }]) {
    const fixture = socketFixture({ ...settings, probe: { status: 255, stderr: 'Control socket connect(/home/jason/.ssh/cm-token): Connection refused' } });
    assert.throws(fixture.run, { code: 'SSH_MULTIPLEX_FAILED' });
    assert.deepEqual(fixture.removed, []);
    assert.ok(!fixture.calls.some(args => args.includes('-MNf')));
  }
});

test('authentication uses the real terminal and preserves host-key confirmation', () => {
  const calls = [];
  const result = prepareComputeSsh(options, {
    execute: (file, args, settings) => {
      assert.equal(file, 'ssh');
      calls.push(args);
      if (args.includes('-G')) return { status: 0, stdout: config };
      assert.equal(settings.stdio, 'inherit');
      if (args.includes('-O')) assert.equal(args[args.indexOf('-O') + 1], 'check');
      else {
        assert.ok(args.includes('-MNf'));
        assert.ok(args.includes('StrictHostKeyChecking=ask'));
      }
      assert.ok(!args.includes('exit'));
      return { status: 0 };
    },
    remote: (settings, command) => {
      assert.equal(settings.host, 'gl-compute');
      assert.equal(command, 'hostname');
      return { body: 'gl1502' };
    },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(result, { ready: true, host: 'gl-compute', node: 'gl1502' });
});

test('mismatched node and disabled connection reuse fail before authentication', () => {
  for (const text of [config.replace('gl1502', 'gl9999'), config.replace('controlmaster auto', 'controlmaster false'), config.replace('controlpersist 1800', 'controlpersist 0')]) {
    let calls = 0;
    assert.throws(() => prepareComputeSsh(options, {
      execute: (_file, args) => { calls++; assert.ok(args.includes('-G')); return { status: 0, stdout: text }; },
    }));
    assert.equal(calls, 1);
  }
});

test('authentication failure or timeout does not continue to hostname verification', () => {
  for (const failure of [{ status: 255 }, { status: null, error: { code: 'ETIMEDOUT' } }]) {
    assert.throws(() => prepareComputeSsh(options, {
      execute: (_file, args) => args.includes('-G') ? { status: 0, stdout: config } : failure,
      remote: () => assert.fail('must not verify after failed authentication'),
    }), { code: 'SSH_PREPARE_FAILED' });
  }
});

test('connection to an unexpected node is rejected and existing connections are not killed', () => {
  assert.throws(() => prepareComputeSsh(options, {
    execute: (_file, args) => { assert.ok(!args.includes('exit')); return { status: 0, stdout: config }; },
    remote: () => ({ body: 'gl9999' }),
  }), { code: 'SSH_NODE_MISMATCH' });
});

test('full Great Lakes hostname is accepted for the allocated node', () => {
  const result = prepareComputeSsh(options, {
    execute: () => ({ status: 0, stdout: config }),
    remote: () => ({ body: 'gl1502.arc-ts.umich.edu' }),
  });
  assert.deepEqual(result, { ready: true, host: 'gl-compute', node: 'gl1502' });
});

test('other nodes, domains and malformed hostname output remain rejected', () => {
  for (const hostname of ['gl9999.arc-ts.umich.edu', 'gl1502.example.com', 'gl1502.arc-ts.umich.edu.example.com', '', 'gl1502\ngl1502.arc-ts.umich.edu']) {
    assert.throws(() => prepareComputeSsh(options, {
      execute: () => ({ status: 0, stdout: config }),
      remote: () => ({ body: hostname }),
    }), error => {
      assert.equal(error.code, 'SSH_NODE_MISMATCH');
      assert.ok(error.message.includes(JSON.stringify(hostname)));
      return true;
    });
  }
});

test('alternate SSH configuration is passed to both inspection and authentication', () => {
  prepareComputeSsh({ ...options, sshConfig: '/tmp/config with spaces' }, {
    execute: (_file, args) => {
      assert.equal(args[args.indexOf('-F') + 1], '/tmp/config with spaces');
      return { status: 0, stdout: config };
    },
    remote: settings => { assert.equal(settings.sshConfig, '/tmp/config with spaces'); return { body: 'gl1502' }; },
  });
});

test('CLI prepares compute SSH only after ready allocation and successful SSH update', async () => {
  const order = [], stdout = [];
  const code = await main(['connect', '--json', '--prepare-ssh'], {
    out: line => stdout.push(line), err: () => {},
    runConnect: async () => { order.push('connect'); return { jobId: '12345', ready: true, node: 'gl1502' }; },
    updateSsh: () => { order.push('update'); return { node: 'gl1502', path: '/tmp/config' }; },
    prepareSsh: args => { assert.equal(args.node, 'gl1502'); order.push('authenticate'); return { ready: true, node: args.node }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(order, ['connect', 'update', 'authenticate']);
  assert.equal(JSON.parse(stdout[0]).computeSsh.ready, true);
});

test('CLI reports retained allocation on authentication failure and disallows skipping SSH update', async () => {
  const stderr = [];
  const code = await main(['connect', '--json', '--prepare-ssh'], {
    out: () => assert.fail('must not emit success'), err: line => stderr.push(line),
    runConnect: async () => ({ jobId: '12345', ready: true, node: 'gl1502' }),
    updateSsh: () => ({ node: 'gl1502', path: '/tmp/config' }),
    prepareSsh: () => { throw new Error('authentication failed'); },
  });
  assert.equal(code, 1);
  assert.match(stderr.at(-1), /12345 remains allocated on gl1502/);
  assert.equal(main(['connect', '--prepare-ssh', '--skip-ssh-update'], { err: () => {} }), 2);
});
