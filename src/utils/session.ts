import crypto from 'crypto';

/**
 * Single shared session identifier for the current process. Generated once
 * on first use and reused by every observability subsystem (audit log,
 * telemetry, miss-path tracker) so that entries from the same process can
 * be cross-referenced by `session` field.
 *
 * Prior to v1.11.x, audit and telemetry each generated their own independent
 * sessionId. Same operation, different session IDs in the two log files —
 * which made cross-log analysis silently broken. The fix is structural: a
 * single source of truth that everyone imports from.
 *
 * #119 (WS3): when RVR_SESSION is set, CLI invocations adopt it instead of
 * generating a fresh id — many one-shot processes become one logical agent
 * session, and the session-scoped guardrails (write-amp window, miss-path
 * tracking) persist across invocations via the on-disk session state file
 * (see sessionState.ts). Unset → per-process random id, exactly the old
 * behavior. The id is sanitized because it names that state file.
 *
 * 8 hex chars (4 random bytes) is enough to disambiguate concurrent
 * processes on a typical user machine without bloating every log line.
 */
let sessionId: string | null = null;

function computeSessionId(): string {
  const env = process.env.RVR_SESSION?.trim();
  if (env) {
    // Leading dots are stripped so the session state file is never a
    // dotfile — sessions/ should always be inspectable with plain `ls`.
    const safe = env.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 64);
    if (safe) return safe;
  }
  return crypto.randomBytes(4).toString('hex');
}

export function getSessionId(): string {
  sessionId ??= computeSessionId();
  return sessionId;
}

/** True when RVR_SESSION pins a cross-invocation session id (#119). */
export function isSharedSession(): boolean {
  return Boolean(process.env.RVR_SESSION?.trim());
}

/** Test-only: forget the cached id so RVR_SESSION changes take effect. */
export function resetSessionIdForTests(): void {
  sessionId = null;
}
