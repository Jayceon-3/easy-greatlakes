const fs = require('node:fs/promises');
const { win32 } = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateProjectPath } = require('./open-project.cjs');

function quote(value) { return "'" + String(value).replaceAll("'", "'\"'\"'") + "'"; }

function buildRequest(settings, id = randomUUID(), { action = 'connect', expectedJobId } = {}) {
  if (!['connect', 'status', 'stop'].includes(action)) throw new Error('Invalid CLI action.');
  if (action === 'stop' && !/^[1-9]\d*$/.test(expectedJobId ?? '')) throw new Error('Release requires an explicit JobID.');
  const label = action === 'connect' ? 'Connect' : action === 'stop' ? 'Release' : 'Status';
  const command = action === 'connect' ? 'connect --json --prepare-ssh'
    : action === 'stop' ? `stop --json --job-id ${quote(expectedJobId)}` : 'status --json';
  const distribution = settings.get('wslDistribution', 'Ubuntu-22.04');
  const user = settings.get('wslUser', 'jason');
  const repository = settings.get('wslRepositoryPath', '/home/jason/easy-greatlakes');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(distribution)) throw new Error('Invalid greatLakes.wslDistribution.');
  if (!/^[a-z_][a-z0-9_-]*\$?$/.test(user)) throw new Error('Invalid greatLakes.wslUser.');
  if (validateProjectPath(repository)) throw new Error('greatLakes.wslRepositoryPath must be an absolute WSL repository path.');
  if (!/^[a-f0-9-]+$/.test(id)) throw new Error('Invalid request ID.');
  const directory = `/tmp/gl-dev-extension-${id}`;
  const windowsDirectory = `\\\\wsl.localhost\\${distribution}\\tmp\\gl-dev-extension-${id}`;
  const script = [
    'umask 077',
    `mkdir -p -m 700 -- ${quote(directory)} || exit 1`,
    'gl_finalize() {',
    '  gl_status=$?',
    '  trap - EXIT INT TERM',
    `  if [ -f ${quote(`${directory}/result.tmp`)} ]; then`,
    `    mv -- ${quote(`${directory}/result.tmp`)} ${quote(`${directory}/result.json`)}`,
    '  else',
    `    : > ${quote(`${directory}/result.json`)}`,
    '  fi',
    `  printf '%s' "$gl_status" > ${quote(`${directory}/exit.tmp`)}`,
    `  mv -- ${quote(`${directory}/exit.tmp`)} ${quote(`${directory}/exit`)}`,
    '  if [ "$gl_status" -ne 0 ]; then',
    `    printf "\\nGreat Lakes ${label} failed (exit %s). Review the terminal output above.\\n" "$gl_status" >&2`,
    '    if [ -t 0 ]; then read -r -p "Press Enter to close this terminal... " gl_unused || :; fi',
    '  fi',
    '}',
    'trap gl_finalize EXIT',
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    // The conditional also works when interactive startup enables errexit.
    `if (cd ${quote(repository)} && node bin/gl-dev.js ${command}) > ${quote(`${directory}/result.tmp`)}; then`,
    '  exit 0',
    'else',
    '  exit "$?"',
    'fi',
  ].join('\n');
  return { action, expectedJobId, label, directory: windowsDirectory, scriptPath: `${directory}/run.sh`, distribution, user, repository, script };
}

async function prepareRequest(request, files = fs) {
  // Stage literal UTF-8 bytes: do not pass multi-line shell code through Windows argv.
  await files.mkdir(request.directory, { mode: 0o700 });
  await files.writeFile(win32.join(request.directory, 'run.sh'), request.script, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function runWslConnect(vscode, settings, output, {
  action = 'connect', expectedJobId, platform = process.platform, files = fs, request = buildRequest(settings, undefined, { action, expectedJobId }), pollMs = 750, signal, ioTimeoutMs = 10000, maxWaitMs = 40 * 60 * 1000, prepare = prepareRequest,
} = {}) {
  const label = request.label ?? 'Connect';
  const interruptionNote = request.action === 'stop'
    ? 'Cancellation may already have been sent; check job status before retrying.'
    : 'No cancellation was sent. Any submitted job is retained.';
  if (signal?.aborted) throw new Error(`${label} monitoring cancelled.`);
  if (platform !== 'win32') throw new Error(`${label} must run in the Windows local extension host. Install this extension locally, not in WSL.`);
  output.appendLine(`Running WSL ${label.toLowerCase()}: ${request.distribution}, user ${request.user}, repository ${request.repository}`);
  try {
    await prepare(request, files);
  } catch (error) {
    throw new Error(`Could not stage the WSL launcher at ${request.directory}: ${error.message}. Check the WSL distribution/user and Windows WSL file-share access.`);
  }
  if (signal?.aborted) throw new Error('Connect monitoring cancelled before terminal startup.');
  output.appendLine(`Launcher file: ${request.scriptPath}`);
  // An actual VS Code terminal gives SSH a controlling TTY for password/Okta prompts.
  // stdout carries only JSON to a private per-request file; stderr stays visible.
  const terminal = vscode.window.createTerminal({
    name: `Great Lakes ${label}`, shellPath: 'wsl.exe',
    shellArgs: ['--distribution', request.distribution, '--user', request.user, '--exec', 'bash', '-i', request.scriptPath],
    isTransient: true,
  });
  terminal.show(true);
  return new Promise((resolve, reject) => {
    let settled = false, busy = false, closed = false;
    let timer;
    let subscription;
    const started = Date.now();
    const aborted = () => finish(new Error(`${label} monitoring cancelled. The CLI may still be running; check its terminal. ${interruptionNote}`));
    async function boundedRead(path) {
      let timeout;
      try {
        return await Promise.race([
          files.readFile(path, 'utf8'),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`WSL result file access timed out. Check the ${label} terminal and WSL file share.`)), ioTimeoutMs); }),
        ]);
      } finally { clearTimeout(timeout); }
    }
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      subscription?.dispose();
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    }
    async function poll() {
      if (settled || busy) return;
      if (Date.now() - started >= maxWaitMs) { finish(new Error(`${label} monitoring timed out. Inspect the CLI terminal and job state before retrying.`)); return; }
      busy = true;
      try {
        const rawExit = await boundedRead(win32.join(request.directory, 'exit'));
        const exit = rawExit.trim();
        if (settled) return;
        if (!/^\d+$/.test(exit)) throw new Error(`Invalid CLI exit status ${JSON.stringify(rawExit)}. Inspect ${request.directory} and the retained Great Lakes ${label} terminal.`);
        if (Number(exit) === 130 || Number(exit) === 143) throw new Error(`${label} was interrupted. ${interruptionNote} No remote window was opened.`);
        if (Number(exit) !== 0) throw new Error(`WSL ${label.toLowerCase()} exited with code ${exit}. Check the Great Lakes ${label} terminal and job status before retrying.`);
        const text = await boundedRead(win32.join(request.directory, 'result.json'));
        if (settled) return;
        const result = JSON.parse(text);
        validateResult(result, request.action ?? 'connect', request.expectedJobId);
        try { await files.rm(request.directory, { recursive: true, force: true }); }
        catch (error) { output.appendLine(`Could not remove temporary result files: ${error.message}`); }
        finish(null, result);
      } catch (error) {
        if (error.code !== 'ENOENT') finish(error);
        else if (closed || terminal.exitStatus) finish(new Error(`WSL terminal exited without a complete result (terminal exit code: ${terminal.exitStatus?.code ?? 'unknown'}). Launcher: ${request.scriptPath}. Check the terminal output and CLI state before retrying.`));
      } finally { busy = false; if (closed && !settled) poll(); }
    }
    subscription = vscode.window.onDidCloseTerminal(endedTerminal => {
      if (endedTerminal === terminal) {
        closed = true;
        if (!busy) poll();
      }
    });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    timer = setInterval(poll, pollMs);
    poll();
  });
}

function validateResult(result, action, expectedJobId) {
  if (!result || result.host !== 'gl-login' || typeof result.state !== 'string') throw new Error('Invalid CLI result or unexpected login host.');
  const validId = /^[1-9]\d*$/.test(result.jobId ?? '');
  if (action === 'status') {
    if (typeof result.found !== 'boolean' || (result.found ? !validId || !/^gldev-[a-f0-9]{24}$/.test(result.jobName ?? '') : result.jobId !== null && !validId)) throw new Error('Invalid CLI managed status result.');
  } else if (action === 'stop') {
    if (result.jobId !== expectedJobId || typeof result.released !== 'boolean' || (result.released ? result.state !== 'NOT_IN_QUEUE' : result.cancellationRequested !== true)) throw new Error('Invalid CLI release result or mismatched JobID.');
  } else {
    if (typeof result.ready !== 'boolean' || !validId) throw new Error('Invalid CLI connect result.');
    if (result.ready && (!result.sshConfigUpdate || result.sshConfigUpdate.node !== result.node || !/^gl\d+$/.test(result.node) || !result.computeSsh?.ready || result.computeSsh.node !== result.node)) {
      throw new Error('CLI did not confirm a valid allocation, SSH update and reusable authenticated compute connection. No remote window will be opened.');
    }
  }
}

function waitForOperation(task, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('Stopped waiting for Connect. The CLI may still run in its terminal. No job was cancelled.'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function createConnectProject(vscode, output, { bridge = runWslConnect } = {}) {
  let running = false;
  let controller;
  const run = async () => {
    if (running) {
      const action = await vscode.window.showInformationMessage('Great Lakes Connect is already running. See its terminal, or stop waiting to clear this operation.', 'Stop Waiting');
      if (action === 'Stop Waiting') controller?.abort();
      return;
    }
    running = true;
    const operation = new AbortController();
    controller = operation;
    try {
      if (!vscode.extensions.getExtension('ms-vscode-remote.remote-ssh')) throw new Error('Install and enable Remote - SSH locally.');
      // Prompt before allocating resources, so dismissing the project prompt is a no-op.
      const { getProjectPath, openProjectWindow } = require('./open-project.cjs');
      const projectPath = await waitForOperation(getProjectPath(vscode), operation.signal);
      if (projectPath === undefined) return;
      const result = await waitForOperation(bridge(vscode, vscode.workspace.getConfiguration('greatLakes'), output, { signal: operation.signal }), operation.signal);
      if (operation.signal.aborted) return;
      output.appendLine(`Job ${result.jobId}: ${result.state}; node ${result.node ?? 'not allocated'}`);
      if (!result.ready) {
        void vscode.window.showInformationMessage(`Job ${result.jobId} is ${result.state}. Run Great Lakes: Connect and Open Project again to resume. The job is retained.`);
        return;
      }
      await waitForOperation(openProjectWindow(vscode, output, projectPath), operation.signal);
    } catch (error) {
      output.appendLine(`Connect failed: ${error.message}`);
      void vscode.window.showErrorMessage(`Great Lakes: ${error.message}`);
    } finally { running = false; }
  };
  run.cancel = () => controller?.abort();
  return run;
}

module.exports = { buildRequest, prepareRequest, runWslConnect, createConnectProject };
