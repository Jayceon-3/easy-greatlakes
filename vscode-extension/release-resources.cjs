const { runWslConnect } = require('./wsl-connect.cjs');

function createReleaseResources(vscode, output, { bridge = runWslConnect } = {}) {
  let running = false;
  return async function releaseResources() {
    if (running) {
      void vscode.window.showInformationMessage('Great Lakes resource release is already running. Check its terminal.');
      return;
    }
    running = true;
    try {
      // Freeze the target environment across lookup, confirmation and stop.
      const configuration = vscode.workspace.getConfiguration('greatLakes');
      const snapshot = Object.fromEntries(['wslDistribution', 'wslUser', 'wslRepositoryPath'].map(key => [key, configuration.get(key)]));
      const settings = { get: (key, fallback) => snapshot[key] ?? fallback };
      const job = await bridge(vscode, settings, output, { action: 'status' });
      if (!job.found) {
        void vscode.window.showInformationMessage(job.state === 'SUBMISSION_UNKNOWN'
          ? 'The previous submission is unresolved. Inspect its CLI state and queue before releasing resources.'
          : 'No active managed job was found. No cancellation was sent.');
        return;
      }
      if (!/^[1-9]\d*$/.test(job.jobId ?? '')) throw new Error('Invalid managed JobID. No cancellation was sent.');
      const confirm = await vscode.window.showWarningMessage(
        `Release Great Lakes job ${job.jobId}?`,
        { modal: true, detail: `Node: ${job.node ?? 'not allocated'}\nState: ${job.state}\nWSL: ${settings.get('wslDistribution', 'Ubuntu-22.04')} / ${settings.get('wslUser', 'jason')}\nThis cancels the allocation and terminates processes within it. Connected remote sessions may disconnect.` },
        'Release Resources',
      );
      if (confirm !== 'Release Resources') return;
      const result = await bridge(vscode, settings, output, { action: 'stop', expectedJobId: job.jobId });
      if (result.jobId !== job.jobId || typeof result.released !== 'boolean') throw new Error('Release result did not match the confirmed job. Check its status.');
      output.appendLine(`Release job ${job.jobId}: ${result.state}; released=${result.released}`);
      void vscode.window.showInformationMessage(result.released
        ? `Great Lakes job ${job.jobId} is no longer in the queue. Resources are released.`
        : `Cancellation requested for job ${job.jobId}; release is not confirmed yet. Run Release Resources again to verify.`);
    } catch (error) {
      output.appendLine(`Release failed: ${error.message}`);
      void vscode.window.showErrorMessage(`Great Lakes: ${error.message}`);
    } finally { running = false; }
  };
}

module.exports = { createReleaseResources };
