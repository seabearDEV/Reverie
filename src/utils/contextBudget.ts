// codex_context size-budget shedding (#100). When the projected response
// exceeds the configured byte budget AND tier !== 'full', drop entries by
// priority (files.* → arch.* → large context.*) until under budget. Never
// shed: project.*, conventions.*, commands.*, deps.*, context.next_session.

import { HANDOFF_KEY } from './handoff';

const NEVER_SHED_PREFIXES = ['project.', 'conventions.', 'commands.', 'deps.'];

// Priority-ordered shed list. Each entry names a label (for the notice),
// a predicate (which keys it covers), and a sort hint (for "largest first"
// within the namespace).
interface ShedRule {
  label: string;
  matches: (k: string, v: string) => boolean;
  largestFirst: boolean;
}

const SHED_ORDER: ShedRule[] = [
  {
    label: 'files.*',
    matches: (k) => k.startsWith('files.'),
    largestFirst: false,
  },
  {
    label: 'arch.*',
    matches: (k) => k.startsWith('arch.'),
    largestFirst: false,
  },
  {
    label: 'context.*',
    matches: (k) => k.startsWith('context.') && k !== HANDOFF_KEY,
    largestFirst: true,
  },
];

export interface ShedSegment {
  label: string;
  keys: string[];
  bytes: number;
}

export interface ShedDecision {
  kept: Record<string, string>;
  segments: ShedSegment[];
  pathologicalOverflow: boolean;
}

/**
 * Compute the byte cost of rendering a single entry as a `${k}: ${v}${ageTag}\n`
 * line. Caller passes a function to look up the age tag because staleness
 * metadata lives outside this module.
 */
export function entryRenderBytes(k: string, v: string, ageTag: string): number {
  // Use Buffer.byteLength to correctly count UTF-8 bytes (not UTF-16 code
  // units), so the budget is accurate for non-ASCII keys/values/age tags.
  return Buffer.byteLength(`${k}: ${v}${ageTag}\n`, 'utf8');
}

/**
 * Drop entries by priority until the total fits within the budget.
 *
 * Inputs:
 *  - `entries`: tier-filtered entry map (already excludes arch.* on standard,
 *    everything-but-essential on essential; full bypasses this function entirely)
 *  - `ageTag`: function from key → staleness suffix used for sizing
 *  - `fixedOverheadBytes`: cost of headers/banners/aliases/footer (non-sheddable)
 *  - `budgetBytes`: cap from config.bootstrap_max_response_bytes
 *
 * Returns the kept entries plus a summary of what was shed. `segments` is
 * empty when no shedding occurred. `pathologicalOverflow` is true when even
 * after shedding all sheddable namespaces the response still exceeds budget
 * (means the never-shed namespaces alone exceed the budget).
 */
export function shedToFitBudget(
  entries: Record<string, string>,
  ageTag: (k: string) => string,
  fixedOverheadBytes: number,
  budgetBytes: number,
): ShedDecision {
  const kept: Record<string, string> = { ...entries };

  let projected = fixedOverheadBytes;
  for (const [k, v] of Object.entries(kept)) {
    projected += entryRenderBytes(k, v, ageTag(k));
  }

  if (projected <= budgetBytes) {
    return { kept, segments: [], pathologicalOverflow: false };
  }

  const segments: ShedSegment[] = [];

  for (const rule of SHED_ORDER) {
    if (projected <= budgetBytes) break;

    const candidates = Object.entries(kept)
      .filter(([k, v]) => rule.matches(k, v) && !NEVER_SHED_PREFIXES.some(p => k.startsWith(p)));

    if (candidates.length === 0) continue;

    if (rule.largestFirst) {
      candidates.sort(([ka, va], [kb, vb]) =>
        entryRenderBytes(kb, vb, ageTag(kb)) - entryRenderBytes(ka, va, ageTag(ka))
      );
    }

    const segment: ShedSegment = { label: rule.label, keys: [], bytes: 0 };
    for (const [k, v] of candidates) {
      if (projected <= budgetBytes) break;
      const cost = entryRenderBytes(k, v, ageTag(k));
      delete kept[k];
      segment.keys.push(k);
      segment.bytes += cost;
      projected -= cost;
    }
    if (segment.keys.length > 0) {
      segments.push(segment);
    }
  }

  return {
    kept,
    segments,
    pathologicalOverflow: projected > budgetBytes,
  };
}

/**
 * Format the shed segments into a one-line notice for the response. Returns
 * empty string if nothing was shed.
 *
 *   "[trimmed: files.* (12 entries, 8.2K), arch.* (5 entries, 2.1K) —
 *    fetch via codex_get <key> or codex_context tier:\"full\"]"
 */
export function formatShedNotice(segments: ShedSegment[]): string {
  if (segments.length === 0) return '';
  const parts = segments.map(s => `${s.label} (${s.keys.length} ${s.keys.length === 1 ? 'entry' : 'entries'}, ${formatBytes(s.bytes)})`);
  return `[trimmed: ${parts.join(', ')} — fetch via codex_get <key> or codex_context tier:"full"]`;
}

/**
 * Notice for the pathological case where even after shedding every
 * sheddable namespace the response still exceeds the budget. Surfaces
 * the situation explicitly rather than silently truncating a never-shed
 * namespace (per #100 design pathological-case requirement).
 */
export const PATHOLOGICAL_OVERFLOW_NOTICE =
  '[warning: codex_context payload still exceeds budget after shedding all sheddable namespaces. ' +
  'Increase bootstrap_max_response_bytes (codex_config_set) or audit project.*/conventions.* for over-long entries.]';

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}K`;
}
