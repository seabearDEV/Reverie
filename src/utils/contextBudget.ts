// reverie_context size-budget (#100, #188). When the projected response
// exceeds the configured byte budget AND tier !== 'full': first demote pinned
// namespaces from full values to index lines (#188, nothing lost), then drop
// entries by priority (files.* → arch.* → large context.*) until under
// budget. Never dropped: project.*, conventions.*, commands.*, deps.*,
// context.next_session.

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
 *    fetch via reverie_get <key> or reverie_context tier:\"full\"]"
 */
export function formatShedNotice(segments: ShedSegment[]): string {
  if (segments.length === 0) return '';
  const parts = segments.map(s => `${s.label} (${s.keys.length} ${s.keys.length === 1 ? 'entry' : 'entries'}, ${formatBytes(s.bytes)})`);
  return `[trimmed: ${parts.join(', ')} — fetch via reverie_get <key> or reverie_context tier:"full"]`;
}

/**
 * Notice for the pathological case where even after shedding every
 * sheddable namespace the response still exceeds the budget. Surfaces
 * the situation explicitly rather than silently truncating a never-shed
 * namespace (per #100 design pathological-case requirement).
 */
export const PATHOLOGICAL_OVERFLOW_NOTICE =
  '[warning: reverie_context payload still exceeds budget after shedding all sheddable namespaces. ' +
  'Increase bootstrap_max_response_bytes (reverie_config_set) or audit project.*, conventions.*, commands.*, deps.*, and context.next_session for over-long entries.]';

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}K`;
}

// ── Index lines (#188) ─────────────────────────────────────────────────
// Standard tier renders every unpinned entry as one line: the key, a gist
// of the value (its first line, cut at a word boundary), a marker with the
// bytes an agent gets by opening the entry, and the usual age tag. The
// gist is the author's own headline — no generation; the key is already
// the title and lint --seed-quality polices the first sentence.

/** Default cap for the gist, in characters. Config key bootstrap_gist_chars. */
export const DEFAULT_BOOTSTRAP_GIST_CHARS = 160;

export interface GistResult {
  gist: string;
  truncated: boolean;
}

/**
 * First line of `value`, cut at the last whitespace within `cap` characters.
 * A single-line value that fits is returned untouched (so short entries
 * render exactly as they always have). Falls back to a hard cut when the
 * first half of the line has no whitespace (URLs, hashes).
 */
export function gistOf(value: string, cap: number): GistResult {
  if (!value.includes('\n') && value.length <= cap) return { gist: value, truncated: false };
  const trimmed = value.trim();
  const nl = trimmed.indexOf('\n');
  const line = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trimEnd();
  if (line.length <= cap) return { gist: line, truncated: line !== trimmed };
  const head = line.slice(0, cap);
  let cut = head.search(/\s\S*$/);
  if (cut < cap / 2) cut = cap;
  return { gist: head.slice(0, cut).trimEnd(), truncated: true };
}

export interface IndexEntry {
  gist: string;
  /** Full value size in bytes — what opening the entry costs. */
  bytes: number;
  truncated: boolean;
}

export function indexEntryOf(value: string, cap: number): IndexEntry {
  const { gist, truncated } = gistOf(value, cap);
  return { gist, truncated, bytes: Buffer.byteLength(value, 'utf8') };
}

/** Display text for an index line (everything after `key: `, before the age tag). */
export function formatIndexText(ix: IndexEntry): string {
  if (!ix.truncated) return ix.gist;
  const remaining = Math.max(0, ix.bytes - Buffer.byteLength(ix.gist, 'utf8'));
  return `${ix.gist}… [+${formatBytes(remaining)}]`;
}

export function namespaceOf(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

// ── Demotion (#188, budget step 1) ─────────────────────────────────────
// Before the #100 drop order runs, whole pinned namespaces fall back from
// full values to index lines, largest rendered namespace first. Nothing is
// lost — the agent still sees every key — so this always runs ahead of
// dropping, and the pathological "never-shed alone exceeds budget" case
// becomes unreachable for any realistic store.

export interface DemoteSegment {
  label: string;
  keys: string[];
  bytesBefore: number;
  bytesAfter: number;
}

export interface DemoteDecision {
  /** Display map with demoted keys replaced by their index text. */
  display: Record<string, string>;
  demotedKeys: string[];
  segments: DemoteSegment[];
}

export function demoteToFitBudget(
  display: Record<string, string>,
  fullKeys: Iterable<string>,
  indexText: (k: string) => string,
  ageTag: (k: string) => string,
  fixedOverheadBytes: number,
  budgetBytes: number,
): DemoteDecision {
  const next: Record<string, string> = { ...display };
  let projected = fixedOverheadBytes;
  for (const [k, v] of Object.entries(next)) projected += entryRenderBytes(k, v, ageTag(k));
  if (projected <= budgetBytes) return { display: next, demotedKeys: [], segments: [] };

  const byNs = new Map<string, string[]>();
  for (const k of fullKeys) {
    if (k === HANDOFF_KEY || !(k in next)) continue;
    const ns = namespaceOf(k);
    const list = byNs.get(ns) ?? [];
    list.push(k);
    byNs.set(ns, list);
  }
  const groups = [...byNs.entries()]
    .map(([ns, keys]) => ({
      ns,
      keys,
      bytes: keys.reduce((sum, k) => sum + entryRenderBytes(k, next[k], ageTag(k)), 0),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const demotedKeys: string[] = [];
  const segments: DemoteSegment[] = [];
  for (const g of groups) {
    if (projected <= budgetBytes) break;
    // Skip namespaces whose entries already fit on one line — demoting
    // them saves nothing and would only add a misleading notice.
    const texts = g.keys.map(k => indexText(k));
    const after = g.keys.reduce((sum, k, i) => sum + entryRenderBytes(k, texts[i], ageTag(k)), 0);
    if (after >= g.bytes) continue;
    g.keys.forEach((k, i) => {
      next[k] = texts[i];
      demotedKeys.push(k);
    });
    projected += after - g.bytes;
    segments.push({ label: `${g.ns}.*`, keys: g.keys, bytesBefore: g.bytes, bytesAfter: after });
  }
  return { display: next, demotedKeys, segments };
}

/**
 *   "[demoted to index: project.* (21 entries, 21.7K → 4.1K) — open entries
 *    with reverie_get <key>]"
 */
export function formatDemoteNotice(segments: DemoteSegment[], getHint: string): string {
  if (segments.length === 0) return '';
  const parts = segments.map(s =>
    `${s.label} (${s.keys.length} ${s.keys.length === 1 ? 'entry' : 'entries'}, ${formatBytes(s.bytesBefore)} → ${formatBytes(s.bytesAfter)})`);
  return `[demoted to index: ${parts.join(', ')} — open entries with ${getHint}]`;
}
