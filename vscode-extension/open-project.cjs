function validateProjectPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\x00-\x1f\x7f\\]/.test(value)) {
    return 'Enter an absolute Linux directory, such as /home/dingxuan/nano-vllm.';
  }
  return undefined;
}

async function getProjectPath(vscode) {
  const settings = vscode.workspace.getConfiguration('greatLakes');
  let projectPath = settings.get('projectPath', '');
  if (!projectPath) {
    projectPath = await vscode.window.showInputBox({
      title: 'Open gl-compute Project',
      prompt: 'Absolute project directory on the allocated compute node',
      placeHolder: '/home/dingxuan/nano-vllm',
      ignoreFocusOut: true,
      validateInput: validateProjectPath,
    });
    if (projectPath === undefined) return undefined;
    const invalid = validateProjectPath(projectPath);
    if (invalid) throw new Error(invalid);
    await settings.update('projectPath', projectPath, vscode.ConfigurationTarget.Global);
  }
  const invalid = validateProjectPath(projectPath);
  if (invalid) throw new Error(`greatLakes.projectPath: ${invalid}`);
  return projectPath;
}

async function openProjectWindow(vscode, output, projectPath) {
  const uri = vscode.Uri.from({
    scheme: 'vscode-remote', authority: 'ssh-remote+gl-compute', path: projectPath,
  });
  output.appendLine(`Requesting new Remote SSH window: ${uri.toString()}`);
  // The local Remote SSH resolver owns SSH settings, authentication and server startup.
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  output.appendLine('Window open requested. Check the new window for Remote SSH connection progress.');
}


function createOpenProject(vscode, output) {
  return async function openProject() {
    try {
      if (!vscode.extensions.getExtension('ms-vscode-remote.remote-ssh')) {
        throw new Error('Install and enable Remote - SSH in local VS Code, then retry.');
      }
      const projectPath = await getProjectPath(vscode);
      if (projectPath === undefined) return;
      await openProjectWindow(vscode, output, projectPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Open failed: ${message}`);
      await vscode.window.showErrorMessage(`Great Lakes: ${message}`);
    }
  };
}

module.exports = { createOpenProject, validateProjectPath, getProjectPath, openProjectWindow };
