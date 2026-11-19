import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export class QueryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function runRemote(options, script, execute = spawnSync) {
  const { host, timeout, sshConfig } = options;
  const marker = `GLDEV_${randomUUID().replaceAll('-', '')}`;
  const command = [
    `printf '\\n${marker}_BEGIN\\n'`,
    script,
    'gl_query_status=$?',
    `printf '\\n${marker}_END\\n'`,
    'exit "$gl_query_status"',
  ].join('; ');
  const args = ['-T', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1'];
  if (sshConfig) args.push('-F', sshConfig);
  args.push(host, command);
  const result = execute('ssh', args, {
    encoding: 'utf8',
    // Preserve the terminal for normal password/Okta authentication.
    stdio: ['inherit', 'pipe', 'inherit'],
    timeout: timeout * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new QueryError('TIMEOUT', 'Query timed out; job status could not be determined. Complete SSH/Okta login and retry, or increase --timeout.');
    }
    if (result.error.code === 'ENOENT') {
      throw new QueryError('SSH_NOT_FOUND', 'ssh was not found. Run this command in local WSL with SSH configured.');
    }
    throw new QueryError('EXECUTION_FAILED', `Query process failed; job status could not be determined: ${result.error.message}`);
  }
  if (result.signal || result.status === null) {
    throw new QueryError('INTERRUPTED', 'Query interrupted; job status could not be determined.');
  }
  if (result.status !== 0) {
    throw new QueryError(result.status === 255 ? 'SSH_FAILED' : 'QUERY_FAILED',
      result.status === 255
        ? 'SSH connection or authentication failed; job status could not be determined. Check the SSH messages above, VPN, and Okta login.'
        : `Remote query failed (exit code ${result.status}); job status could not be determined. Check the error messages above.`);
  }
  const output = result.stdout ?? '';
  const lines = output.split(/\r?\n/).map(line => line.trim());
  const start = lines.indexOf(`${marker}_BEGIN`);
  const end = lines.indexOf(`${marker}_END`);
  if (start < 0 || end <= start) {
    throw new QueryError('INVALID_OUTPUT', 'Incomplete remote output; the operation result is unknown.');
  }
  return { output, marker, body: lines.slice(start + 1, end).filter(Boolean).join('\n') };
}

export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}
