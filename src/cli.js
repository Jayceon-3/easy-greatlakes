import { prepareComputeSsh } from './compute-ssh.js';
import { updateComputeHost } from './ssh-config.js';
import { stop } from './stop.js';
import { connect, readConnectConfig } from './connect.js';
import { parseArgs } from 'node:util';
import { queryStatus, validateOptions } from './status.js';

const HELP = `Great Lakes development tool (run in local WSL, Node.js >= 20)

Usage:
  gl-dev connect [--config gl-dev.config.json] [--no-wait] [--json] [--skip-ssh-update] [--prepare-ssh]
                 [--poll-interval 30] [--wait-timeout 1800] [--state-dir PATH]
  gl-dev stop [--job-id EXPECTED_ID] [--no-wait] [--json]
              [--poll-interval 15] [--wait-timeout 120] [--state-dir PATH]
  gl-dev status <JobID> [--host gl-login] [--json] [--timeout 120]
                       [--ssh-config /absolute/path/to/config]

Examples:
  npm run gl-dev -- connect
  npm run gl-dev -- status 66262642
  node bin/gl-dev.js status 66262642 --json

Query the current user's Slurm queue using existing SSH settings and normal Okta authentication.
--timeout limits each SSH operation in seconds, including authentication (default: 120).
connect submits/reuses a managed job, waits for its node, and updates gl-compute HostName.
--prepare-ssh authenticates the compute node in the current terminal before Remote SSH opens.
The SSH update uses --ssh-config or ~/.ssh/config, with validation and a backup. VS Code is not opened yet.
stop cancels only the saved managed job, after checking its ID, name, and remote owner.
status only queries ordinary integer JobIDs. stop and status do not modify SSH settings.
Ctrl+C stops waiting and retains the job. Use gl-dev stop to release the managed allocation.
Exit codes: 0 = command succeeded (check released/ready fields); 1 = operation failed; 2 = invalid arguments; 130 = interrupted.`;

export function main(argv, { query = queryStatus, runConnect = connect, runStop = stop, updateSsh = updateComputeHost, prepareSsh = prepareComputeSsh, out = console.log, err = console.error } = {}) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', default: 'gl-dev.config.json' },
        'no-wait': { type: 'boolean', default: false },
        'poll-interval': { type: 'string' },
        'wait-timeout': { type: 'string' },
        'prepare-ssh': { type: 'boolean', default: false },
        'skip-ssh-update': { type: 'boolean', default: false },
        'job-id': { type: 'string' },
        'state-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        host: { type: 'string', default: 'gl-login' },
        json: { type: 'boolean', default: false },
        timeout: { type: 'string', default: '120' },
        'ssh-config': { type: 'string' },
      },
    }));
    if (values.help || argv.length === 0) {
      out(HELP);
      return 0;
    }
    if (values['prepare-ssh'] && (positionals[0] !== 'connect' || values['skip-ssh-update'])) throw new Error('--prepare-ssh requires connect with SSH updates enabled.');
    if (values['skip-ssh-update'] && positionals[0] !== 'connect') throw new Error('--skip-ssh-update is only supported by connect.');
    if (values['job-id'] && positionals[0] !== 'stop') throw new Error('--job-id is only supported by stop.');
    if (positionals[0] === 'stop') {
      if (positionals.length !== 1) throw new Error('Usage: gl-dev stop [options].');
      validateOptions({ jobId: values['job-id'] ?? '1', host: values.host, timeout: Number(values.timeout) });
      const pollInterval = Number(values['poll-interval'] ?? '15');
      const waitTimeout = Number(values['wait-timeout'] ?? '120');
      if (!Number.isInteger(pollInterval) || pollInterval < 15 || pollInterval > 300) throw new Error('Poll interval must be 15 to 300 seconds.');
      if (!Number.isInteger(waitTimeout) || waitTimeout < 0 || waitTimeout > 86400) throw new Error('Wait timeout must be 0 to 86400 seconds.');
      return finishManaged('stop', {
        host: values.host, timeout: Number(values.timeout), sshConfig: values['ssh-config'],
        expectedJobId: values['job-id'], noWait: values['no-wait'], stateDir: values['state-dir'], pollInterval, waitTimeout,
      }, values.json, { run: runStop, out, err });
    }
    if (positionals[0] === 'connect') {
      if (positionals.length !== 1) throw new Error('Usage: gl-dev connect [options].');
      const config = readConnectConfig(values.config);
      validateOptions({ jobId: '1', host: values.host, timeout: Number(values.timeout) });
      const pollInterval = Number(values['poll-interval'] ?? '30');
      const waitTimeout = Number(values['wait-timeout'] ?? '1800');
      if (!Number.isInteger(pollInterval) || pollInterval < 15 || pollInterval > 300) throw new Error('Poll interval must be 15 to 300 seconds.');
      if (!Number.isInteger(waitTimeout) || waitTimeout < 0 || waitTimeout > 86400) throw new Error('Wait timeout must be 0 to 86400 seconds.');
      return finishManaged('connect', {
        config, prepareSsh: values['prepare-ssh'], skipSshUpdate: values['skip-ssh-update'], host: values.host, timeout: Number(values.timeout), sshConfig: values['ssh-config'],
        noWait: values['no-wait'], stateDir: values['state-dir'], pollInterval, waitTimeout,
      }, values.json, { run: runConnect, updateSsh, prepareSsh, out, err });
    }
    if (positionals.length !== 2 || positionals[0] !== 'status') {
      throw new Error('Usage: gl-dev status <JobID>; use --help for details.');
    }
    // Validate before invoking even an injected query implementation.
    validateOptions({ jobId: positionals[1], host: values.host, timeout: Number(values.timeout) });
  } catch (error) {
    err(`Invalid arguments: ${error.message}`);
    return 2;
  }
  try {
    const result = query({
      jobId: positionals[1], host: values.host, timeout: Number(values.timeout),
      sshConfig: values['ssh-config'],
    });
    if (values.json) {
      out(JSON.stringify(result, null, 2));
    } else {
      out(`Job ID: ${result.jobId}\nState: ${result.state}\nNode: ${result.node ?? '—'}`);
      if (result.found) {
        out(`Elapsed: ${result.elapsed}\nTime limit: ${result.timeLimit}\nTime left: ${result.timeLeft}\nReason: ${result.reason}`);
      } else out(result.note);
    }
    return 0;
  } catch (error) {
    if (values.json) err(JSON.stringify({ error: { code: error.code ?? 'UNKNOWN_ERROR', message: error.message } }));
    else err(`Query failed: ${error.message}`);
    return 1;
  }
}

async function finishManaged(action, options, json, { run, updateSsh, prepareSsh, out, err }) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const result = await run({ ...options, signal: controller.signal }, { progress: err });
    if (action === 'connect' && result.ready && !options.skipSshUpdate) {
      try {
        result.sshConfigUpdate = updateSsh({ node: result.node, sshConfig: options.sshConfig });
        err(`gl-compute now targets ${result.node}. Config: ${result.sshConfigUpdate.path}`);
        if (result.sshConfigUpdate.backupPath) err(`SSH configuration backup: ${result.sshConfigUpdate.backupPath}`);
      } catch (error) {
        error.code = 'SSH_CONFIG_UPDATE_FAILED';
        error.message = `Job ${result.jobId} remains allocated on ${result.node}. SSH configuration update failed: ${error.message} Rerun connect after fixing the configuration; it will reuse the managed job.`;
        throw error;
      }
    }
    if (action === 'connect' && result.ready && options.prepareSsh) {
      try {
        result.computeSsh = prepareSsh({ ...options, node: result.node }, { progress: err });
      } catch (error) {
        error.message = `Job ${result.jobId} remains allocated on ${result.node}. ${error.message}`;
        throw error;
      }
    }
    if (json) out(JSON.stringify(result, null, 2));
    else {
      out(`Job ID: ${result.jobId}\nState: ${result.state}\nNode: ${result.node ?? '—'}`);
      if (action === 'stop') out(result.released ? 'No managed allocation remains in the queue.' : 'Cancellation requested; release is not confirmed yet. Rerun stop to verify.');
      else out(result.ready ? (options.skipSshUpdate ? 'Allocation ready. SSH update skipped.' : 'Allocation ready. gl-compute updated; connect with Remote SSH.') : 'Allocation pending. Rerun connect to resume waiting.');
    }
    return 0;
  } catch (error) {
    if (json) err(JSON.stringify({ error: { code: error.code ?? `${action.toUpperCase()}_FAILED`, message: error.message } }));
    else err(`${action} failed: ${error.message}`);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
