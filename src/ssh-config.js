import { readFileSync, writeFileSync, statSync, chmodSync, realpathSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function directive(line) {
  const match = line.match(/^(\s*)([A-Za-z][A-Za-z0-9]*)(\s*=\s*|\s+)(.*)$/);
  if (!match) return null;
  let quoted = false, comment = -1;
  for (let i = 0; i < match[4].length; i++) {
    if (match[4][i] === '"') quoted = !quoted;
    if (match[4][i] === '#' && !quoted) { comment = i; break; }
  }
  if (quoted) throw new Error('Unterminated quote in SSH configuration.');
  const raw = comment < 0 ? match[4] : match[4].slice(0, comment);
  return { indent: match[1], keyword: match[2], separator: match[3], value: raw.trim(),
    suffix: comment < 0 ? raw.slice(raw.trimEnd().length) : match[4].slice(raw.trimEnd().length) };
}

export function replaceComputeHostname(text, node) {
  if (!/^gl[0-9]+$/.test(node)) throw new Error('Expected a Great Lakes compute node such as gl1504.');
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const item = directive(lines[i].replace(/\r?\n$/, ''));
    if (item && /^(host|match)$/i.test(item.keyword)) headers.push({ index: i, ...item });
  }
  const blocks = headers.filter(item => item.keyword.toLowerCase() === 'host' && /^(gl-compute|"gl-compute")$/.test(item.value));
  if (blocks.length !== 1) throw new Error('Expected exactly one dedicated Host gl-compute block in this file. Includes, shared blocks, and duplicate definitions require manual setup.');
  const block = blocks[0];
  const end = headers.find(item => item.index > block.index)?.index ?? lines.length;
  const hostnames = [];
  for (let i = block.index + 1; i < end; i++) {
    const item = directive(lines[i].replace(/\r?\n$/, ''));
    if (item?.keyword.toLowerCase() === 'hostname') hostnames.push({ index: i, ...item });
  }
  if (hostnames.length > 1) throw new Error('Duplicate HostName directives in Host gl-compute; resolve them before updating.');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (hostnames.length) {
    const item = hostnames[0];
    const ending = lines[item.index].endsWith('\r\n') ? '\r\n' : lines[item.index].endsWith('\n') ? '\n' : '';
    lines[item.index] = `${item.indent}${item.keyword}${item.separator}${node}${item.suffix}${ending}`;
  } else {
    if (!lines[block.index].endsWith('\n')) lines[block.index] += newline;
    lines.splice(block.index + 1, 0, `    HostName ${node}${newline}`);
  }
  return lines.join('');
}

export function validateSshConfig(path, node, execute = spawnSync) {
  const result = execute('ssh', ['-G', '-T', '-F', path, 'gl-compute'], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], timeout: 10000,
    killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('ssh -G could not validate the candidate configuration. Original configuration was preserved.');
  const hostname = result.stdout.match(/^hostname\s+(\S+)\s*$/m)?.[1];
  if (hostname !== node) throw new Error('Another SSH directive overrides gl-compute HostName. Original configuration was preserved.');
}

export function updateComputeHost({ node, sshConfig }, { validate = validateSshConfig } = {}) {
  const requestedPath = sshConfig ?? join(homedir(), '.ssh/config');
  // Resolve symlinks so atomic replacement updates the target, not the link.
  const path = realpathSync(requestedPath);
  const lockPath = `${path}.gl-dev.lock`;
  const lock = openSync(lockPath, 'wx', 0o600);
  const temporary = join(dirname(path), `.gl-dev-config-${randomUUID()}`);
  let backupPath;
  try {
    writeFileSync(lock, String(process.pid));
    const original = readFileSync(path, 'utf8');
    const mode = statSync(path).mode & 0o777;
    const updated = replaceComputeHostname(original, node);
    writeFileSync(temporary, updated, { flag: 'wx', mode });
    chmodSync(temporary, mode);
    validate(temporary, node);
    if (updated === original) return { path, changed: false, node, backupPath: null };
    if (readFileSync(path, 'utf8') !== original) throw new Error('SSH configuration changed during validation. Retry; original configuration was preserved.');
    backupPath = `${path}.gl-dev-backup-${randomUUID()}`;
    writeFileSync(backupPath, original, { flag: 'wx', mode });
    chmodSync(backupPath, mode);
    renameSync(temporary, path);
    return { path, changed: true, node, backupPath };
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
