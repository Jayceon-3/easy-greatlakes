import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replaceComputeHostname, updateComputeHost, validateSshConfig } from '../src/ssh-config.js';
import { main } from '../src/cli.js';

const original = `# Personal SSH settings
Host github.com
    HostName github.com
    User git
Host gl-login
    HostName greatlakes.arc-ts.umich.edu
    User dingxuan
Host gl-compute
    HostName gl1515 # Current allocation
    User dingxuan
    ProxyJump gl-login
    IdentityFile ~/.ssh/id_ed25519
Host gl-login gl-compute
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 30m
`;
function fixture(t, text = original) {
  const dir = mkdtempSync(join(tmpdir(), 'gl-ssh-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config');
  writeFileSync(path, text, { mode: 0o600 });
  return { dir, path };
}

test('changes only the dedicated hostname, preserving comments, other hosts and shared settings', () => {
  const result = replaceComputeHostname(original, 'gl1504');
  assert.equal(result, original.replace('HostName gl1515 # Current allocation', 'HostName gl1504 # Current allocation'));
});

test('preserves CRLF, equals syntax and missing final newline', () => {
  const text = 'Host gl-compute\r\n\tHOSTNAME = "gl1515"  # comment\r\n\tUser dingxuan';
  assert.equal(replaceComputeHostname(text, 'gl1504'), text.replace('"gl1515"', 'gl1504'));
});

test('inserts a missing hostname into the dedicated block', () => {
  assert.equal(replaceComputeHostname('Host gl-compute\n    User dingxuan\nHost other\n', 'gl1504'),
    'Host gl-compute\n    HostName gl1504\n    User dingxuan\nHost other\n');
  assert.equal(replaceComputeHostname('Host gl-compute', 'gl1504'), 'Host gl-compute\n    HostName gl1504\n');
});

test('Match boundaries protect conditional directives', () => {
  const text = 'Host "gl-compute"\n    HostName gl1515\nMatch host example\n    HostName another-host\n';
  assert.equal(replaceComputeHostname(text, 'gl1504'), text.replace('HostName gl1515', 'HostName gl1504'));
});

test('ambiguous or missing blocks and unsafe nodes fail without guessing', () => {
  for (const text of [
    'Include ~/.ssh/hosts\n', 'Host gl-login gl-compute\n    HostName gl1515\n',
    'Host gl-compute\nHost gl-compute\n',
    'Host gl-compute\n    HostName gl1515\n    HostName gl1516\n',
  ]) assert.throws(() => replaceComputeHostname(text, 'gl1504'));
  for (const node of ['gl1504\nUser attacker', 'gl[1504-1505]', 'example.com', '-oProxyCommand=x']) {
    assert.throws(() => replaceComputeHostname(original, node));
  }
});

test('real ssh -G validates a candidate, backup restores original bytes, update is idempotent', t => {
  const { dir, path } = fixture(t);
  const result = updateComputeHost({ sshConfig: path, node: 'gl1504' });
  assert.equal(result.changed, true);
  assert.equal(readFileSync(result.backupPath, 'utf8'), original);
  assert.equal(readFileSync(path, 'utf8'), original.replace('HostName gl1515', 'HostName gl1504'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(result.backupPath).mode & 0o777, 0o600);
  const second = updateComputeHost({ sshConfig: path, node: 'gl1504' });
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, null);
  assert.equal(readdirSync(dir).length, 2);
  writeFileSync(path, readFileSync(result.backupPath));
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('earlier wildcard overriding hostname is detected by real SSH and original stays intact', t => {
  const { dir, path } = fixture(t, 'Host *\n    HostName wrong-host\n' + original);
  const before = readFileSync(path, 'utf8');
  assert.throws(() => updateComputeHost({ sshConfig: path, node: 'gl1504' }), /overrides/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(readdirSync(dir), ['config']);
});

test('SSH validation errors preserve the original and clean up temporary files', t => {
  const { dir, path } = fixture(t);
  assert.throws(() => updateComputeHost({ sshConfig: path, node: 'gl1504' }, {
    validate: () => { throw new Error('Invalid config'); },
  }), /Invalid config/);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.deepEqual(readdirSync(dir), ['config']);
  assert.throws(() => validateSshConfig(path, 'gl1504', () => ({ status: 255 })), /could not validate/);
});

test('concurrent edits detected before replacement are preserved', t => {
  const { dir, path } = fixture(t);
  assert.throws(() => updateComputeHost({ sshConfig: path, node: 'gl1504' }, {
    validate: () => writeFileSync(path, original + '# Edited concurrently\n'),
  }), /changed during validation/);
  assert.equal(readFileSync(path, 'utf8'), original + '# Edited concurrently\n');
  assert.deepEqual(readdirSync(dir), ['config']);
});

test('symlink configuration path updates the real target without replacing the symlink', t => {
  const { dir, path } = fixture(t);
  const link = join(dir, 'config-link');
  symlinkSync(path, link);
  const result = updateComputeHost({ sshConfig: link, node: 'gl1504' });
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(result.path, path);
  assert.match(readFileSync(link, 'utf8'), /HostName gl1504/);
});

test('parallel writers are locked without changing the original', t => {
  const { path } = fixture(t);
  updateComputeHost({ sshConfig: path, node: 'gl1504' }, {
    validate: () => assert.throws(() => updateComputeHost({ sshConfig: path, node: 'gl1505' }), { code: 'EEXIST' }),
  });
  assert.match(readFileSync(path, 'utf8'), /HostName gl1504/);
});

test('ready CLI connect updates an explicit config and reports backup in JSON', async t => {
  const { path } = fixture(t);
  const stdout = [];
  const code = await main(['connect', '--ssh-config', path, '--json'], {
    out: value => stdout.push(value), err: () => {},
    runConnect: async () => ({ ready: true, jobId: '12345', state: 'RUNNING', node: 'gl1504' }),
  });
  assert.equal(code, 0);
  const result = JSON.parse(stdout[0]);
  assert.equal(result.sshConfigUpdate.changed, true);
  assert.equal(result.sshConfigUpdate.path, path);
});

test('pending and skipped updates never touch SSH config', async () => {
  for (const [ready, flags] of [[false, []], [true, ['--skip-ssh-update']]]) {
    const code = await main(['connect', ...flags], {
      out: () => {}, err: () => {},
      runConnect: async () => ({ ready, jobId: '12345', node: ready ? 'gl1504' : null }),
      updateSsh: () => assert.fail('must not update'),
    });
    assert.equal(code, 0);
  }
});

test('config update failure reports retained allocation and recovery', async () => {
  const stderr = [];
  const code = await main(['connect', '--json'], {
    out: () => assert.fail('must not report success'), err: value => stderr.push(value),
    runConnect: async () => ({ ready: true, jobId: '12345', node: 'gl1504' }),
    updateSsh: () => { throw new Error('Permission denied'); },
  });
  assert.equal(code, 1);
  const result = JSON.parse(stderr.at(-1));
  assert.equal(result.error.code, 'SSH_CONFIG_UPDATE_FAILED');
  assert.match(result.error.message, /12345 remains allocated on gl1504/);
});
