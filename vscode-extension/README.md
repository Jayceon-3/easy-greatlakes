# Great Lakes (Local Prototype)

Version 0.2.5 provides four commands:

- **Great Lakes: Open gl-compute Project**: open the existing host and saved directory without invoking the CLI or changing SSH settings.
- **Great Lakes: Release Resources** queries the managed job, confirms its JobID/node, then runs `stop --job-id` in WSL and reports release status.
- **Great Lakes: Stop Waiting for Connect**: clear the local pending operation without stopping the CLI terminal or cancelling any Slurm job.
- **Great Lakes: Connect and Open Project**: run the existing WSL CLI, prepare or reuse an allocation, update gl-compute, then open the project in a new Remote SSH window.

## Installation and settings

Install `easy-greatlakes-0.2.5.vsix` locally in Windows VS Code using **Extensions → … → Install from VSIX…**. Install/enable Remote - SSH locally as well. Commands can be invoked from a WSL workspace window: the extension itself runs on the local UI side.

Keep the working `remote.SSH.path` and `remote.SSH.configFile` settings and Windows → WSL wrapper. The extension does not generate or change those settings. In the Windows file picker, this repository is available at `\\wsl.localhost\Ubuntu-22.04\home\jason\easy-greatlakes`.

The Connect command reads these **local User settings** (defaults match the current development environment):

```jsonc
"greatLakes.wslDistribution": "Ubuntu-22.04",
"greatLakes.wslUser": "jason",
"greatLakes.wslRepositoryPath": "/home/jason/easy-greatlakes",
"greatLakes.projectPath": "/home/dingxuan"
```

Use your actual remote project directory; if projectPath is empty, either command asks for it and saves it. Dismissing this prompt does not submit a resource request. The WSL distribution/user must be the same ones owning your working SSH configuration and previous CLI state. The Windows WSL file share must be able to read this user's temporary files.

## Connect and open

1. Keep this repository at the configured WSL path with Node.js 20+ available in that user's interactive bash shell. This development version calls the checkout directly; it does not bundle a second copy of the CLI.
2. Review `gl-dev.config.json` in that checkout (current default: account eecs442f26_class, spgpu, 1 GPU / 4 CPUs / 24G / 3 hours).
3. Run **Great Lakes: Connect and Open Project** from `Ctrl+Shift+P`.
4. A new **Great Lakes Connect** terminal starts `wsl.exe` with the configured distribution/user, then interactive bash runs `node bin/gl-dev.js connect --json --prepare-ssh` from the repository.
5. Complete any SSH password/Okta prompts in that terminal. Progress remains visible there. The CLI uses its normal host, default WSL SSH config, and existing state directory, so it can recover its own allocations.
6. Only a successful, ready CLI result with a confirmed SSH update opens the new gl-compute project window. Complete any Remote SSH authentication in that new window.

Before compute authentication, the CLI checks any existing `gl-compute` control socket. It removes that specific socket only when it belongs to the current WSL user and `ssh -O check` explicitly reports connection refused, then establishes the connection again. Live sockets are preserved. Timeouts, permission errors, non-socket files, symlinks, or a changed socket stop recovery without deletion. This CLI update takes effect on the next Connect without reinstalling the VSIX. It does not cancel jobs or terminate existing SSH masters.

If compute authentication exits with SSH status 255 (which includes transport failures such as Broken pipe as well as authentication failures), the CLI checks for a stale socket again and retries authentication once with the same allocation. Prompts remain interactive, and password/Okta may be requested again. Timeouts and process interruption are not retried. A second failure preserves the allocation and reports the error; recovery never runs `ssh -O exit` against an active master. This is a bounded retry, not a diagnosis or guaranteed fix for the underlying network failure.

Existing manually submitted jobs are not adopted. This command can allocate new resources and change gl-compute's target via the CLI. It never runs stop, scancel, connection cleanup, or window closing. Existing sessions are left open. Use the original Open command when you only want another window on the existing host.

If the CLI returns a pending job after its wait limit, no remote window opens. Run Connect again to resume. Failures do not automatically submit a replacement or release resources. To interrupt queue waiting, press Ctrl+C in the new Connect terminal; the CLI keeps the allocation. If a terminal is forcibly closed, inspect its saved job state before retrying. Crash-created PID locks are automatically recovered by the current CLI only after confirming the owner has exited. Saved job state is preserved.

The bridge uses a private, uniquely named `/tmp/gl-dev-extension-UUID` directory to transfer final JSON and exit status to the Windows local extension through the WSL file share. Authentication data is not stored there. Successful results are cleaned up. Failed or interrupted requests may leave small diagnostic files in WSL /tmp. It does not modify the CLI's persistent job state format.

This prototype uses the CLI's default SSH configuration and state scope. CLI jobs previously created with custom --host, --ssh-config or --state-dir flags are outside this bridge's scope and are not automatically adopted.

## Diagnostics and testing

Inspect **Output → Great Lakes** for orchestration messages, the **Great Lakes Connect** terminal for CLI/SSH errors, and **Output → Remote - SSH** in the new window for actual connection errors. A window-open request is not proof of a completed remote connection.

Run `npm test` from the repository root. Tests use mocked VS Code APIs, simulated bridge results, and a temporary local CLI fixture to verify the shell/result exchange. They do not start WSL, access Great Lakes, modify the real SSH configuration, or stop existing tasks. Actual Windows + WSL + Remote SSH integration still needs manual verification.

## Build

From this directory:

```bash
npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
```

This builds a local VSIX; it does not publish or install it. No runtime npm dependencies are needed by the extension.

References: [VS Code terminal APIs](https://code.visualstudio.com/api/references/vscode-api#TerminalOptions), [openFolder](https://code.visualstudio.com/api/references/commands), [Remote SSH URI](https://code.visualstudio.com/docs/remote/troubleshooting#_connect-to-a-remote-host-from-the-terminal).

## Recovery after an interrupted Connect

The “already running” message refers to a pending local extension command, not the Slurm queue. Version 0.2.1 writes a completion marker from shell EXIT/INT/TERM traps, releases the command guard without waiting for notifications to be dismissed, normalizes Windows result paths, and bounds file access and overall monitoring time.

If the local command still needs recovery, run **Great Lakes: Stop Waiting for Connect**, or click **Stop Waiting** on the already-running notification. This only stops local monitoring; it does not terminate a shell, run scancel, close windows, or delete CLI state. If the CLI is genuinely still running, use Ctrl+C in its Great Lakes Connect terminal first. Then retry Connect. Late results from cancelled monitoring cannot open an extra project window.

When updating from 0.2.0 with a stuck operation, install the new VSIX and reload the window when ready. Closing only the old Great Lakes Connect terminal may also unblock the old version. Do not remove CLI lock files just because the Slurm queue is empty; first verify the local CLI process has exited.

New regression tests cover shell SIGINT/EXIT status, interrupted results, blocked file access, monitoring cancellation, and retry while prior notifications remain visible. These tests do not contact the cluster.

## Launcher fix in 0.2.2

Failed user attempts produced empty exit/result files. The previous Windows-to-WSL launch placed a multiline script containing shell variables inside command-line arguments; that route depends on quoting across multiple parsers. Version 0.2.2 writes run.sh as literal UTF-8 through the WSL file share first, then starts `wsl.exe --distribution DISTRO --user USER --exec bash -i /tmp/gl-dev-extension-UUID/run.sh`. Command-line arguments contain only the file path, not shell code or variables.

If the launcher reaches the CLI and it fails, the terminal prints its error and waits for Enter before closing. Exit-status parsing tolerates trailing whitespace. Launcher/share failures include the request path and available terminal exit code. The Great Lakes output channel records the launcher path; failed request directories remain available for diagnosis. No cluster resources are requested during development tests. Real Windows execution remains a user-side verification step.

## CLI lock recovery update

The CLI in the configured repository now uses a kernel-backed flock guard to serialize connect/stop and safely recover dead-owner PID lock markers. This is a CLI source update, not a new extension version: retry the same Connect command with the existing 0.2.2 VSIX. No reinstall or window reload is required. A .lock.guard file may remain permanently and is not itself an active lock; do not delete it during normal use. Invalid/live/permission-denied PID owners continue to block instead of risking duplicate submission.

## Interactive compute authentication in 0.2.3

After allocation and SSH configuration updates, the CLI now completes compute-node host-key/password/Okta authentication in the Great Lakes Connect WSL terminal. It requires an enabled persistent SSH master, checks that the master is running, and verifies the actual compute hostname before opening Remote SSH. The plugin requires this authentication result before requesting a new window.

This targets the case where the Remote SSH installation terminal displays a yes/no host-key prompt but keyboard input is not forwarded correctly through the WSL wrapper. The exact Remote SSH input failure has not been independently reproduced; moving authentication to the actual WSL terminal avoids depending on that input path. Existing host verification stays enabled, and existing sessions are not closed.

For an immediate workaround with a valid existing allocation, run `ssh -MNf gl-compute` in a normal local WSL terminal, finish fingerprint verification and authentication there, and use Open gl-compute Project. This does not submit a new job. The new Connect command reuses its existing managed allocation if still valid.

## Release Resources in 0.2.4

Install the new VSIX locally in Windows VS Code and reload the initiating window when ready. Run **Great Lakes: Release Resources** from the command palette. A Great Lakes Status terminal runs `status --json` using the same WSL identity and repository as Connect. No project path is required. With a confirmed managed job, a modal shows its JobID, node, state, and the effect of cancellation. Dismissing the modal sends no cancellation. Query errors stop the operation.

After confirmation, a Great Lakes Release terminal runs `stop --json --job-id CONFIRMED_ID`. The CLI rechecks job identity/name/owner under the existing connect/stop lock; a changed JobID is rejected. The result reports either confirmed release or cancellation still pending. Pending jobs can also be released. Authentication remains interactive, and a timeout/interruption after cancellation does not imply the job was retained: query its status before retrying. There is no automatic cancellation retry.

Connect and Release cannot run concurrently in the same extension instance. CLI locks protect state operations across windows, and the confirmed JobID protects against a changed allocation during the confirmation dialog. Release cancels processes in the target allocation and may disconnect its remote sessions. It does not terminate SSH masters or close VS Code windows. **Stop Waiting for Connect** continues to affect only Connect monitoring.

The CLI now also accepts `node bin/gl-dev.js status --json` without a JobID to inspect the saved managed allocation. Explicit `status JOB_ID` remains supported. Tests cover confirmed/cancelled release, missing and pending jobs, query errors, mismatched results, frozen WSL settings, and strict bridge JSON validation. Real cancellation via this new UI remains a user-side integration check.

## Prefer the current allocation in 0.2.5

**Connect and Open Project** now calls `connect --json --prepare-ssh --reuse-managed`. The CLI checks the managed job under its existing state lock and uses its saved resources when the job is valid. This supports allocations created with custom CLI flags even when the repository defaults differ. Existing pending jobs are retained and waited on; running jobs have SSH prepared and verified before the project opens. A healthy shared SSH connection can be reused during preparation without fresh authentication.

If there is no valid allocation, the CLI uses the configured defaults for a new request, subject to its existing recently-invisible-job and unresolved-submission safeguards. A definite rejection also permits a new request with defaults. Unresolved requests recover using their saved configuration and the remote receipt protocol. Failed queries, invalid saved resources and jobs that are stopping never trigger a new allocation. This command does not cancel jobs, resize them or extend their runtime. The original Open command remains unchanged.

Install the 0.2.5 VSIX locally in Windows VS Code and reload the initiating window when ready. Tests simulate custom-allocation reuse, pending jobs, absent/ended allocations and query failures; actual Windows/WSL/Remote SSH validation remains a user-side check.
