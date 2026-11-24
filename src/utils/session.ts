import crypto from 'crypto';
import { detectHarness } from './agentIdentity';

/**
 * Single shared session identifier for the current process. Resolved once
 * on first use and reused by every observability subsystem (audit log,
 * telemetry, miss-path tracker) so that entries from the same process can
 * be cross-referenced by `session` field.
 *
 * Prior to v1.11.x, audit and telemetry each generated their own independent
 * sessionId. Same operation, different session IDs in the two log files —
 * which made cross-log analysis silently broken. The fix is structural: a
 * single source of truth that everyone imports from.
 *
 * Resolution order:
 *  1. RVR_SESSION (#119, WS3) — explicit. CLI invocations adopt it instead of
 *     generating a fresh id, so many one-shot processes become one logical
 *     agent session and the session-scoped guardrails (write-amp window,
 *     miss-path tracking) persist across invocations via the on-disk session
 *     state file (see sessionState.ts).
 *  2. The harness's own session variable (#207) — detected. A static harness
 *     env block cannot carry a per-session RVR_SESSION, so on the daily CLI
 *     surface nearly every call was its own session. When the env fingerprint
 *     names a harness that exports a session id (Claude Code:
 *     CLAUDE_CODE_SESSION_ID), that id is adopted and rows are tagged
 *     sessionDetected:true — the same explicit-else-fingerprint pattern as
 *     agent attribution (#138). The variable is honored only alongside its
 *     harness fingerprint.
 *  3. Otherwise a per-process random id, exactly the pre-#119 behavior:
 *     8 hex chars (4 random bytes) is enough to disambiguate concurrent
 *     processes on a typical user machine without bloating every log line.
 *
 * Ids from the environment are sanitized because they name the state file.
 */
export interface SessionIdentity {
  id: string;
  /** True when the id spans invocations (explicit or detected), so the
   *  on-disk session state applies. False for the per-process fallback. */
  shared: boolean;
  /** True when the id came from a harness's own session variable; absent
   *  when explicit (RVR_SESSION) or per-process. */
  detected: true | undefined;
}

/**
 * Make an environment-supplied id safe to use as a filename. Leading dots
 * are stripped so the session state file is never a dotfile — sessions/
 * should always be inspectable with plain `ls`. Returns '' when nothing
 * usable is left.
 */
function sanitizeSessionId(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return '';
  return trimmed.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 64);
}

/** Pure resolution over an env object — id, shared and detected decided together. */
export function deriveSession(env: NodeJS.ProcessEnv): SessionIdentity {
  const explicit = sanitizeSessionId(env.RVR_SESSION);
  if (explicit) return { id: explicit, shared: true, detected: undefined };

  const sessionVar = detectHarness(env)?.sessionVar;
  const ambient = sessionVar ? sanitizeSessionId(env[sessionVar]) : '';
  if (ambient) return { id: ambient, shared: true, detected: true };

  return { id: crypto.randomBytes(4).toString('hex'), shared: false, detected: undefined };
}

let session: SessionIdentity | null = null;

function resolveSession(): SessionIdentity {
  session ??= deriveSession(process.env);
  return session;
}

export function getSessionId(): string {
  return resolveSession().id;
}

/** True when a cross-invocation session id is in effect — RVR_SESSION (#119)
 *  or a detected harness session (#207). */
export function isSharedSession(): boolean {
  return resolveSession().shared;
}

/** True when the session id was detected from the harness, not set explicitly (#207). */
export function isSessionDetected(): boolean {
  return resolveSession().detected === true;
}

/** Test-only: forget the cached identity so env changes take effect. */
export function resetSessionIdForTests(): void {
  session = null;
}
