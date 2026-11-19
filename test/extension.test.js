import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createOpenProject, validateProjectPath } = require('../vscode-extension/open-project.cjs');

function fixture({ path = '/home/dingxuan/nano-vllm', input, installed = true, openError, updateError } = {}) {
  const calls = { opens: [], updates: [], errors: [], logs: [], prompts: 0 };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    extensions: { getExtension: id => { assert.equal(id, 'ms-vscode-remote.remote-ssh'); return installed ? {} : undefined; } },
    workspace: { getConfiguration: section => {
      assert.equal(section, 'greatLakes');
      return {
        get: (key) => { assert.equal(key, 'projectPath'); return path; },
        update: async (...args) => { if (updateError) throw updateError; calls.updates.push(args); },
      };
    } },
    window: {
      showInputBox: async options => { calls.prompts++; assert.equal(typeof options.validateInput, 'function'); return input; },
      showErrorMessage: async message => calls.errors.push(message),
    },
    Uri: { from: parts => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }) },
    commands: { executeCommand: async (...args) => { if (openError) throw openError; calls.opens.push(args); } },
  };
  return { calls, run: createOpenProject(vscode, { appendLine: line => calls.logs.push(line) }) };
}

test('extension manifest contributes local UI commands and declares Remote SSH dependency', () => {
  const manifest = JSON.parse(readFileSync('vscode-extension/package.json', 'utf8'));
  assert.deepEqual(manifest.extensionKind, ['ui']);
  assert.deepEqual(manifest.extensionDependencies, ['ms-vscode-remote.remote-ssh']);
  assert.equal(manifest.contributes.commands.length, 3);
  assert.equal(manifest.contributes.commands[0].command, 'greatLakes.openProject');
  assert.equal(manifest.contributes.configuration.properties['greatLakes.projectPath'].default, '');
  assert.equal(typeof require('../vscode-extension/extension.cjs').activate, 'function');
});

test('configured path opens gl-compute in a new window without modifying settings', async () => {
  const { run, calls } = fixture();
  await run();
  assert.equal(calls.opens.length, 1);
  const [command, uri, options] = calls.opens[0];
  assert.equal(command, 'vscode.openFolder');
  assert.equal(uri.scheme, 'vscode-remote');
  assert.equal(uri.authority, 'ssh-remote+gl-compute');
  assert.equal(uri.path, '/home/dingxuan/nano-vllm');
  assert.deepEqual(options, { forceNewWindow: true });
  assert.equal(calls.prompts, 0);
  assert.deepEqual(calls.updates, []);
});

test('first run prompts and persists the path at User scope', async () => {
  const { run, calls } = fixture({ path: '', input: '/home/dingxuan' });
  await run();
  assert.deepEqual(calls.updates, [['projectPath', '/home/dingxuan', 1]]);
  assert.equal(calls.opens[0][1].path, '/home/dingxuan');
});

test('cancelling the first-run prompt does not save or open anything', async () => {
  const { run, calls } = fixture({ path: '', input: undefined });
  await run();
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.opens, []);
  assert.deepEqual(calls.errors, []);
});

test('relative, Windows and control-character paths are rejected', async () => {
  for (const path of ['~/project', 'relative', 'C:\\project', '/tmp/hello\nworld', '//server/share', '/tmp/a\\b', 123]) {
    assert.equal(typeof validateProjectPath(path), 'string');
    const { run, calls } = fixture({ path });
    await run();
    assert.deepEqual(calls.opens, []);
    assert.equal(calls.errors.length, 1);
  }
});

test('spaces and URI-sensitive characters stay in the path field', async () => {
  const path = '/home/dingxuan/a folder/#draft?100%';
  const { run, calls } = fixture({ path });
  await run();
  assert.equal(calls.opens[0][1].path, path);
  assert.equal(validateProjectPath(path), undefined);
});

test('missing Remote SSH produces an actionable error', async () => {
  const { run, calls } = fixture({ installed: false });
  await run();
  assert.equal(calls.opens.length, 0);
  assert.match(calls.errors[0], /Install and enable Remote - SSH/);
});

test('failed window requests are logged and reported', async () => {
  const { run, calls } = fixture({ openError: new Error('Window unavailable') });
  await run();
  assert.match(calls.errors[0], /Window unavailable/);
  assert.match(calls.logs.at(-1), /Open failed/);
});

test('failed settings persistence does not open a window', async () => {
  const { run, calls } = fixture({ path: '', input: '/home/dingxuan', updateError: new Error('Settings read-only') });
  await run();
  assert.deepEqual(calls.opens, []);
  assert.match(calls.errors[0], /Settings read-only/);
});
