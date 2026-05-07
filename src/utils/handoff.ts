// Cross-session handoff banner (#91).
//
// Agents using Reverie via MCP converged on writing `context.next_session`
// at session end to leave a note for the next session's bootstrap. This
// module formalizes that convention: when the key is present, reverie_context
// renders it as a banner above the regular entries list so it cannot be
// missed, with age labeling to signal whether the handoff is still fresh.

export const HANDOFF_KEY = 'context.next_session';

// Handoff entries are ephemeral by design. Past ~1 week they're probably
// stale relative to current project state — surface that to the reader
// rather than silently trusting a forgotten note.
export const HANDOFF_STALE_DAYS = 7;

/** Format an age-in-milliseconds as a short human-readable string. */
export function formatHandoffAge(ageMs: number): string {
  if (ageMs < 60_000) return 'just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export interface HandoffBanner {
  /** Rendered lines ready to emit (no trailing blank line — caller inserts). */
  lines: string[];
  /** True when the handoff crossed the staleness threshold. */
  isStale: boolean;
  /** Age in whole days, or undefined when the entry has no meta timestamp. */
  ageDays: number | undefined;
}

/**
 * Build banner lines for the handoff key if present in `entries`.
 *
 * Returns undefined when `HANDOFF_KEY` is absent so callers can skip the
 * banner block entirely. When the key is present but its meta timestamp is
 * missing (legacy entry, or hand-edited store), age labels as "untracked"
 * and `isStale` stays false — we don't know it's stale, only that we don't
 * know its age.
 *
 * Note: `entries` should be the full flat map (pre-tier-filter). The banner
 * must render regardless of requested tier since its whole point is to be
 * impossible to miss on session bootstrap.
 */
export function buildHandoffBanner(
  entries: Record<string, string>,
  meta: Record<string, number>,
  now: number = Date.now(),
): HandoffBanner | undefined {
  const value = entries[HANDOFF_KEY];
  if (value === undefined) return undefined;

  const ts = meta[HANDOFF_KEY];
  const ageMs = ts !== undefined ? now - ts : undefined;
  const ageDays = ageMs !== undefined ? Math.floor(ageMs / 86_400_000) : undefined;
  const isStale = ageDays !== undefined && ageDays >= HANDOFF_STALE_DAYS;

  const ageTag = ageMs !== undefined ? formatHandoffAge(ageMs) : 'untracked';
  const staleMarker = isStale ? ` [likely stale — ${ageDays}d]` : '';
  const header = `→ Handoff from previous session (${ageTag})${staleMarker}:`;

  // Indent each line of the value so the banner visually groups. Multi-line
  // handoffs are common — agents write paragraphs, not one-liners.
  const valueLines = value.split('\n').map(l => `  ${l}`);

  return {
    lines: [header, ...valueLines],
    isStale,
    ageDays,
  };
}
