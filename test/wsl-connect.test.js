import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { buildRequest, prepareRequest, runWslConnect: realRunWslConnect, createConnectProject } = require('../vscode-extension/wsl-connect.cjs');
const runWslConnect = (vscode, settings, output, options) => realRunWslConnect(vscode, settings, output, { prepare: async () => {}, ...options });
const settings = { get: (_key, fallback) => fallback };
const ready = { host: 'gl-login', jobId: '12345', state: 'RUNNING', ready: true, node: 'gl1504', sshConfigUpdate: { node: 'gl1504', changed: true }, computeSsh: { ready: true, node: 'gl1504' } };
function gui() {
  const calls = { opens: [], errors: [], info: [], terminals: [], logs: [] };
  const terminal = { show: () => {} };
  let close;
  const vscode = {
    extensions: { getExtension: () => ({}) },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'projectPath' ? '/home/dingxuan' : fallback }) },
    window: {
      createTerminal: options => { calls.terminals.push(options); return terminal; },
      onDidCloseTerminal: callback => { close = callback; return { dispose() {} }; },
      showErrorMessage: async text => calls.errors.push(text),
      showInformationMessage: async text => calls.info.push(text),
    },
    Uri: { from: parts => ({ ...parts, toString: () => parts.path }) },
    commands: { executeCommand: async (...args) => calls.opens.push(args) },
  };
  return { vscode, calls, terminal, close: () => close(terminal), output: { appendLine: text => calls.logs.push(text) } };
}

test('bridge uses the configured WSL identity and existing CLI without changing its scope', () => {
  const request = buildRequest(settings, 'abcd-1234');
  assert.equal(request.distribution, 'Ubuntu-22.04');
  assert.equal(request.user, 'jason');
  assert.equal(request.directory, '\\\\wsl.localhost\\Ubuntu-22.04\\tmp\\gl-dev-extension-abcd-1234');
  assert.match(request.script, /node bin\/gl-dev.js connect --json/);
  assert.match(request.script, /--prepare-ssh --reuse-managed/);
  assert.doesNotMatch(request.script, /--state-dir|--ssh-config|scancel|ssh -O/);
});

test('invalid settings are rejected before starting a terminal', () => {
  for (const update of [{ wslDistribution: '../bad' }, { wslUser: '-root' }, { wslRepositoryPath: 'relative' }]) {
    assert.throws(() => buildRequest({ get: (key, fallback) => update[key] ?? fallback }));
  }
});

test('generated shell command safely handles quotes and writes an atomic result', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gl-wsl-shell-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repository = join(dir, "repo 'quote; literal");
  mkdirSync(repository);
  mkdirSync(join(repository, 'bin'));
  writeFileSync(join(repository, 'bin/gl-dev.js'), 'process.stdout.write(JSON.stringify({ready:true}));');
  const request = buildRequest({ get: (key, fallback) => key === 'wslRepositoryPath' ? repository : fallback });
  const temp = request.directory.split('\\').at(-1);
  const resultPath = '/tmp/' + temp;
  t.after(() => rmSync(resultPath, { recursive: true, force: true }));
  const result = spawnSync('/bin/bash', ['-c', request.script], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(`${resultPath}/exit`, 'utf8'), '0');
  assert.deepEqual(JSON.parse(readFileSync(`${resultPath}/result.json`)), { ready: true });
});

test('terminal bridge uses a real interactive WSL shell and validates successful JSON', async () => {
  const g = gui();
  let removed = false;
  const result = await runWslConnect(g.vscode, settings, g.output, {
    platform: 'win32', files: {
      readFile: async path => path.endsWith('\\exit') ? '0' : JSON.stringify(ready),
      rm: async () => { removed = true; },
    },
  });
  assert.equal(result.node, 'gl1504');
  assert.equal(g.calls.terminals[0].shellPath, 'wsl.exe');
  assert.deepEqual(g.calls.terminals[0].shellArgs.slice(0, 7), ['--distribution', 'Ubuntu-22.04', '--user', 'jason', '--exec', 'bash', '-i']);
  assert.match(g.calls.terminals[0].shellArgs[7], /^\/tmp\/gl-dev-extension-[a-f0-9-]+\/run\.sh$/);
  assert.ok(!g.calls.terminals[0].shellArgs.some(arg => arg.includes('\n') || arg.includes('$')));
  assert.equal(removed, true);
});

test('failed CLI and missing SSH update cannot be mistaken for ready', async () => {
  for (const [exit, response] of [['1', ready], ['0', { ...ready, sshConfigUpdate: undefined }], ['0', { ...ready, computeSsh: undefined }], ['0', { ...ready, ready: 'true' }]]) {
    const g = gui();
    await assert.rejects(runWslConnect(g.vscode, settings, g.output, { platform: 'win32', files: {
      readFile: async path => path.endsWith('\\exit') ? exit : JSON.stringify(response), rm: async () => {},
    } }));
  }
});

test('closed terminal rejects without cancelling resources', async () => {
  const g = gui();
  const result = runWslConnect(g.vscode, settings, g.output, { platform: 'win32', files: {
    readFile: async () => { throw Object.assign(new Error('Not ready'), { code: 'ENOENT' }); },
  } });
  await new Promise(resolve => setImmediate(resolve));
  g.close();
  await assert.rejects(result, /exited without a complete result/);
});

test('non-Windows host is rejected without starting a terminal', async () => {
  const g = gui();
  await assert.rejects(runWslConnect(g.vscode, settings, g.output, { platform: 'linux' }), /Windows local extension host/);
  assert.equal(g.calls.terminals.length, 0);
});

test('Connect command opens only after a ready bridge result', async () => {
  for (const isReady of [true, false]) {
    const g = gui();
    await createConnectProject(g.vscode, g.output, { bridge: async () => ({ ...ready, ready: isReady }) })();
    assert.equal(g.calls.opens.length, isReady ? 1 : 0);
    if (isReady) assert.deepEqual(g.calls.opens[0][2], { forceNewWindow: true });
    else assert.equal(g.calls.info.length, 1);
  }
});

test('CLI or open-window failure is reported without automatic retry', async () => {
  const g = gui();
  let attempts = 0;
  await createConnectProject(g.vscode, g.output, { bridge: async () => { attempts++; throw new Error('SSH update failed'); } })();
  assert.equal(attempts, 1);
  assert.equal(g.calls.opens.length, 0);
  assert.match(g.calls.errors[0], /SSH update failed/);
});

test('repeated clicks share one active connection operation', async () => {
  const g = gui();
  let release;
  const run = createConnectProject(g.vscode, g.output, { bridge: () => new Promise(resolve => { release = resolve; }) });
  const first = run();
  await new Promise(resolve => setImmediate(resolve));
  await run();
  assert.match(g.calls.info[0], /already running/);
  release(ready);
  await first;
  assert.equal(g.calls.opens.length, 1);
});

test('cancelling project prompt prevents resource allocation', async () => {
  const g = gui();
  g.vscode.workspace.getConfiguration = () => ({ get: () => '' });
  g.vscode.window.showInputBox = async () => undefined;
  await createConnectProject(g.vscode, g.output, { bridge: () => assert.fail('must not allocate') })();
  assert.equal(g.calls.opens.length, 0);
});

test('SIGINT and nonzero CLI exits always write final exit status', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gl-wsl-interrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  for (const [source, expected] of [
    ['process.kill(process.ppid,"SIGINT"); process.exit(130);', '130'],
    ['process.exit(7);', '7'],
  ]) {
    writeFileSync(join(dir, 'bin/gl-dev.js'), source);
    const request = buildRequest({ get: (key, fallback) => key === 'wslRepositoryPath' ? dir : fallback });
    const resultPath = '/tmp/' + request.directory.split('\\').at(-1);
    t.after(() => rmSync(resultPath, { recursive: true, force: true }));
    const result = spawnSync('/bin/bash', ['-c', request.script], {
      encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], timeout: 5000,
    });
    assert.equal(result.status, Number(expected));
    assert.equal(readFileSync(`${resultPath}/exit`, 'utf8'), expected);
  }
});

test('interrupted bridge exits without waiting for a JSON result', async () => {
  const g = gui();
  await assert.rejects(runWslConnect(g.vscode, settings, g.output, {
    platform: 'win32', files: { readFile: async path => path.endsWith('\\exit') ? '130' : '' },
  }), /was interrupted/);
});

test('missing result has bounded monitoring and a stuck file read has bounded I/O', async () => {
  const g = gui();
  await assert.rejects(runWslConnect(g.vscode, settings, g.output, {
    platform: 'win32', maxWaitMs: 0, files: {},
  }), /monitoring timed out/);
  await assert.rejects(runWslConnect(g.vscode, settings, g.output, {
    platform: 'win32', ioTimeoutMs: 10, files: { readFile: () => new Promise(() => {}) },
  }), /file access timed out/);
});

test('cancelling monitoring settles even while file I/O is pending', async () => {
  const g = gui();
  const controller = new AbortController();
  const task = runWslConnect(g.vscode, settings, g.output, {
    platform: 'win32', signal: controller.signal, ioTimeoutMs: 10,
    files: { readFile: () => new Promise(() => {}) },
  });
  controller.abort();
  await assert.rejects(task, /monitoring cancelled/);
});

test('failed operation can retry without dismissing its error notification', async () => {
  const g = gui();
  let attempts = 0;
  g.vscode.window.showErrorMessage = text => { g.calls.errors.push(text); return new Promise(() => {}); };
  const run = createConnectProject(g.vscode, g.output, { bridge: async () => {
    if (attempts++ === 0) throw new Error('Interrupted');
    return ready;
  } });
  await run();
  await run();
  assert.equal(attempts, 2);
  assert.equal(g.calls.opens.length, 1);
});

test('Stop Waiting clears an aborted operation and allows a fresh attempt', async () => {
  const g = gui();
  let attempts = 0;
  const run = createConnectProject(g.vscode, g.output, { bridge: async (_v, _s, _o, { signal }) => {
    if (attempts++ === 0) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Monitoring cancelled')), { once: true }));
    return ready;
  } });
  const first = run();
  await new Promise(resolve => setImmediate(resolve));
  run.cancel();
  await first;
  await run();
  assert.equal(attempts, 2);
  assert.equal(g.calls.opens.length, 1);
});

test('pending result can retry without dismissing its info notification', async () => {
  const g = gui();
  let attempts = 0;
  g.vscode.window.showInformationMessage = () => new Promise(() => {});
  const run = createConnectProject(g.vscode, g.output, { bridge: async () => {
    return attempts++ === 0 ? { ...ready, ready: false, state: 'PENDING' } : ready;
  } });
  await run();
  await run();
  assert.equal(attempts, 2);
  assert.equal(g.calls.opens.length, 1);
});

test('Stop Waiting unblocks even an unresponsive bridge and ignores its late result', async () => {
  const g = gui();
  let resolveOld;
  let attempts = 0;
  const run = createConnectProject(g.vscode, g.output, { bridge: () => {
    return attempts++ === 0 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(ready);
  } });
  const old = run();
  await new Promise(resolve => setImmediate(resolve));
  run.cancel();
  await old;
  await run();
  resolveOld(ready);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(g.calls.opens.length, 1);
});

test('launcher is staged verbatim as a file before terminal startup', async () => {
  const request = buildRequest(settings);
  const calls = [];
  await prepareRequest(request, {
    mkdir: async (...args) => calls.push(['mkdir', ...args]),
    writeFile: async (...args) => calls.push(['writeFile', ...args]),
  });
  assert.equal(calls[0][1], request.directory);
  assert.equal(calls[1][1], request.directory + '\\run.sh');
  assert.equal(calls[1][2], request.script);
  assert.match(calls[1][2], /printf '%s' "\$gl_status"/);
  assert.deepEqual(calls[1][3], { encoding: 'utf8', flag: 'wx', mode: 0o600 });
});

test('actual interactive bash executes a staged launcher file with intact status variables', async t => {
  const files = await import('node:fs/promises');
  const home = mkdtempSync(join(tmpdir(), 'gl-bash-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, '.bashrc'), '# Isolated test startup\n');
  mkdirSync(join(home, 'bin'));
  writeFileSync(join(home, 'bin/gl-dev.js'), 'process.stdout.write(JSON.stringify({ready:true}));');
  const request = buildRequest({ get: (key, fallback) => key === 'wslRepositoryPath' ? home : fallback });
  const directory = request.scriptPath.slice(0, -'/run.sh'.length);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const localPath = path => directory + path.slice(request.directory.length).replaceAll('\\', '/');
  await prepareRequest(request, {
    mkdir: (path, options) => files.mkdir(localPath(path), options),
    writeFile: (path, content, options) => files.writeFile(localPath(path), content, options),
  });
  const child = spawnSync('/bin/bash', ['-i', request.scriptPath], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], timeout: 5000,
    env: { ...process.env, HOME: home },
  });
  assert.equal(child.status, 0);
  assert.equal(readFileSync(`${directory}/exit`, 'utf8'), '0');
  assert.equal(JSON.parse(readFileSync(`${directory}/result.json`)).ready, true);
});

test('staging failure reports share/setup error without creating a terminal', async () => {
  const g = gui();
  await assert.rejects(runWslConnect(g.vscode, settings, g.output, {
    platform: 'win32', prepare: async () => { throw new Error('Share unavailable'); },
  }), /Could not stage.*Share unavailable/);
  assert.equal(g.calls.terminals.length, 0);
});

test('exit status accepts surrounding whitespace and reports malformed contents', async () => {
  for (const rawExit of [' 0\r\n', '']) {
    const g = gui();
    const pending = runWslConnect(g.vscode, settings, g.output, {
      platform: 'win32', files: {
        readFile: async path => path.endsWith('\\exit') ? rawExit : JSON.stringify(ready),
        rm: async () => {},
      },
    });
    if (rawExit) assert.equal((await pending).ready, true);
    else await assert.rejects(pending, /Invalid CLI exit status ""/);
  }
});
