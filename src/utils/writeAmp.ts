// Write-amplification guard (#101). Tracks per-session-per-key write
// timestamps in memory so we can warn agents when the same key is rewritten
// 3+ times within a 30-min sliding window. The in-memory map serves the
// long-lived MCP server; CLI invocations sharing RVR_SESSION run the same
// window math against the on-disk session state file (#119, sessionState.ts)
// via pruneAndRecord below.

import path from 'path';
import type { Scope } from '../store';
import { HANDOFF_KEY } from './handoff';

const WINDOW_MS = 30 * 60 * 1000;
const THRESHOLD = 3;

// Keys the guard never counts. The warning asks whether an entry has
// stabilized, and the handoff is the one entry rewritten by convention as a
// session progresses — it is replaced, not accumulated, so the question does
// not apply. Once CLI sessions were detected (#207) every third handoff
// rewrite warned. Exact keys only: no prefixes, no config knob.
const EXEMPT_KEYS: ReadonlySet<string> = new Set([HANDOFF_KEY]);

/** True for keys the write-amp guard neither counts nor warns about. */
export function isWriteAmpExempt(key: string): boolean {
  return EXEMPT_KEYS.has(key);
}

/**
 * Identity of the store a write landed in: the project root for a project
 * write, 'global' otherwise. The guard counts writes per entry, and an entry
 * is a key in one store — counted on the key name alone, a key written once
 * in each of three projects read as one entry written three times.
 */
export function writeAmpStore(scope: Scope, projectFile: string | null): string {
  const landed = scope === 'auto' ? (projectFile ? 'project' : 'global') : scope;
  return landed === 'project' && projectFile ? path.dirname(projectFile) : landed;
}

/**
 * The window slot for one entry. JSON keeps the (store, key) pair unambiguous
 * whatever characters either holds.
 */
export function writeAmpSlot(key: string, store: string): string {
  return JSON.stringify([store, key]);
}

// sessionId → slot → timestamps[] (ms epoch). Per-MCP-server-process state,
// cleared on server restart. Slots are lazily evicted when their most recent
// timestamp slides outside the 30-min window; sessions are evicted when all
// their slots have been swept. Memory is proportional to
// active-session count × live-entries-per-session (any in-window write).
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
 * True while `timestamps` still holds a write inside the 30-min window. The
 * on-disk guard evicts every key this is false for; an empty list (a damaged
 * file whose leaves were all discarded) is not live either.
 */
export function hasLiveWrite(timestamps: number[], now: number): boolean {
  const cutoff = now - WINDOW_MS;
  return timestamps.some(ts => ts > cutoff);
}

/**
 * Record a successful reverie_set on (sessionId, store, key) and return a
 * warning descriptor when the threshold trips, or null when no warning is
 * warranted.
 *
 * The threshold trips on the 3rd+ write within the same session and the
 * 30-min sliding window. Different sessions get fresh counters, and so does
 * the same key in a different store. Exempt keys (see isWriteAmpExempt) are
 * not recorded at all.
 *
 * `now` is injected for testability (default: Date.now()). `store` is where
 * the write landed (writeAmpStore); both call sites pass it, and the default
 * only serves tests of the window math.
 */
export function recordWrite(sessionId: string, key: string, now = Date.now(), store = ''): WriteAmpResult | null {
  if (isWriteAmpExempt(key)) return null;
  const slot = writeAmpSlot(key, store);

  let perSession = sessionWrites.get(sessionId);
  if (!perSession) {
    perSession = new Map();
    sessionWrites.set(sessionId, perSession);
  }

  const cutoff = now - WINDOW_MS;

  // Lazy eviction: remove slots in this session whose most recent timestamp has
  // slid outside the 30-min window. Since timestamps are appended in order,
  // the last element is the most recent — if it's expired, all are expired.
  // We skip `slot` here because its current write hasn't been recorded yet;
  // it will be evaluated naturally on the next call.
  for (const [k, timestamps] of perSession) {
    if (k !== slot && timestamps[timestamps.length - 1] <= cutoff) {
      perSession.delete(k);
    }
  }
  // Evict sessions that became empty after prior sweeps.
  for (const [sid, sess] of sessionWrites) {
    if (sid !== sessionId && sess.size === 0) {
      sessionWrites.delete(sid);
    }
  }

  const { timestamps, result } = pruneAndRecord(perSession.get(slot) ?? [], now);
  perSession.set(slot, timestamps);
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

// The CLI's `reverie_set` invocations do not all store a value: `set <key>
// --confirm`, `--no-confirm` and `-a <alias>` on their own update metadata, a
// declined overwrite prompt and an `edit` closed without changes write
// nothing. Each used to take a slot in the window, so an entry written once
// could warn. The handler marks the store, right after setValue; the
// instrumentation wrapper takes the mark before it counts. The MCP handler
// needs none — it records only after its own setValue.
let valueStored = false;

/** Called by a CLI handler once it has stored an entry value. */
export function markValueStored(): void {
  valueStored = true;
}

/** Whether a value was stored since the last take; clears the mark. */
export function takeValueStored(): boolean {
  const stored = valueStored;
  valueStored = false;
  return stored;
}

/** Reset all in-memory write-amp state. Used by tests and on server restart. */
export function clearWriteAmpState(): void {
  sessionWrites.clear();
  valueStored = false;
}
