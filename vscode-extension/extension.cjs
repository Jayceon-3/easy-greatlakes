const { createConnectProject } = require('./wsl-connect.cjs');
const { createOpenProject } = require('./open-project.cjs');

function activate(context) {
  const vscode = require('vscode');
  const output = vscode.window.createOutputChannel('Great Lakes');
  context.subscriptions.push(output);
  const connectProject = createConnectProject(vscode, output);
  context.subscriptions.push(vscode.commands.registerCommand(
    'greatLakes.connectProject', connectProject,
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
