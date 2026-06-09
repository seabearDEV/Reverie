// Write-amplification guard (#101). Tracks per-session-per-key write
// timestamps in memory so we can warn agents when the same key is rewritten
// 3+ times within a 30-min sliding window. The in-memory map serves the
// long-lived MCP server; CLI invocations sharing RVR_SESSION run the same
// window math against the on-disk session state file (#119, sessionState.ts)
// via pruneAndRecord below.

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
 * Pure window math shared by the in-memory (MCP) and on-disk (CLI, #119)
 * guards: prune `prior` timestamps to the 30-min window, record `now`, and
 * report whether the threshold tripped.
 */
export function pruneAndRecord(prior: number[], now: number): { timestamps: number[]; result: WriteAmpResult | null } {
  const cutoff = now - WINDOW_MS;
  const timestamps = prior.filter(ts => ts > cutoff);
  timestamps.push(now);
  const result = timestamps.length >= THRESHOLD
    ? { count: timestamps.length, firstWriteMsAgo: now - timestamps[0] }
    : null;
  return { timestamps, result };
}

/**
 * Record a successful reverie_set on (sessionId, key) and return a warning
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
  // We skip `key` here because its current write hasn't been recorded yet;
  // it will be evaluated naturally on the next call.
  for (const [k, timestamps] of perSession) {
    if (k !== key && timestamps[timestamps.length - 1] <= cutoff) {
      perSession.delete(k);
    }
  }
  // Evict sessions that became empty after prior sweeps.
  for (const [sid, sess] of sessionWrites) {
    if (sid !== sessionId && sess.size === 0) {
      sessionWrites.delete(sid);
    }
  }

  const { timestamps, result } = pruneAndRecord(perSession.get(key) ?? [], now);
  perSession.set(key, timestamps);
  return result;
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
