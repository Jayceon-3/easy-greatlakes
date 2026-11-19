# Current Workflow and Configuration Inventory

Status: Core SSH settings, SSH configuration, and the sbatch script have been supplied. There is enough information to start the status query prototype. Remaining fields can be completed when needed for later features.

Instructions: Replace `TODO` with actual values. Examples are not confirmed settings; record verification results for key steps. Do not paste passwords, Okta codes, private keys, or access tokens. Record only key paths. Check logs for sensitive information before sharing.

References: [Manual guide](../GreatLakes_VSCode_WSL_Guide.md) · [Extension plan](../GreatLakes_VSCode_Plugin_Plan.md)

## 1. Confirmed first-version decisions

| Item | Decision |
| --- | --- |
| Environment | Windows VS Code → WSL SSH → Great Lakes compute node |
| Resource allocation | Submit with `sbatch`; retain the allocation with `sleep infinity`; do not use `salloc` |
| Authentication | Okta, preserving manual interactive authentication |
| Default resources | Single node, 1 GPU, 4 CPUs, 24G CPU memory, 3 hours |
| Closing windows | Does not cancel jobs; valid jobs remain until expiration or explicit cancellation |
| Resource release | Use `scancel` to cancel the specified managed job |
| First prototype | `gl-dev status`, querying a specified JobID from local WSL |

Verify default resources against the actual account and partition permissions. `24G` is CPU memory, not GPU memory.

## 2. Windows and VS Code

| Field | Actual value |
| --- | --- |
| Windows version | TODO |
| VS Code version | TODO |
| Remote - SSH extension version | TODO |
| Window type when initiating the connection (Windows local / WSL) | TODO |
| Active VS Code settings.json path | TODO |
| Absolute Windows path to the SSH wrapper | TODO |
| Whether and when VPN is required | TODO |

### SSH-related VS Code settings

Paste the settings currently working, including `remote.SSH.path`, `remote.SSH.configFile`, and any other configured SSH settings. Mark absent settings as “Not configured”; do not add settings just to complete this document.

```jsonc
// Current SSH-related settings from settings.json

  "remote.SSH.path": "C:\\Users\\11145\\.ssh\\wsl-ssh.bat",
  "remote.SSH.configFile": "\\\\wsl.localhost\\Ubuntu-22.04\\home\\jason\\.ssh\\config",
  "remote.SSH.useLocalServer": false,
  "remote.SSH.showLoginTerminal": true,
```

### Windows → WSL SSH wrapper

Preserve the actual argument forwarding and quoting so the prototype can reproduce the behavior.

```text
TODO: Full wrapper script contents, excluding credentials
```

## 3. WSL and SSH configuration

| Field | Actual value |
| --- | --- |
| WSL distribution name (Windows `wsl -l -v`) | TODO; the guide records Ubuntu-22.04, to be confirmed |
| WSL username | TODO |
| Absolute WSL home path | TODO |
| SSH executable (WSL `command -v ssh`) | TODO |
| SSH version (WSL `ssh -V`) | TODO |
| Absolute path of the SSH config actually read | TODO; the guide uses WSL `~/.ssh/config` |
| IdentityFile path (path only) | TODO |
| Whether ssh-agent is used and how keys are loaded | TODO |
| ControlPath and ControlPersist | TODO |

### Working SSH configuration fragment

Paste `gl-login`, `gl-compute`, and their shared settings and Include dependencies. A node name reflects one allocation and must not become a fixed setting.

```sshconfig
# Current local WSL configuration

Host gl-login
    HostName greatlakes.arc-ts.umich.edu
    User dingxuan
Host gl-compute
    HostName gl1504
    User dingxuan
    ProxyJump gl-login
Host gl-login gl-compute
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 30m
```

## 4. Cluster, resources, and project

| Field | Actual value |
| --- | --- |
| Login alias | `gl-login`, to be confirmed |
| Login endpoint | `greatlakes.arc-ts.umich.edu`, to be confirmed |
| SSH username | `dingxuan`, to be confirmed |
| Full Slurm account | `eecs442f26_class` (from the actual script below) |
| Partition | `spgpu`, permissions to be confirmed |
| GPU request | `--gres=gpu:1`, confirm whether a specific model is required |
| Nodes / tasks / CPUs | `--nodes=1 --ntasks=1 --cpus-per-task=4`, to be validated |
| CPU memory / runtime | `--mem=24G --time=03:00:00` (confirmed default and actual script) |
| Absolute remote project path | /home/dingxuan |
| Absolute remote allocation script path | `/home/dingxuan/vscode_gpu.sh` (based on the login user's home and the command below) |
| Working directory when submitting sbatch | TODO; affects relative log paths |
| Job log path or naming pattern | TODO; the guide uses `slurm-%j.out` |

### Verified allocation script

Paste the complete script actually used, preserving the `#SBATCH` parameters and `sleep infinity`.

```bash
# Actual remote vscode_gpu.sh contents
[dingxuan@gl-login1 ~]$ cat ~/vscode_gpu.sh
#!/bin/bash
#SBATCH --job-name=vscode-gpu
#SBATCH --account=eecs442f26_class
#SBATCH --partition=spgpu
#SBATCH --gres=gpu:1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
#SBATCH --time=03:00:00
#SBATCH --output=slurm-%j.out

sleep infinity
```

## 5. Okta and connection reuse

| Scenario | Interaction required, prompts, and actual steps |
| --- | --- |
| First `ssh gl-login` | TODO |
| Remote command over a reused connection | TODO |
| First `ssh -MNf gl-compute` | TODO |
| VS Code connection to gl-compute | TODO |
| After connection reuse expires | TODO |
| After a network or VPN interruption | TODO |

Record only authentication steps and prompt types, never passwords or verification codes.

## 6. Manual workflow verification record

The table below outlines the manual guide. Add actual commands, relevant output, and verification dates. Specify whether each step runs on Windows, in WSL, or on the login node.

| Step | Execution location | Command or action | Actual result / verification |
| --- | --- | --- | --- |
| Log in | Local WSL | `ssh gl-login` | TODO |
| Check existing jobs | Login node | `squeue -u "$USER"` | TODO |
| Request resources | Login node | `sbatch ~/vscode_gpu.sh` | TODO |
| Query node | Login node | `squeue -u "$USER" -o "%.18i %.14j %.10T %.10M %.10l %.20N"` | TODO |
| Update node settings | Local WSL | Change gl-compute HostName | TODO |
| Clear and establish connection reuse | Local WSL | Follow the guide: `ssh -O exit gl-compute`, `ssh -MNf gl-compute` | TODO |
| Verify connection | Local WSL | `ssh -O check gl-compute`, `ssh gl-compute hostname` | TODO |
| Open project | Windows VS Code | Connect to gl-compute with Remote SSH and open the remote directory | TODO |
| Verify GPU | VS Code remote terminal | `hostname`, `nvidia-smi` | TODO |
| Release resources | Login node | `scancel YOUR_JOB_ID`, then query again | TODO |

### One successful connection record

- Verification date: TODO
- JobID: TODO (verification record only, not a fixed setting)
- Compute node: TODO (verification record only, not a fixed setting)
- Project directory: TODO
- Submission and query output:

```text
TODO
```

## 7. Lifecycle and recovery verification

| Scenario | Expected behavior | Actual result / verification date |
| --- | --- | --- |
| Close SSH terminal after sbatch submission | Job continues queueing or running | TODO |
| Close and reopen VS Code | Query the original JobID first and reuse it if valid | TODO |
| Restore network / VPN after interruption | Query allocation status before reconnecting | TODO |
| Job remains pending | Display queue status; compute node connection is not yet available | TODO |
| Job expires or is cancelled | Detect invalid allocation and stop using the old node | TODO |
| SSH query fails | Report query failure without assuming the job has ended | TODO |
| Explicit scancel | Target job stops consuming resources | TODO |

### Common errors and verified recovery methods

```text
Symptom: TODO
Execution location and command: TODO
Error output (with sensitive information removed): TODO
Recovery method: TODO
```

## 8. First prototype: gl-dev status

Goal: Query a specified JobID from local WSL through the existing `gl-login`, without submitting or cancelling jobs or modifying SSH settings.

### Implementation inputs to complete

- Full command that successfully queries remotely from local WSL: TODO
- JobID used for validation: TODO
- Query output samples (pending, running, absent from queue): TODO
- Whether SSH / Okta interaction affects command output: TODO

### Acceptance checklist

- [ ] Query a specified JobID and display its state and allocated node.
- [ ] Distinguish pending, running, absent jobs, and SSH query failures.
- [ ] Do not infer an end reason from queue absence; query history when needed.
- [ ] Query the same JobID after closing and reopening the local terminal.
- [ ] Results match manually executed cluster queries.
- [ ] Query failures do not trigger new job submissions.

### Development validation record (2026-11-17)

- Implemented: run `node bin/gl-dev.js status <JobID>` from the repository root, with `--json`, `--host`, `--ssh-config`, and `--timeout` support.
- Real cluster: `66280825` returned `RUNNING`, node `gl1504`, and time limit `3:00:00`, matching the state and node from a direct squeue query.
- Old example JobID `66262642` returned `NOT_IN_QUEUE`; no specific end reason was inferred.
- All 12 local automated tests passed, including error classification, empty queues, pending jobs, output parsing, and remote shell exit-code propagation.
- These checks reused existing SSH authentication. Fresh Okta interaction, reopening terminals, real queueing, and disconnect recovery have not been verified, so the acceptance checklist remains pending confirmation.
- JobIDs, nodes, and states above are historical verification records. Use live queries for current status.

## 9. Open questions

Items that do not block the `status` prototype: the wrapper script is still missing; `/home/dingxuan` is the supplied opening directory, and whether to use a nano-vllm subdirectory can be confirmed when implementing automatic project opening; the default runtime is confirmed as 3 hours. The supplied script is preserved as provided.

- [ ] Complete the Windows SSH wrapper and VS Code settings.
- [ ] Confirm the WSL distribution and actual SSH configuration path.
- [ ] Confirm the full account, partition permissions, and default resource parameters.
- [ ] Confirm absolute remote project and allocation script paths.
- [ ] Record one successful connection.
- [ ] Verify querying a specified JobID over SSH from local WSL.

- Other: TODO.

## 10. Connect implementation

`gl-dev connect` reads the repository's `gl-dev.config.json`, with confirmed defaults of 1 GPU, 4 CPUs, 24G CPU memory, and 3 hours. It uses sbatch with `--wrap='sleep infinity'`, tracks its own allocations, and recovers pending/running jobs from persisted state. It does not adopt manual jobs. When the allocation is ready, it now updates gl-compute HostName in the local SSH configuration. See [README](../README.md#preparing-an-allocation-with-connect) for usage, recovery, and release instructions.

Local automated tests cover the connect lifecycle. Real submission, queue waiting, and Okta authentication require a manual end-to-end check; no new cluster resources were requested during development.

## 11. Stop implementation

`gl-dev stop` checks the saved managed allocation against the current remote user's queue, then cancels exactly that JobID with name and owner filters. Optional `--job-id` must match the saved/recovered job. Cancellation is confirmed by polling; state is retained on failures or while release is pending. Connect and stop share a lock and cannot mutate the same managed allocation concurrently. See [README](../README.md#releasing-an-allocation-with-stop).

The user has reported successful connect testing. Stop's local tests use simulated jobs; real cancellation has not been performed during development and remains to be verified with a disposable managed job.

## 12. gl-compute updates

Connect now updates the existing dedicated Host gl-compute block after obtaining a RUNNING node. It validates a candidate with local SSH and creates a backup before atomic replacement. The default file is WSL ~/.ssh/config; --ssh-config selects an alternate file, and --skip-ssh-update retains allocation-only behavior. Pending jobs do not trigger updates. Tests use temporary files and do not change the real local SSH configuration. See [README](../README.md#automatic-gl-compute-configuration-updates).

## 13. Minimal local VS Code extension

The prototype in vscode-extension adds one command, Great Lakes: Open gl-compute Project. It runs locally (extensionKind: ui), depends on Remote - SSH, and uses the existing SSH host and settings. It asks for the absolute project path on first use, stores it as greatLakes.projectPath, and requests a new remote window. It does not run connect/stop or edit SSH settings. A local VSIX has been packaged; real Windows connection validation remains pending. See [extension instructions](../vscode-extension/README.md).

## 14. Extension-to-CLI bridge

Version 0.2.0 adds Great Lakes: Connect and Open Project. The local Windows UI extension starts an interactive WSL terminal using the configured distribution/user, runs this repository's CLI with default config/state scope, then opens the project only after successful resource preparation and SSH update. The original Open command remains available. Development tests do not contact the cluster or interrupt existing tasks. See [extension README](../vscode-extension/README.md).

## 15. Dead CLI lock recovery

The reported legacy state lock contained PID 45567, which was no longer running. It was recovered locally after verification, without invoking SSH/Slurm, and saved job JSON was verified unchanged. Current state locking uses an OS flock guard, checks old PID markers, and recovers only confirmed dead owners. Tests include SIGKILL and competing recovery attempts. The 0.2.2 extension calls these updated repository sources directly; no VSIX update is required.

## 16. Compute authentication before opening Remote SSH

Version 0.2.3 adds the CLI --prepare-ssh flag to the extension bridge. Authentication takes place in the interactive WSL Connect terminal after the job and gl-compute are ready. The CLI requires a reusable SSH master, checks it and validates hostname before returning success to the extension. This avoids the unresponsive input prompt observed in Remote SSH's local install terminal. Tests are simulated; no actual cluster authentication or resource changes were performed during development.
