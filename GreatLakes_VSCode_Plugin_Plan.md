# Great Lakes Connection Automation Extension Plan

Date: 2026-11-17  
Status: The `gl-dev status` CLI has queried the real cluster successfully. The user has verified the `gl-dev connect` allocation prototype. The `gl-dev stop` prototype is implemented with local automated tests; real cancellation remains to be verified. Connect now updates the existing gl-compute HostName with validation and backup. Dedicated extension-owned configuration fragments remain a future refinement. The local UI extension now includes a WSL bridge to the existing connect CLI (version 0.2.0), as well as the original Open command: it opens a configured gl-compute project in a new Remote SSH window. Command behavior has local API-mock tests; real Windows/WSL connection validation remains pending. The resource allocation approach for the first version is confirmed.

## 1. Project goal

Automate the repetitive steps required to connect Windows, WSL, SSH, Slurm, and VS Code to Great Lakes GPU compute nodes, ultimately delivering an installable VS Code extension.

Build on the working manual workflow to handle resource allocation, node discovery, SSH configuration updates, remote project opening, and job status management through a single entry point for daily remote development.

## 2. Current workflow and problems

The current workflow consists of:

1. Preparing SSH settings in Windows and WSL.
2. Connecting to a Great Lakes login node and authenticating as needed.
3. Requesting GPUs, CPUs, memory, and runtime with Slurm `sbatch`, using `sleep infinity` in the script to retain the development allocation.
4. Waiting for allocation and discovering the actual compute node, such as `glXXXX`.
5. Updating the SSH configuration for `gl-compute`.
6. Connecting VS Code to the compute node and opening the project directory.
7. Checking job validity and handling disconnects, expiration, and resource release.

The main problems are scattered steps, changing node addresses, confusion between Windows and WSL configurations, and difficulty tracking connection and allocation status together.

## 3. Intended user experience

1. Run “Connect to Great Lakes GPU” in VS Code.
2. Select a saved resource preset, defaulting to `nano-vllm: 1 GPU / 4 CPUs / 24G CPU memory / 3 hours`.
3. The extension checks prerequisites and guides the user through login and Okta authentication when needed.
4. Check for valid jobs managed by the extension, preferring compatible existing allocations.
5. Submit a request if no allocation can be reused, and display queue status.
6. Once allocated, discover the node, update extension-managed SSH settings, and open the remote project.
7. Show the JobID, node, and remaining time in the status bar, with actions for reconnecting, viewing logs, and releasing resources.

These resource parameters illustrate the interface. The actual account, partition, GPU type, and allowed runtime must follow the user's current cluster configuration.

## 4. First-version scope

The first version covers only the environment already working manually:

- Windows + WSL + VS Code.
- The Great Lakes cluster.
- Development on a single GPU node.
- One nano-vllm project directory and a small number of resource presets.
- Continued use of SSH, Slurm, and VS Code Remote SSH.
- Resource allocation and retention using `sbatch + sleep infinity`, without `salloc`.
- Okta authentication and a default CPU memory request of `24G`, using `#SBATCH --mem=24G`.

Multiple clusters, complex scheduling, training job management, and automatic Python/CUDA/FlashAttention installation are outside the initial scope. Development environment installation can be considered separately later.

## 5. Feature design

| Module | Responsibility | First-version behavior |
| --- | --- | --- |
| Initial configuration | Store username, login endpoint, account, project directory, etc. | Reuse saved settings and prompt for missing fields |
| Environment checks | Identify where SSH runs and which settings it reads | Check WSL, SSH, required settings, and login reachability |
| Resource presets | Manage GPUs, CPUs, memory, and runtime | Provide an editable default preset |
| Job management | Request, query, reuse, and cancel allocations | Save JobIDs and avoid duplicate requests |
| Node discovery | Obtain the actual compute node from job status | Update the target node for `gl-compute` after allocation |
| SSH configuration management | Maintain extension-owned configuration fragments | Separate fragments, backups, and rollback; preserve other hosts |
| VS Code connection | Open the project on the compute node | Reuse Remote SSH; prototype the invocation mechanism first |
| Status and logs | Display queueing, connection, expiration, and errors | Status bar, output logs, and manual refresh |
| Resource release | Stop extension-managed jobs | Clearly show the target job before cancellation |

## 6. Architecture

Use three layers:

| Layer | Responsibility | Implementation direction |
| --- | --- | --- |
| VS Code interface | Commands, resource selection, status bar, logs | VS Code extension in TypeScript |
| Orchestration | Connection flow, state recovery, configuration updates | Start with a standalone CLI prototype |
| Underlying tools | Remote execution, scheduling, remote development | WSL, SSH, Slurm, Remote SSH |

The orchestration layer should be independently verifiable so errors can be diagnosed outside the extension UI. The CLI can initially use a familiar language; decide whether to retain a separate program or integrate it into TypeScript during the extension phase.

The extension should run where it can access Windows/WSL and local SSH settings. Verify extension placement in local, WSL, and remote windows so configuration management does not accidentally run on the compute node.

## 7. Key design questions

### 7.1 Windows and WSL boundary

Record the SSH executable, WSL distribution, configuration files, key paths, and jump-host setup used by the working workflow. Preserve this verified route and avoid overwriting settings between Windows and WSL.

### 7.2 Job lifecycle

The first version follows the working `sbatch + sleep infinity` workflow in the manual guide. Slurm manages the job after submission, while `sleep infinity` retains the allocation until the time limit, explicit cancellation, or an abnormal termination. The submission terminal does not need to remain connected. Do not use `salloc`.

The first phase should verify:

- Submitted jobs remain queryable and continue queueing or running after closing the submission terminal or VS Code.
- State can be recovered from a JobID after restarting the extension.
- Allocation validity can be checked and connections restored after a network interruption.
- Stale state is cleared after expiration, cancellation, or failure.

By default, keep valid jobs until expiration after closing a window. Provide an explicit “Release Resources” action using `scancel` for the extension-managed target job. Explain in the UI that closing a window does not release resources, and verify closing, restarting, and reconnecting during implementation. Retaining an allocation does not guarantee that every program started in a VS Code terminal survives disconnection.

### 7.3 Track connection and allocation status separately

An SSH disconnect does not necessarily mean the Slurm job has ended. On recovery, query job validity first; reconnect if valid, otherwise prompt for a new allocation. A failed connection alone must not automatically trigger a new job submission.

### 7.4 Store configuration and runtime state separately

| Type | Examples |
| --- | --- |
| Persistent configuration | Login endpoint, username, WSL distribution, account, resource presets (default CPU memory 24G), project directory |
| Runtime state | JobID, node, queue status, expected end time, last query result |

Cluster query results are the source of truth for job status; local records are recovery hints. Do not write passwords, Okta codes, or private key contents to ordinary configuration files or logs.

### 7.5 Authentication and query frequency

Preserve normal interactive authentication so users can complete Okta. Use reasonable polling intervals and backoff to avoid frequent requests to the Slurm controller. Stop rapid retries after connection failures and provide a manual recovery action.

## 8. Development roadmap

### Phase 1: Document the working workflow

- Record the actual SSH, WSL, and VS Code settings.
- Record working resource request commands and connection methods.
- Separate initial setup from steps needed for every connection.
- Collect successful output, common errors, and recovery methods.

Deliverable: [Current workflow and configuration inventory](docs/current-workflow.md), including reproducible steps, configuration fields, and items still needing validation.

### Phase 2: CLI prototype

Implement `gl-dev status` first to validate querying a specific JobID from local WSL through `gl-login`. Distinguish pending, running, absent jobs, and SSH query failures. A failed query must not be treated as evidence that a job has ended.

Then complete the three core commands (tentative names):

```text
gl-dev connect    Check or request resources, discover the node, prepare the remote connection
gl-dev status     Query the managed job and node status
gl-dev stop       Release managed resources
```

Prioritize allocation reuse, configuration updates, disconnect recovery, and explicit release. Once the Remote SSH launch mechanism is confirmed, add automatic project opening to `connect`.

Deliverable: a CLI that can be used repeatedly in the current personal environment.

### Phase 3: VS Code extension

- Add command palette entries and resource preset selection.
- Add status bar information, queue progress, and output logs.
- Integrate the verified orchestration workflow.
- Provide reconnect and resource release actions.
- Package a `.vsix` for personal installation and use.

Deliverable: an installable extension for personal use.

### Phase 4: Stability and broader use

Collect failures during daily use and improve timeouts, recovery, configuration conflict handling, and error messages. Once the personal workflow is stable, consider multiple projects, more presets, other operating systems, and other Slurm clusters.

## 9. First-version acceptance criteria

- [ ] After initial setup, connecting requires no manual compute-node name changes.
- [ ] The workflow proceeds from allocation request to opening the remote project in VS Code.
- [ ] Repeated connection requests reuse compatible valid jobs.
- [ ] Pending requests can be queried and cancelled.
- [ ] Valid jobs can be identified and reconnected after an SSH disconnect.
- [ ] Previously saved jobs are rechecked after restarting the extension or VS Code.
- [ ] Expired allocations are detected and stale nodes are no longer used.
- [ ] The correct extension-managed job can be released.
- [ ] SSH updates preserve other hosts and can be rolled back.
- [ ] Authentication, configuration, and connection errors have clear logs and messages.

Validate these with real connections, disconnect recovery, and cancellation scenarios. A complex test framework is not required at the start.

## 10. Next steps

Complete [docs/current-workflow.md](docs/current-workflow.md) using the successful manual setup as the baseline. Record the Windows → WSL SSH wrapper, VS Code settings, actual paths, and resource account. Resource allocation uses `sbatch + sleep infinity`, authentication uses Okta, and default CPU memory is `24G`.

The implementation sequence is the `gl-dev status` CLI prototype, followed by the full allocation → retention → node discovery → reconnection → release workflow, and finally the extension UI.

## 11. References

- [VS Code Remote SSH documentation](https://code.visualstudio.com/docs/remote/ssh)
- [VS Code remote extension development guide](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [Slurm sbatch documentation](https://slurm.schedmd.com/sbatch.html)
- [Slurm squeue documentation](https://slurm.schedmd.com/squeue.html)

These references describe the underlying tools. Actual Great Lakes settings, permitted development workflows, and extension integration details still require verification during implementation.
