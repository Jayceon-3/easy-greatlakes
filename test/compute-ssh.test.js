import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareComputeSsh } from '../src/compute-ssh.js';
import { main } from '../src/cli.js';

const options = { node: 'gl1502', timeout: 120 };
const config = 'hostname gl1502\ncontrolmaster auto\ncontrolpath /home/jason/.ssh/cm-token\ncontrolpersist 1800\n';

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
