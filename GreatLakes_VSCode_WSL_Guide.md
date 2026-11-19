# Connecting to Great Lakes with WSL and VS Code: Daily sbatch Workflow

Environment: Windows VS Code → SSH in WSL Ubuntu-22.04 → Great Lakes compute node.

This guide builds on the working WSL SSH wrapper, VS Code settings, and SSH keys. It uses sbatch to request development resources. After successful submission, the submission terminal does not need to remain connected, and tmux is not required.

The first extension version follows this guide's `sbatch + sleep infinity` approach without `salloc`, uses Okta authentication, and defaults to `24G` CPU memory. Record actual settings in the [current workflow and configuration inventory](docs/current-workflow.md). See the [extension plan](GreatLakes_VSCode_Plugin_Plan.md) for the development roadmap.

## 1. Initial setup: Create the allocation script

### 1.1 Log in to Great Lakes from local WSL

Connect to the U-M VPN first if needed. In a local WSL terminal, run:

```bash
ssh gl-login
```

Complete password and Okta authentication as prompted.

### 1.2 Confirm the full Slurm resource account name

On the Great Lakes login node, run:

```bash
sacctmgr show assoc where user="$USER" \
  format=Cluster,Account%50,User,Partition,QOS%40
```

Read the Account column. `--account` takes the resource account, not the SSH username `dingxuan`. The wider columns prevent account names from being truncated. Do not copy a potentially truncated account name from ordinary squeue output into the script.

You can also check the account used by a previously successful job:

```bash
sacct -j 66262642 --format=JobID,Account%50,Partition,State
```

This JobID is an example from the recorded session. Replace it with one of your own successful JobIDs in the future.

### 1.3 Create the sbatch script

On the Great Lakes login node, run:

```bash
nano ~/vscode_gpu.sh
```

Paste the following, replacing `YOUR_ACCOUNT` with the full account name confirmed above. Adjust other resource parameters to your permissions and needs. This example uses the spgpu partition that has already worked successfully.

```bash
#!/bin/bash
#SBATCH --job-name=vscode-gpu
#SBATCH --account=YOUR_ACCOUNT
#SBATCH --partition=spgpu
#SBATCH --gres=gpu:1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
#SBATCH --time=03:00:00
#SBATCH --output=slurm-%j.out

echo "Job ID: $SLURM_JOB_ID"
echo "Compute node: $(hostname)"
echo "Started: $(date)"

# Retain the development allocation until the time limit or explicit cancellation
sleep infinity
```

Press `Ctrl+O`, then Enter to save, and `Ctrl+X` to exit.

- `--mem=24G` requests CPU memory, not GPU memory.
- `--time=03:00:00` is the runtime limit; queueing time does not count toward runtime.
- `sleep infinity` keeps the job alive without bypassing Slurm's time limit.
- This script requests and retains development resources. Run project commands later in the VS Code terminal on the compute node.
- `sbatch ~/vscode_gpu.sh` does not require executable permission on the script; no extra chmod is needed.

Create the script once and submit it repeatedly. Edit it when the account, resources, or runtime needs to change.

## 2. Starting a work session

### 2.1 Log in and check for existing resources

In local WSL, run:

```bash
ssh gl-login
```

On the login node, check:

```bash
squeue -u "$USER"
```

If a usable vscode-gpu job already exists, use its node instead of submitting another request.

### 2.2 Submit a resource request

On the Great Lakes login node, run:

```bash
sbatch ~/vscode_gpu.sh
```

Successful submission returns something like:

```text
Submitted batch job 66262642
```

Record the JobID. Successful submission does not mean resources have been allocated yet. Continue checking status:

```bash
squeue -u "$USER" -o "%.18i %.14j %.10T %.10M %.10l %.20N"
```

| Field or state | Meaning |
| --- | --- |
| JOBID | Job identifier used for queries and cancellation |
| PENDING / PD | Queued; the compute node is not yet available for connection |
| RUNNING / R | Resources allocated and job running |
| TIME | Elapsed runtime |
| TIME_LIMIT | Requested runtime limit |
| NODELIST | Compute node for this allocation |

The recorded successful session used JobID `66262642` and node `gl1527`. These are examples only. Use the actual squeue output each time; do not hardcode gl1525 or gl1527.

**After successful sbatch submission, you can close the submission SSH terminal. The job continues queueing or running.**

### 2.3 Update the node in local WSL settings

Open another local WSL terminal and run:

```bash
nano ~/.ssh/config
```

Find the existing `gl-compute` entry and change HostName to the allocated node, for example:

```sshconfig
Host gl-login
    HostName greatlakes.arc-ts.umich.edu
    User dingxuan

Host gl-compute
    HostName gl1527
    User dingxuan
    ProxyJump gl-login

Host gl-login gl-compute
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 30m
```

Preserve existing working settings such as IdentityFile. Modify existing entries instead of adding duplicates.

**Edit `~/.ssh/config` in local WSL, not the file of the same name on Great Lakes.** The SSH user remains dingxuan; do not replace it with the resource account.

### 2.4 Clear the old connection and establish SSH connection reuse

First close the old VS Code remote connection. In local WSL, run:

```bash
ssh -O exit gl-compute
```

This closes the matching SSH master connection. If it reports that no connection exists, continue. Because the configuration uses `%C`, changing HostName can give the old and new nodes different control sockets. An old node connection may remain temporarily, but this does not change Slurm job status.

Establish the connection to the allocated node:

```bash
ssh -MNf gl-compute
```

Complete password, Okta, or private key passphrase prompts as needed. Returning to the local prompt without opening a remote shell is expected on success.

Check:

```bash
ssh -O check gl-compute
ssh gl-compute hostname
```

The first command should display `Master running (pid=...)`. The second should return the allocated node, such as gl1527.

VS Code then reuses the authenticated connection through the previously configured Windows → WSL setup.

### 2.5 Connect from VS Code and open the project

Press `Ctrl+Shift+P`, then select:

```text
Remote-SSH: Connect to Host... → gl-compute
```

After connecting, choose File → Open Folder and open the remote repository. If cloned into your home directory, it is typically:

```text
/home/dingxuan/nano-vllm
```

If stored under projects or elsewhere, use the path reported by remote `pwd`.

In the VS Code remote terminal, run:

```bash
hostname
nvidia-smi
```

Confirm the node and GPU, then load the required modules and activate your existing Python environment. For Python debugging, use `Python: Select Interpreter` to select the remote environment.

The repository and Python environment in home persist across node changes; you do not need to clone or install them each time. The remote repository and local WSL repository are separate copies. Do not store files you need to keep in the compute node's local `/tmp`.

## 3. Recovering after a disconnect

### 3.1 Recheck job status

After restoring the network or VPN, log in from local WSL:

```bash
ssh gl-login
```

On the login node, query:

```bash
squeue -u "$USER"
```

- If the original job is still R / RUNNING, keep using its node; no new sbatch submission is needed.
- If the job has ended, submit another request and update HostName in local WSL.

To investigate why a job ended:

```bash
sacct -u "$USER" -S today \
  --format=JobID,JobName,State,Elapsed,Timelimit,ExitCode,NodeList
```

| State | Meaning |
| --- | --- |
| COMPLETED | Job ended normally; this state alone does not identify the specific end reason |
| TIMEOUT | Runtime limit reached |
| CANCELLED | Job cancelled |
| OUT_OF_MEMORY | Allocated memory limit exceeded |
| FAILED | Job exited abnormally |
| NODE_FAIL | Node failure |

### 3.2 Restore the local connection

In local WSL, run:

```bash
ssh -O check gl-compute
ssh gl-compute hostname
```

If the old connection is stale, clear and rebuild it:

```bash
ssh -O exit gl-compute
ssh -MNf gl-compute
```

Then reconnect to gl-compute from VS Code.

**An active allocation does not guarantee that every program started in a VS Code terminal survives a disconnect.** Here, sbatch protects the resource allocation. For long experiments that must finish reliably, put the actual Python commands, environment setup, and log output into a separate sbatch script.

## 4. Releasing resources when finished

Save files, stop running experiments, and close the VS Code remote connection. In any available Great Lakes login-node terminal, run the following with the actual JobID:

```bash
scancel YOUR_JOB_ID
squeue -u "$USER"
```

Confirm the job is no longer running. To also close the local SSH master connection, run in local WSL:

```bash
ssh -O exit gl-compute
```

Closing VS Code, exiting SSH, or suspending the computer does not cancel this sbatch job. Idle allocations still consume resources, so run scancel when finished. Slurm ends the job and releases resources when the time limit is reached.

## 5. Troubleshooting

| Symptom | Action |
| --- | --- |
| Invalid account or account/partition combination | Query the full account name and confirm account/partition permissions; avoid truncated names |
| PD / PENDING in squeue | Wait; a compute node has not yet been allocated |
| Unknown new hostname | Read NODELIST in squeue, such as gl1527 in the example |
| VS Code still connects to the old node | Close the old remote window, check HostName in local WSL, and confirm `ssh gl-compute hostname` |
| Connection stalls after password entry | First run `ssh -MNf gl-compute` in a separate WSL terminal to authenticate, then connect VS Code |
| OTP authentication failed | Distinguish the login password from the Okta code and authenticate again |
| Permission denied (publickey) | Run `ssh -vv gl-compute` in WSL to inspect key selection; do not share private keys |
| VS Code disconnected | Check squeue first; reconnect if the job is still active instead of submitting again |
| Job running but GPU unavailable | Confirm hostname matches the allocated compute node, check the GPU request, and inspect nvidia-smi output |
| Need script logs | By default, logs are in the sbatch submission working directory as slurm-JOBID.out |

## 6. Daily quick reference

1. Local WSL: `ssh gl-login`.
2. Login node: `squeue -u "$USER"`; run `sbatch ~/vscode_gpu.sh` if no usable job exists.
3. Login node: wait for RUNNING and record JobID and NODELIST.
4. Local WSL: update gl-compute HostName in `~/.ssh/config`.
5. Local WSL: `ssh -MNf gl-compute`, then verify with `ssh gl-compute hostname`.
6. VS Code: connect to gl-compute, open the project, and activate the environment.
7. When finished: run `scancel YOUR_JOB_ID` on Great Lakes.

Core workflow: **sbatch allocation → node query → WSL configuration update → SSH connection → VS Code development → scancel release.**

## References

- [Slurm: sbatch](https://slurm.schedmd.com/sbatch.html)
- [U-M: Visual Studio Code and compute-node SSH connections](https://documentation.its.umich.edu/arc-hpc/open-ondemand/vs-code)
- [U-M: Great Lakes partition policies](https://documentation.its.umich.edu/arc-hpc/greatlakes/policies)
- [U-M: Job status queries](https://documentation.its.umich.edu/node/4987)
- [VS Code: Remote SSH](https://code.visualstudio.com/docs/remote/ssh)
