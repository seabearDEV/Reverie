import { getEntriesFlat, Scope } from '../storage';
import { loadAliases } from '../alias';
import { loadMeta, loadMetaMerged, getStalenessTag } from '../store';
import { isEncrypted } from '../utils/crypto';
import { color } from '../formatting';
import { getBinaryName } from '../utils/binaryName';
import { HANDOFF_KEY, buildHandoffBanner, HandoffBanner } from '../utils/handoff';
import {
  shedToFitBudget,
  formatShedNotice,
  PATHOLOGICAL_OVERFLOW_NOTICE,
  DEFAULT_BOOTSTRAP_GIST_CHARS,
  indexEntryOf,
  formatIndexText,
  demoteToFitBudget,
  formatDemoteNotice,
  namespaceOf,
  IndexEntry,
  ShedSegment,
  DemoteSegment,
} from '../utils/contextBudget';
import { loadConfig, DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES } from '../config';
import { isJsonMode, setResult, addWarning, recordSignals } from '../utils/output';
import { printError } from './helpers';

// ── Tiers and pinning (#188) ─────────────────────────────────────────
//
// The bootstrap is a front page. Pinned namespaces render in full; at the
// standard tier every other entry renders as one index line (key + gist +
// the bytes an agent gets by opening it). `essential` is the pinned set
// alone; `full` is everything in full and bypasses the budget.

export type ContextTier = 'essential' | 'standard' | 'full';
export const CONTEXT_TIERS: readonly ContextTier[] = ['essential', 'standard', 'full'];

export function isContextTier(tier: string): tier is ContextTier {
  return (CONTEXT_TIERS as readonly string[]).includes(tier);
}

/** Default pinned set — the old `essential` set, so that tier keeps its meaning. */
export const DEFAULT_PINNED_NAMESPACES: readonly string[] = ['project', 'commands', 'conventions'];
/** Store entry that overrides the pinned set: comma-separated namespaces. */
export const PINNED_CONFIG_KEY = 'system.bootstrap.pinned';
/** Prefix form of the default pinned set (kept for callers that predate #188). */
export const ESSENTIAL_PREFIXES: readonly string[] = DEFAULT_PINNED_NAMESPACES.map(n => `${n}.`);

export interface PinnedResolution {
  namespaces: string[];
  prefixes: string[];
  /** Set when the override entry was present but unusable (defaults applied). */
  warning?: string | undefined;
}

/**
 * Resolve the pinned namespace set from the flat entry map. The override
 * lives in the store (not config.json) because it is project knowledge about
 * how to bootstrap this store: it travels with the repo and is edited through
 * `rvr set`, following the system.llm.instructions precedent.
 */
export function resolvePinnedNamespaces(flat: Record<string, string>): PinnedResolution {
  const defaults: PinnedResolution = {
    namespaces: [...DEFAULT_PINNED_NAMESPACES],
    prefixes: [...ESSENTIAL_PREFIXES],
  };
  const raw = flat[PINNED_CONFIG_KEY];
  if (raw === undefined) return defaults;
  const names = raw.split(',').map(s => s.trim().replace(/\.+$/, '')).filter(s => s.length > 0);
  const valid = names.length > 0 && names.every(n => /^[A-Za-z0-9_-]+$/.test(n));
  if (!valid) {
    return {
      ...defaults,
      warning: `${PINNED_CONFIG_KEY} is not a comma-separated namespace list (${JSON.stringify(raw)}); using the default pinned set (${DEFAULT_PINNED_NAMESPACES.join(', ')}).`,
    };
  }
  const unique = [...new Set(names)];
  return { namespaces: unique, prefixes: unique.map(n => `${n}.`) };
}

/**
 * Split the flat map by tier: `full` renders complete values, `rest` renders
 * as index lines. `essential` has no rest; `full` has no rest either — every
 * entry is in `full`.
 */
export function partitionByTier(
  flat: Record<string, string>,
  tier: ContextTier,
  pinnedPrefixes: readonly string[],
): { full: Record<string, string>; rest: Record<string, string> } {
  if (tier === 'full') return { full: { ...flat }, rest: {} };
  const full: Record<string, string> = {};
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (pinnedPrefixes.some(p => k.startsWith(p))) full[k] = v;
    else if (tier === 'standard') rest[k] = v;
  }
  return { full, rest };
}

// ── Knobs ────────────────────────────────────────────────────────────

/** bootstrap_max_response_bytes, with the RVR_BOOTSTRAP_MAX_BYTES test override. */
export function resolveBootstrapBudget(): number {
  const env = process.env.RVR_BOOTSTRAP_MAX_BYTES;
  if (env && Number.isInteger(Number(env)) && Number(env) > 0) return Number(env);
  return loadConfig().bootstrap_max_response_bytes || DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES;
}

/** bootstrap_gist_chars, with the RVR_BOOTSTRAP_GIST_CHARS test override. */
export function resolveGistChars(): number {
  const env = process.env.RVR_BOOTSTRAP_GIST_CHARS;
  if (env && Number.isInteger(Number(env)) && Number(env) > 0) return Number(env);
  const configured = (loadConfig() as { bootstrap_gist_chars?: number }).bootstrap_gist_chars;
  return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_BOOTSTRAP_GIST_CHARS;
}

// ── Surface hints ────────────────────────────────────────────────────
// The two surfaces render the same payload; only the wording of "how to
// open an entry" and "how to get everything" differs.

export interface SurfaceHints {
  /** e.g. `rvr get <key>` / `reverie_get <key>` */
  get: string;
  /** e.g. `use --tier full` / `pass tier:"full"` */
  full: string;
}

export function cliHints(): SurfaceHints {
  return { get: `${getBinaryName()} get <key>`, full: 'use --tier full' };
}

export const MCP_HINTS: SurfaceHints = { get: 'reverie_get <key>', full: 'pass tier:"full"' };

// ── Bootstrap overhead estimate (shared by shed + size projection) ───
// Non-entry bytes of a rendered bootstrap: handoff banner, aliases
// section, tier footer, and a conservative allowance for the notice lines.
// Uses Buffer.byteLength for accurate UTF-8 counts.

export function estimateBootstrapOverheadBytes(
  handoffLines: string[] | undefined,
  aliases: Record<string, string>,
  tier: ContextTier,
  entryCount: number,
  hints: SurfaceHints,
): number {
  let bytes = 0;
  if (handoffLines) {
    for (const line of handoffLines) bytes += Buffer.byteLength(`${line}\n`, 'utf8');
    bytes += 1; // blank line separator
  }
  if (Object.keys(aliases).length > 0) {
    bytes += Buffer.byteLength('\nAliases:\n', 'utf8');
    for (const [a, t] of Object.entries(aliases)) {
      bytes += Buffer.byteLength(`  ${a} -> ${t}\n`, 'utf8');
    }
  }
  // Tier footer (present whenever tier !== 'full'); sized on its longer,
  // indexed form with the pre-shed entry count as an upper bound.
  bytes += Buffer.byteLength(
    `\n[tier: ${tier} (${entryCount} entries: ${entryCount} in full, ${entryCount} indexed) — open an entry with ${hints.get}, or ${hints.full} for everything]\n`,
    'utf8');
  // Allowance for the demote + trimmed notice lines (emitted only when the
  // budget bites, but reserving it keeps the notices themselves from
  // pushing the final output over budget).
  bytes += 512;
  return bytes;
}

// ── Composition (shared by CLI and MCP) ───────────────────────────────

export interface ComposeOptions {
  tier: ContextTier;
  meta: Record<string, number>;
  aliases: Record<string, string>;
  budgetBytes: number;
  gistChars: number;
  hints: SurfaceHints;
  /** Surface-specific fixed bytes outside the shared estimate (MCP header line). */
  extraOverheadBytes?: number | undefined;
}

export interface ContextPayload {
  tier: ContextTier;
  handoff: HandoffBanner | undefined;
  handoffValue: string | undefined;
  /** Entries rendered in full: key → display value ([encrypted] substituted). */
  full: Record<string, string>;
  /** Entries rendered as index lines. */
  index: Record<string, IndexEntry>;
  /** Render order (store order), covering every key still present. */
  order: string[];
  aliases: Record<string, string>;
  pinnedNamespaces: string[];
  pinnedWarning: string | undefined;
  demoted: DemoteSegment[];
  shed: ShedSegment[];
  pathologicalOverflow: boolean;
  /** True when the budget changed the shape (demoted, shed, or overflow). */
  degraded: boolean;
}

const ENCRYPTED_DISPLAY = '[encrypted]';

export function composeContext(flat: Record<string, string>, opts: ComposeOptions): ContextPayload {
  // Handoff banner runs against the unfiltered map — it must render
  // regardless of tier since its whole point is to be impossible to miss
  // on session bootstrap (#91). The key is dropped from the entry list so
  // the content isn't duplicated.
  const handoff = buildHandoffBanner(flat, opts.meta);
  const entries: Record<string, string> = { ...flat };
  const handoffValue = handoff ? flat[HANDOFF_KEY] : undefined;
  if (handoff) delete entries[HANDOFF_KEY];

  const pinned = resolvePinnedNamespaces(entries);
  const { full: fullRaw, rest } = partitionByTier(entries, opts.tier, pinned.prefixes);

  const displayOf = (v: string): string => (isEncrypted(v) ? ENCRYPTED_DISPLAY : v);
  const indexOf = (v: string): IndexEntry => (isEncrypted(v)
    ? { gist: ENCRYPTED_DISPLAY, bytes: Buffer.byteLength(ENCRYPTED_DISPLAY, 'utf8'), truncated: false }
    : indexEntryOf(v, opts.gistChars));

  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries(fullRaw)) full[k] = displayOf(v);
  const index: Record<string, IndexEntry> = {};
  for (const [k, v] of Object.entries(rest)) index[k] = indexOf(v);

  let demoted: DemoteSegment[] = [];
  let shed: ShedSegment[] = [];
  let pathologicalOverflow = false;

  // Size budget (#100/#188): tier "full" bypasses entirely. Otherwise demote
  // pinned namespaces to index lines first (nothing lost), then drop by the
  // #100 priority order.
  if (opts.tier !== 'full') {
    const ageTag = (k: string): string => getStalenessTag(k, opts.meta);
    const display: Record<string, string> = {};
    for (const k of Object.keys(entries)) {
      if (k in full) display[k] = full[k];
      else if (k in index) display[k] = formatIndexText(index[k]);
    }
    const overhead = (opts.extraOverheadBytes ?? 0)
      + estimateBootstrapOverheadBytes(handoff?.lines, opts.aliases, opts.tier, Object.keys(display).length, opts.hints);

    const demotion = demoteToFitBudget(
      display, Object.keys(full), (k) => formatIndexText(indexOf(fullRaw[k])), ageTag, overhead, opts.budgetBytes);
    for (const k of demotion.demotedKeys) {
      index[k] = indexOf(fullRaw[k]);
      delete full[k];
    }
    demoted = demotion.segments;

    const drop = shedToFitBudget(demotion.display, ageTag, overhead, opts.budgetBytes);
    for (const k of Object.keys(demotion.display)) {
      if (!(k in drop.kept)) {
        delete full[k];
        delete index[k];
      }
    }
    shed = drop.segments;
    pathologicalOverflow = drop.pathologicalOverflow;
  }

  const order = Object.keys(entries).filter(k => k in full || k in index);
  return {
    tier: opts.tier,
    handoff,
    handoffValue,
    full,
    index,
    order,
    aliases: opts.aliases,
    pinnedNamespaces: pinned.namespaces,
    pinnedWarning: pinned.warning,
    demoted,
    shed,
    pathologicalOverflow,
    degraded: demoted.length > 0 || shed.length > 0 || pathologicalOverflow,
  };
}

// ── Rendering helpers (shared) ───────────────────────────────────────

export interface ContextLine {
  key: string;
  text: string;
  ageTag: string;
  kind: 'full' | 'index';
}

export function contextLines(payload: ContextPayload, meta: Record<string, number>): ContextLine[] {
  return payload.order.map(k => (k in payload.full
    ? { key: k, text: payload.full[k], ageTag: getStalenessTag(k, meta), kind: 'full' as const }
    : { key: k, text: formatIndexText(payload.index[k]), ageTag: getStalenessTag(k, meta), kind: 'index' as const }));
}

/** Notices in display order: demoted, trimmed, pathological. Empty when the budget didn't bite. */
export function contextNotices(payload: ContextPayload, hints: SurfaceHints): string[] {
  const notices: string[] = [];
  if (payload.demoted.length > 0) notices.push(formatDemoteNotice(payload.demoted, hints.get));
  if (payload.shed.length > 0) notices.push(formatShedNotice(payload.shed));
  if (payload.pathologicalOverflow) notices.push(PATHOLOGICAL_OVERFLOW_NOTICE);
  return notices;
}

/** Tier footer; undefined for tier "full". Carries the in-band fetch hint (#188). */
export function formatContextFooter(payload: ContextPayload, hints: SurfaceHints): string | undefined {
  if (payload.tier === 'full') return undefined;
  const nFull = Object.keys(payload.full).length;
  const nIndex = Object.keys(payload.index).length;
  if (nIndex === 0) {
    return `[tier: ${payload.tier} (${nFull} entries) — ${hints.full} for complete context]`;
  }
  return `[tier: ${payload.tier} (${nFull + nIndex} entries: ${nFull} in full, ${nIndex} indexed) — open an entry with ${hints.get}, or ${hints.full} for everything]`;
}

/** Per-call guardrail/telemetry signals for a composed payload (#100/#188). */
export function contextSignals(payload: ContextPayload): {
  tier: ContextTier;
  pinned: number;
  indexed: number;
  degraded?: boolean;
  shedNamespaces?: string[];
  demotedNamespaces?: string[];
} {
  return {
    tier: payload.tier,
    pinned: Object.keys(payload.full).length,
    indexed: Object.keys(payload.index).length,
    ...(payload.degraded && {
      degraded: true,
      shedNamespaces: payload.shed.map(s => s.label),
      ...(payload.demoted.length > 0 && { demotedNamespaces: payload.demoted.map(s => s.label) }),
    }),
  };
}

/** JSON `result` shape shared by `rvr context --json` and reverie_context consumers. */
export function contextJsonResult(payload: ContextPayload): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (payload.handoff) {
    result.handoff = {
      value: payload.handoffValue,
      ageDays: payload.handoff.ageDays,
      stale: payload.handoff.isStale,
    };
  }
  if (Object.keys(payload.full).length > 0) result.entries = payload.full;
  if (Object.keys(payload.index).length > 0) result.index = payload.index;
  if (Object.keys(payload.aliases).length > 0) result.aliases = payload.aliases;
  result.tier = payload.tier;
  if (payload.tier !== 'full') result.pinned = payload.pinnedNamespaces;
  if (payload.degraded) {
    result.degraded = true;
    result.shedNamespaces = payload.shed.map(s => s.label);
    if (payload.demoted.length > 0) result.demotedNamespaces = payload.demoted.map(s => s.label);
  }
  if (payload.pathologicalOverflow) result.pathologicalOverflow = true;
  return result;
}

// ── Size projection (#127, shape-aware since #188) ───────────────────
// Answers "how big is my bootstrap" without paying for the bootstrap:
// per-namespace entry/byte counts as they would render at the tier (full
// for pinned namespaces, index lines otherwise), plus the effective budget.
// Shared by MCP sizeOnly and CLI --size-only.

export interface ContextSizeReport {
  tier: ContextTier;
  namespaces: { ns: string; entries: number; bytes: number; shape: 'full' | 'index' }[];
  totalEntries: number;
  totalBytes: number;
  /** Estimated non-entry response bytes (handoff banner, aliases, footer). */
  overheadBytes: number;
  budgetBytes: number;
  fitsBudget: boolean;
  pinned: string[];
}

export function computeContextSizes(
  flat: Record<string, string>,
  tier: ContextTier,
  overheadBytes = 0,
  gistChars: number = resolveGistChars(),
): ContextSizeReport {
  const pinned = resolvePinnedNamespaces(flat);
  const { full, rest } = partitionByTier(flat, tier, pinned.prefixes);
  const byNs = new Map<string, { entries: number; bytes: number; shape: 'full' | 'index' }>();
  let totalBytes = 0;
  const add = (k: string, text: string, shape: 'full' | 'index'): void => {
    // Byte cost as rendered in a bootstrap response: "key: text\n".
    const bytes = Buffer.byteLength(`${k}: ${text}\n`, 'utf8');
    const ns = namespaceOf(k);
    const agg = byNs.get(ns) ?? { entries: 0, bytes: 0, shape };
    agg.entries += 1;
    agg.bytes += bytes;
    byNs.set(ns, agg);
    totalBytes += bytes;
  };
  for (const [k, v] of Object.entries(full)) add(k, isEncrypted(v) ? ENCRYPTED_DISPLAY : v, 'full');
  for (const [k, v] of Object.entries(rest)) {
    add(k, isEncrypted(v) ? ENCRYPTED_DISPLAY : formatIndexText(indexEntryOf(v, gistChars)), 'index');
  }
  const budgetBytes = resolveBootstrapBudget();
  const totalEntries = Object.keys(full).length + Object.keys(rest).length;
  return {
    tier,
    namespaces: [...byNs.entries()]
      .map(([ns, a]) => ({ ns, entries: a.entries, bytes: a.bytes, shape: a.shape }))
      .sort((a, b) => b.bytes - a.bytes),
    totalEntries,
    totalBytes,
    overheadBytes,
    budgetBytes,
    fitsBudget: tier === 'full' || totalBytes + overheadBytes <= budgetBytes,
    pinned: pinned.namespaces,
  };
}

/**
 * Build the size report the way the real bootstrap accounts for itself:
 * handoff banner bytes move from the entry list to the overhead estimate
 * (mirroring the HANDOFF_KEY drop in composeContext), and `fitsBudget`
 * answers "would a bootstrap at this tier demote or shed?" — the same
 * `entries + fixed overhead <= budget` check the budget step runs.
 */
export function computeContextSizeReport(
  flat: Record<string, string>,
  tier: ContextTier,
  scope?: Scope,
  hints: SurfaceHints = cliHints(),
): ContextSizeReport {
  if (tier === 'full') return computeContextSizes(flat, tier);
  const meta = scope === undefined || scope === 'auto' ? loadMetaMerged() : loadMeta(scope);
  const handoff = buildHandoffBanner(flat, meta);
  const aliases = loadAliases(scope);
  const entries = handoff ? { ...flat } : flat;
  if (handoff) delete entries[HANDOFF_KEY];
  const pinned = resolvePinnedNamespaces(entries);
  const { full, rest } = partitionByTier(entries, tier, pinned.prefixes);
  const entryCount = Object.keys(full).length + Object.keys(rest).length;
  const overhead = estimateBootstrapOverheadBytes(handoff?.lines, aliases, tier, entryCount, hints);
  return computeContextSizes(entries, tier, overhead);
}

export function formatContextSizeReport(report: ContextSizeReport): string {
  const lines = [`Context size (tier: ${report.tier}):`];
  for (const n of report.namespaces) {
    const shape = n.shape === 'index' ? '  (index)' : '';
    lines.push(`  ${n.ns.padEnd(14)} ${String(n.entries).padStart(4)} entries  ${String(n.bytes).padStart(8)}B${shape}`);
  }
  lines.push(`  ${'total'.padEnd(14)} ${String(report.totalEntries).padStart(4)} entries  ${String(report.totalBytes).padStart(8)}B`);
  if (report.tier !== 'full') {
    lines.push(`Pinned (rendered in full): ${report.pinned.join(', ')}`);
  }
  lines.push(report.tier === 'full'
    ? `Budget: ${report.budgetBytes}B (tier "full" bypasses the budget)`
    : `Budget: ${report.budgetBytes}B — entries + ~${report.overheadBytes}B overhead ${report.fitsBudget ? 'fit' : 'EXCEED the budget; a bootstrap at this tier will demote or shed'}`);
  return lines.join('\n');
}

// ── CLI context command ──────────────────────────────────────────────

export interface ContextOptions {
  tier?: string | undefined;
  global?: boolean | undefined;
  plain?: boolean | undefined;
  json?: boolean | undefined;
  sizeOnly?: boolean | undefined;
}

export function showContext(options: ContextOptions = {}): void {
  const scope: Scope | undefined = options.global ? 'global' : undefined;
  const requestedTier = options.tier ?? 'standard';
  if (!isContextTier(requestedTier)) {
    printError(`Invalid tier '${requestedTier}'. Expected one of: ${CONTEXT_TIERS.join(', ')}.`, 'INVALID_INPUT');
    return;
  }
  const tier: ContextTier = requestedTier;

  const flat = getEntriesFlat(scope);

  // Size projection (#127): report what a bootstrap would cost instead of
  // paying it. Estimates handoff/alias/footer overhead without rendering.
  if (options.sizeOnly) {
    const report = computeContextSizeReport(flat, tier, scope);
    if (isJsonMode()) {
      setResult(report);
    } else {
      console.log(formatContextSizeReport(report));
    }
    return;
  }

  const aliases = loadAliases(scope);
  const meta = scope === 'global' ? loadMeta('global') : loadMetaMerged();
  const hints = cliHints();
  const payload = composeContext(flat, {
    tier,
    meta,
    aliases,
    budgetBytes: resolveBootstrapBudget(),
    gistChars: resolveGistChars(),
    hints,
  });

  if (!payload.handoff && payload.order.length === 0 && Object.keys(aliases).length === 0) {
    if (!options.plain) {
      console.log(color.gray(`No entries stored. Add one with "${getBinaryName()} set <key> <value>"`));
    }
    return;
  }

  // Telemetry/audit signals for the instrumentation wrapper (#188): the
  // CLI now records the same shape/degradation fields MCP rows carry.
  recordSignals(contextSignals(payload));

  const notices = contextNotices(payload, hints);

  // JSON output — payload goes inside the WS1 envelope's `result`. The
  // notices are surfaced both in the result (degraded/shedNamespaces/
  // demotedNamespaces, for MCP parity) and in the envelope's warnings[] so
  // agents that only inspect warnings still see them.
  if (isJsonMode()) {
    if (payload.pinnedWarning) addWarning(payload.pinnedWarning, 'CONFIG');
    for (const n of notices) addWarning(n);
    setResult(contextJsonResult(payload));
    return;
  }

  if (payload.pinnedWarning) {
    console.error(`warning: ${payload.pinnedWarning}`);
  }

  // Notices — first thing the reader sees, ahead of the handoff banner
  // and entries (#100).
  for (const n of notices) {
    console.log(options.plain ? n : color.yellow(n));
    console.log('');
  }

  // Formatted output — banner first so it's the first thing the reader sees.
  if (payload.handoff) {
    for (const line of payload.handoff.lines) {
      if (options.plain) {
        console.log(line);
      } else {
        const colored = line.startsWith('→')
          ? (payload.handoff.isStale ? color.yellow(line) : color.cyan(line))
          : color.white(line);
        console.log(colored);
      }
    }
    if (payload.order.length > 0 || Object.keys(aliases).length > 0) {
      console.log('');
    }
  }

  for (const line of contextLines(payload, meta)) {
    if (options.plain) {
      console.log(`${line.key}: ${line.text}${line.ageTag}`);
    } else {
      console.log(`${color.cyan(line.key)}: ${line.text}${line.ageTag ? color.yellow(line.ageTag) : ''}`);
    }
  }

  if (Object.keys(aliases).length > 0) {
    console.log('');
    if (!options.plain) {
      console.log(color.bold('Aliases:'));
    } else {
      console.log('Aliases:');
    }
    for (const [a, t] of Object.entries(aliases)) {
      if (options.plain) {
        console.log(`  ${a} -> ${t}`);
      } else {
        console.log(`  ${color.green(a)} ${color.gray('->')} ${color.yellow(t)}`);
      }
    }
  }

  const footer = formatContextFooter(payload, hints);
  if (footer) {
    console.log('');
    console.log(options.plain ? footer : color.gray(footer));
  }
}
