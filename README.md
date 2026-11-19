# easy-greatlakes

A VS Code extension project that automates the Great Lakes development connection workflow using Windows, WSL, SSH, and Slurm. The CLI prototype supports `gl-dev status`, `gl-dev connect`, and `gl-dev stop` for querying, preparing, and releasing a managed GPU allocation.

## VS Code extension

Install `vscode-extension/easy-greatlakes-0.2.4.vsix` locally in Windows VS Code via **Extensions → … → Install from VSIX…**. It can be used from a WSL workspace window, while its UI-side code runs locally.

- **Great Lakes: Release Resources** queries the managed job, confirms its JobID/node, then runs `stop --job-id` in WSL and reports release status.
- **Great Lakes: Stop Waiting for Connect** clears a stuck local wait without cancelling jobs.
- **Great Lakes: Open gl-compute Project** only opens the configured host and remote directory.
- **Great Lakes: Connect and Open Project** runs this checkout's WSL CLI in an interactive terminal, waits for a ready allocation and successful gl-compute update, then opens the project in a new Remote SSH window.

Defaults: WSL distribution Ubuntu-22.04, WSL user jason, repository /home/jason/easy-greatlakes. Configure greatLakes.wslDistribution, greatLakes.wslUser and greatLakes.wslRepositoryPath if needed. The remote directory is saved as greatLakes.projectPath. Preserve your working Remote SSH wrapper/settings. Existing manually submitted allocations are not adopted; Connect may request new resources.

See [extension instructions](vscode-extension/README.md) for setup, cancellation, diagnostics, and bridge limitations. This version reuses the repository rather than bundling another CLI copy. Tests cover the bridge without running WSL or contacting the cluster. Real Windows/WSL integration remains to be verified.

## Running the CLI

Run from a **local WSL terminal** in this repository. Requires Node.js 20 or newer and an SSH configuration that can already connect to `gl-login`. There are no third-party dependencies, so `npm install` is not required.

```bash
node bin/gl-dev.js --help
node bin/gl-dev.js status            # Inspect the saved managed job
node bin/gl-dev.js status YOUR_JOB_ID
```

Replace `YOUR_JOB_ID` with the integer ID of your current job. You can also run it through npm:

```bash
npm run gl-dev -- status YOUR_JOB_ID
```

Follow the normal SSH prompts when Okta authentication is required. To authenticate separately first, run `ssh gl-login`, complete login, then `exit` back to local WSL before running the query.

Example output (illustrative only):

```text
Job ID: 66262642
State: RUNNING
Node: gl1504
Elapsed: 12:34
Time limit: 3:00:00
Time left: 2:47:26
Reason: None
```

Options:

```bash
node bin/gl-dev.js status YOUR_JOB_ID --json
node bin/gl-dev.js status YOUR_JOB_ID --timeout 180
node bin/gl-dev.js status YOUR_JOB_ID --host gl-login --ssh-config /home/jason/.ssh/config
```

The status command uses local SSH settings by default, without hardcoding the account, node, or project path. It queries only the current user's queue on the current cluster. Historical, array, and heterogeneous jobs are not supported yet.

Omit the JobID to inspect the allocation recorded by `connect` (including one created through the VS Code extension):

```bash
node bin/gl-dev.js status
node bin/gl-dev.js status --json
```

The result includes JobID, managed job name, state, node, elapsed time, time limit, time left, and queue reason. It verifies both the saved JobID (when available) and managed job name against one queue snapshot. It does not select unrelated or manually submitted jobs. If Connect used a different `--host`, `--ssh-config`, or `--state-dir`, supply the same options for managed status.

`NO_MANAGED_JOB` means there is no saved allocation; it does not mean the user's entire queue is empty. `NOT_IN_QUEUE` means the saved job is absent, without inferring whether it completed, expired, or was cancelled. `SUBMISSION_UNKNOWN` means a previous submission is unresolved. All three include an explanatory note. Failed queries produce errors rather than an ended status. Managed status preserves the saved job record and SSH settings, and never submits or cancels jobs. It shares the connect/stop state lock, so an operation already in progress can temporarily block it.

## Status and errors

- `PENDING`: queued; the node may be empty.
- `RUNNING`: running; shows the allocated node.
- `NOT_IN_QUEUE`: the ID is absent from the current user's queue. No end reason is inferred; log in and use `sacct -j YOUR_JOB_ID` to investigate.
- SSH, authentication, timeout, Slurm command, or output format errors: reported as query failures, never as evidence that a job has ended.

Other Slurm states are displayed as returned. Exit code `0` means the query succeeded (including absent jobs), `1` means the query failed, and `2` means invalid arguments. With `--json`, successful results go to stdout and query error objects go to stderr. SSH authentication prompts and diagnostics also use stderr, so it may contain additional text. The total timeout defaults to 120 seconds, including manual authentication.

The `status` command only queries jobs. The `connect` command submits or reuses an allocation using `sbatch + sleep infinity`, Okta, and default resources of 1 GPU, 4 CPUs, `24G` CPU memory, and 3 hours. The stop command releases only its saved managed allocation. On a ready allocation, connect updates the dedicated gl-compute HostName; status and stop leave SSH settings unchanged.

## Validation

```bash
npm test
```

Automated checks use simulated remote output to cover pending and running jobs, empty queues, login banners, query failures, timeouts, malformed output, and argument validation. Real SSH/Okta and Slurm behavior must also be verified in the actual environment.

On 2026-11-17, real queries through the existing SSH connection returned `RUNNING`, node `gl1504`, and time limit `3:00:00` for job `66280825`, and `NOT_IN_QUEUE` for the old example job `66262642`. These checks reused existing authentication. Fresh Okta authentication, real queueing, and disconnect recovery have not yet been verified.

Query fields and options follow the [official Slurm squeue documentation](https://slurm.schedmd.com/squeue.html).

## Development baseline

- [Actual configuration and open questions](docs/current-workflow.md)
- [Manual workflow guide](GreatLakes_VSCode_WSL_Guide.md)
- [Extension plan](GreatLakes_VSCode_Plugin_Plan.md)

Still to confirm for automatic Remote SSH opening: the Windows SSH wrapper contents and the project subdirectory. The default runtime is confirmed as 3 hours.

## Preparing an allocation with connect

From a local WSL terminal in the repository root:

```bash
node bin/gl-dev.js connect
# Equivalent npm command:
npm run gl-dev -- connect
```

The command reads `gl-dev.config.json`, which contains the current account `eecs442f26_class`, partition `spgpu`, 1 GPU, 4 CPUs, 24G CPU memory, and a 3-hour runtime. Use `--config PATH` for another JSON configuration. This implementation generates its own sbatch request using `--wrap='sleep infinity'`; it does not modify or execute the existing `~/vscode_gpu.sh`.

`connect` tracks one allocation per SSH host/config scope in `~/.local/state/easy-greatlakes`. It reuses its own pending or running job. Existing manually submitted jobs are not adopted; running connect for the first time may therefore create an additional allocation. Use the same host, SSH config, and state directory on subsequent runs to recover the same job.

The command polls every 30 seconds, for up to 30 minutes by default. When RUNNING with a single assigned node, it prints the JobID and node. If the waiting limit is reached, it returns the pending job with `ready: false`; run connect again to continue. `--timeout` limits each SSH operation, including authentication; `--wait-timeout` limits the polling period, checked between SSH operations.

```bash
# Submit/reuse and report current state without polling:
node bin/gl-dev.js connect --no-wait

# Machine-readable final output, progress and SSH messages on stderr:
node bin/gl-dev.js connect --json

# Poll every 60 seconds for up to one hour:
node bin/gl-dev.js connect --poll-interval 60 --wait-timeout 3600
```

Ctrl+C stops local waiting and retains the Slurm job. Restarting connect recovers the saved JobID. State is written atomically, and a shared local lock prevents connect and stop from acting concurrently using the same scope and state directory. After a crash, the next command automatically reclaims a lock only when its recorded PID is confirmed to have exited. Live or unreadable owners remain protected.

If submission times out or the response is lost, the saved unique job name is used to reconcile against squeue on the next invocation. If no job is found and the original submission result remains unknown, connect refuses to submit again. Inspect `squeue` and `sacct` for the reported name before removing the corresponding state JSON to permit a new request. Never clear uncertain state without checking for an existing allocation. A corrupt state file also stops the command rather than triggering a fresh request.

Changing the preset while a managed job is still present is rejected. Release that job before requesting different resources. Logs are written in the remote home directory as `slurm-JOBID.out`.

After allocation, connect updates `gl-compute`. Open Remote SSH using the [manual guide](GreatLakes_VSCode_WSL_Guide.md). Automatic VS Code opening is not implemented yet. Release the managed allocation from local WSL when finished:

```bash
node bin/gl-dev.js stop
```

Manual `scancel YOUR_JOB_ID` on the login node remains available for jobs outside this tool. Closing the CLI or VS Code does not release the allocation.

Connect tests simulate submission, reuse, recovery, timeouts, locking, and cancellation of local waiting. The generated remote shell command is tested with a fake sbatch executable. Real allocation submission and a fresh Okta login still require an end-to-end check on Great Lakes.

Submission options follow the [Slurm sbatch documentation](https://slurm.schedmd.com/sbatch.html).

## Releasing an allocation with stop

Run in local WSL, with the same `--host`, `--ssh-config`, and `--state-dir` scope used by connect:

```bash
node bin/gl-dev.js stop
# Optional: require the saved job to match the ID of your test allocation:
node bin/gl-dev.js stop --job-id YOUR_MANAGED_JOB_ID
# Equivalent npm command:
npm run gl-dev -- stop
```

Stop reads the persisted job record and queries the current remote user's queue. It checks both the exact JobID and unique `gldev-...` job name, prints the target, then invokes scancel restricted by ID, name, and remote owner. It does not adopt or cancel manually submitted jobs. `--job-id` is only a guard against selecting an unexpected saved job; it does not authorize cancelling an arbitrary job. Stop does not require the resource configuration file.

By default, stop checks every 15 seconds for up to 120 seconds after requesting cancellation. Only a successful query showing the job absent clears saved state. An already absent older job is also cleared without sending scancel; no historical end reason is inferred. A recent invisible job or an unresolved submission remains recorded for investigation. If an uncertain submission is found by its unique name, stop can recover its ID and cancel it.

```bash
node bin/gl-dev.js stop --json
node bin/gl-dev.js stop --no-wait
node bin/gl-dev.js stop --poll-interval 30 --wait-timeout 300
```

A successful command can return `released: false` if the job remains in the queue after `--no-wait` or the wait limit. `cancellationRequested: true` means the request was sent, not that resources have been released. Rerun stop to check again. Query errors, cancellation failures, lost responses, and Ctrl+C preserve saved state. Connect refuses to reuse a job marked as stopping while it remains in the queue.

Connect and stop share a lock. If connect is currently polling, press Ctrl+C in that terminal first; then run stop. Closing VS Code or the CLI does not automatically release resources. A crash may leave a PID marker; the next command safely recovers it after confirming the owner has exited.

Stop was validated with simulated queues and a fake scancel executable. No real cluster jobs were cancelled during development. Verify the real flow using a disposable tool-managed allocation when convenient.

Cancellation options and filtering follow the [Slurm scancel documentation](https://slurm.schedmd.com/scancel.html).

## Automatic gl-compute configuration updates

When connect returns a RUNNING allocation with a node, it updates `HostName` in the existing dedicated `Host gl-compute` block in local WSL. The default file is `~/.ssh/config`. With `--ssh-config PATH`, that file is used both for remote commands and for the update. Keep the same option across connect/stop calls because it is part of the managed job's state scope.

```bash
node bin/gl-dev.js connect
# Keep the allocation-only behavior when needed:
node bin/gl-dev.js connect --skip-ssh-update
```

Pending allocations do not change SSH settings. Existing usernames, keys, ProxyJump, shared connection reuse settings, comments, and other host blocks are preserved. Missing HostName is inserted into the dedicated block. A missing/duplicate dedicated block, duplicate HostName, or conflicting earlier rules produces an error instead of guessing. Configurations where the dedicated block exists only in an Include need manual setup in the main file before using this version.

A candidate is checked using local `ssh -G -T -F CANDIDATE gl-compute` before replacement. The effective hostname must match the allocated node. A backup is written as `config.gl-dev-backup-UUID` beside the actual configuration file, then the candidate replaces the file atomically. File permissions are preserved. Symbolic links are resolved and the real target is updated, leaving the symlink intact. Repeating an unchanged update creates no new backup.

The CLI prints the config and backup paths; JSON includes them under `sshConfigUpdate`. To roll back, copy the printed backup contents to the printed configuration target path, after checking that you want to restore that version. The updater uses a separate `.gl-dev.lock` file to prevent simultaneous tool writes. After a crash, confirm its recorded process has exited before removing the lock.

If validation or writing fails, the job remains allocated and the error reports its JobID and node. Fix the configuration and rerun connect to reuse the allocation, or run stop to release it. Updating the file does not close existing SSH or VS Code sessions. Reopen the Remote SSH connection when switching nodes. Automatic authentication, connection termination, and VS Code launching are not part of this step.

The tests exercise actual local SSH configuration evaluation against temporary files; they do not modify the real `~/.ssh/config` or contact compute nodes. Syntax and precedence follow the [OpenSSH configuration manual](https://man.openbsd.org/ssh_config).

## Local lock recovery

The WSL CLI uses `flock` from util-linux (normally included in Ubuntu) to hold a kernel-backed guard for the full connect/stop operation. That guard is released by the OS even after SIGKILL. A persistent `.lock.guard` file is normal: its presence alone does not mean a process is running, and it must not be removed during normal operation.

Legacy `.json.lock` PID markers are recovered under the guard only when `process.kill(pid, 0)` reports that the owner no longer exists. Live PIDs, permission-denied checks, and malformed or incomplete PID records remain protected. Saved job JSON is never removed by lock recovery. Existing Slurm allocations are always reconciled by connect/stop afterward.

This CLI fix is read directly from the configured WSL repository. Users of the 0.2.2 extension do not need a new VSIX or window reload for this change. Regression tests cover live owners, dead legacy owners, abrupt process death, concurrent recovery, and action failure cleanup.

## Compute authentication before Remote SSH

The extension now invokes `connect --json --prepare-ssh`. Once the allocation and gl-compute configuration are ready, the CLI inspects connection reuse settings, runs `ssh -o StrictHostKeyChecking=ask -MNf gl-compute` in the interactive WSL terminal, checks the master with `ssh -O check gl-compute`, and verifies the remote hostname. Only then is the Remote SSH window requested. This avoids relying on the Remote SSH install terminal to handle WSL interactive prompts.

The CLI can also be invoked directly with `node bin/gl-dev.js connect --prepare-ssh`. Normal CLI connect without the flag retains its existing behavior. For an already configured valid allocation, manually running `ssh -MNf gl-compute` in local WSL can prepare authentication without invoking resource allocation at all. Verify new host key fingerprints against a trusted cluster record; host verification is not disabled.

This requires the existing ControlMaster/ControlPath/ControlPersist configuration. It does not terminate master connections or cancel jobs. Authentication/master/hostname failures preserve the allocated job and prevent automatic window opening. Tests use simulated SSH processes; real Windows/WSL authentication remains to be validated locally.
