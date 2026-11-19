const { createConnectProject } = require('./wsl-connect.cjs');
const { createOpenProject } = require('./open-project.cjs');
const { createReleaseResources } = require('./release-resources.cjs');

function activate(context) {
  const vscode = require('vscode');
  const output = vscode.window.createOutputChannel('Great Lakes');
  context.subscriptions.push(output);
  const connectProject = createConnectProject(vscode, output);
  const releaseResources = createReleaseResources(vscode, output);
  let activeOperation;
  const exclusive = (name, command) => async () => {
    if (activeOperation) {
      void vscode.window.showInformationMessage(`Great Lakes ${activeOperation} is already running. Check its terminal before starting ${name}.`);
      return;
    }
    activeOperation = name;
    try { await command(); } finally { activeOperation = undefined; }
  };
  context.subscriptions.push(vscode.commands.registerCommand(
    'greatLakes.connectProject', exclusive('Connect', connectProject),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'greatLakes.releaseResources', exclusive('Release', releaseResources),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'greatLakes.cancelConnect', () => connectProject.cancel(),
  ));
  context.subscriptions.push({ dispose: () => connectProject.cancel() });
  context.subscriptions.push(vscode.commands.registerCommand(
    'greatLakes.openProject', createOpenProject(vscode, output),
  ));
}

module.exports = { activate };
