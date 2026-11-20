import { createHash } from 'node:crypto';
import { shellQuote } from './ssh.js';

// Replaying this command for the same request cannot invoke sbatch twice.
// The remote lock covers both checking the receipt and writing the result.
export function buildRecordedSubmission(config, name, submitCommand, { probeOnly = false } = {}) {
  if (!/^gldev-[a-f0-9]{24}$/.test(name)) throw new Error('Invalid recorded submission name.');
  const fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const receiptScript = [
    'umask 077',
    'export LC_ALL=C',
    'cd "$HOME" || exit 1',
    'gl_root="$HOME/.local/state/easy-greatlakes/requests"',
    `gl_dir="$gl_root/${name}"`,
    'mkdir -p -- "$gl_dir" || exit 1',
    '[ ! -L "$gl_dir" ] && [ ! -L "$gl_dir/lock" ] && [ ! -L "$gl_dir/status" ] && [ ! -L "$gl_dir/config" ] || exit 1',
    'exec 9>"$gl_dir/lock" || exit 1',
    'flock --nonblock 9 || { echo "Submission is still running; retry Connect later." >&2; exit 75; }',
    'if [ -e "$gl_dir/config" ]; then',
    `  [ "$(cat "$gl_dir/config")" = ${shellQuote(fingerprint)} ] || { echo "Submission config mismatch." >&2; exit 1; }`,
    'else',
    `  printf '%s\n' ${shellQuote(fingerprint)} > "$gl_dir/config.tmp" && mv -- "$gl_dir/config.tmp" "$gl_dir/config" || exit 1`,
    'fi',
    'if [ -e "$gl_dir/status" ]; then',
    '  gl_status=$(cat "$gl_dir/status") || exit 1',
    "  gl_accepted_pattern='^accepted ([1-9][0-9]*)$'",
    '  if [[ "$gl_status" =~ $gl_accepted_pattern ]]; then',
    '    printf "%s\n" "${BASH_REMATCH[1]}"; exit 0',
    '  fi',
    '  if [ "$gl_status" = rejected ]; then',
    '    printf "REJECTED\n"; cat "$gl_dir/rejection" || exit 1; exit 0',
    '  fi',
    ...(probeOnly ? ['  [ "$gl_status" = submitting ] && { printf "UNRESOLVED\n"; exit 0; }'] : []),
    '  echo "Submission may already have reached Slurm; inspect the queue/history by request name. Receipt retained." >&2; exit 76',
    'fi',
    ...(probeOnly ? ['printf "NOT_SUBMITTED\n"; exit 0'] : []),
  ];
  if (probeOnly) return `bash -c ${shellQuote(receiptScript.join('\n'))}`;
  const script = [
    ...receiptScript,
    // Persist intent BEFORE sbatch. An interrupted intent remains ambiguous; an
    // accepted receipt is written atomically BEFORE returning JobID over SSH.
    'printf "submitting\n" > "$gl_dir/status.tmp" && mv -- "$gl_dir/status.tmp" "$gl_dir/status" || exit 1',
    'gl_error=$(mktemp "$gl_dir/sbatch-error.XXXXXX") || exit 1',
    `if gl_job=$( ${submitCommand} 2>"$gl_error" ); then gl_exit=0; else gl_exit=$?; fi`,
    'cat "$gl_error" >&2',
    // Only explicit controller rejections are definitive. Transport errors and
    // unrecognized failures retain submitting intent and cannot be retried blindly.
    'if [ "$gl_exit" -ne 0 ] && [ -z "$gl_job" ] && grep -Eq "^sbatch: error: Batch job submission failed: (Job violates accounting/QOS policy|Invalid account or account/partition combination specified|Invalid partition name specified|Requested time limit is invalid|Requested node configuration is not available)" "$gl_error"; then',
    '  mv -- "$gl_error" "$gl_dir/rejection" || exit 1',
    '  printf "rejected\n" > "$gl_dir/status.tmp" && mv -- "$gl_dir/status.tmp" "$gl_dir/status" || exit 1',
    '  printf "REJECTED\n"; cat "$gl_dir/rejection"; exit 0',
    'fi',
    '[ "$gl_exit" -eq 0 ] || exit 76',
    '[[ "$gl_job" =~ ^[1-9][0-9]*$ ]] || { echo "Unexpected sbatch result; receipt retained." >&2; exit 76; }',
    'printf "accepted %s\n" "$gl_job" > "$gl_dir/status.tmp" && mv -- "$gl_dir/status.tmp" "$gl_dir/status" || exit 1',
    'printf "%s\n" "$gl_job"',
  ].join('\n');
  return `bash -c ${shellQuote(script)}`;
}
