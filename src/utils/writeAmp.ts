// Write-amplification guard (#101). Tracks per-session-per-key write
// timestamps in memory so we can warn agents when the same key is rewritten
// 3+ times within a 30-min sliding window. MCP-only: CLI invocations are
// per-process and have no multi-call session for the guard to attach to.

const WINDOW_MS = 30 * 60 * 1000;
const THRESHOLD = 3;

// sessionId → key → timestamps[] (ms epoch). Per-MCP-server-process state,
// cleared on server restart. Keys are lazily evicted when their most recent
// timestamp slides outside the 30-min window; sessions are evicted when all
// their keys have been swept. Memory is proportional to
// active-session count × live-keys-per-session (keys with any in-window write).
const sessionWrites = new Map<string, Map<string, number[]>>();

export interface WriteAmpResult {
  count: number;
  firstWriteMsAgo: number;
}

/**
 * Record a successful codex_set on (sessionId, key) and return a warning
 * descriptor when the threshold trips, or null when no warning is warranted.
 *
 * The threshold trips on the 3rd+ write within the same session and the
 * 30-min sliding window. Different sessions get fresh counters.
 *
 * `now` is injected for testability (default: Date.now()).
 */
export function recordWrite(sessionId: string, key: string, now = Date.now()): WriteAmpResult | null {
  let perSession = sessionWrites.get(sessionId);
  if (!perSession) {
    perSession = new Map();
    sessionWrites.set(sessionId, perSession);
  }

  const cutoff = now - WINDOW_MS;

  // Lazy eviction: remove keys in this session whose most recent timestamp has
  // slid outside the 30-min window. Since timestamps are appended in order,
  // the last element is the most recent — if it's expired, all are expired.
  for (const [k, timestamps] of perSession) {
    if (k !== key && (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff)) {
      perSession.delete(k);
    }
  }
  // Evict sessions that became empty after prior sweeps.
  for (const [sid, sess] of sessionWrites) {
    if (sid !== sessionId && sess.size === 0) {
      sessionWrites.delete(sid);
    }
  }

  const prior = (perSession.get(key) ?? []).filter(ts => ts > cutoff);
  prior.push(now);
  perSession.set(key, prior);

  if (prior.length >= THRESHOLD) {
    return {
      count: prior.length,
      firstWriteMsAgo: now - prior[0],
    };
  }
  return null;
}

/**
 * Render the warning string for the response body. Format:
 *
 *   "this key has been written 3 times in this session (first write: 12m ago)
 *    — consider whether the entry has stabilized. See conventions.seedDensity."
 */
export function formatWriteAmpWarning(result: WriteAmpResult): string {
  return `this key has been written ${result.count} times in this session (first write: ${formatMsAgo(result.firstWriteMsAgo)} ago) — consider whether the entry has stabilized. See conventions.seedDensity.`;
}

function formatMsAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  return `${minutes}m`;
}

/** Reset all in-memory write-amp state. Used by tests and on server restart. */
export function clearWriteAmpState(): void {
  sessionWrites.clear();
}
