import { getEntriesFlat, Scope } from '../storage';
import { loadAliases } from '../alias';
import { loadMeta, loadMetaMerged, getStalenessTag } from '../store';
import { isEncrypted } from '../utils/crypto';
import { color } from '../formatting';
import { getBinaryName } from '../utils/binaryName';
import { HANDOFF_KEY, buildHandoffBanner } from '../utils/handoff';
import { shedToFitBudget, formatShedNotice, PATHOLOGICAL_OVERFLOW_NOTICE } from '../utils/contextBudget';
import { loadConfig, DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES } from '../config';
import { isJsonMode, setResult, addWarning } from '../utils/output';

// ── Tier filtering (shared with MCP server) ──────────────────────────

export const ESSENTIAL_PREFIXES = ['project.', 'commands.', 'conventions.'];
export const STANDARD_EXCLUDE_PREFIXES = ['arch.'];

export function filterEntriesByTier(
  flat: Record<string, string>,
  tier: 'essential' | 'standard' | 'full'
): Record<string, string> {
  if (tier === 'full') return flat;
  if (tier === 'essential') {
    return Object.fromEntries(
      Object.entries(flat).filter(([k]) => ESSENTIAL_PREFIXES.some(p => k.startsWith(p)))
    );
  }
  // standard: exclude arch.*
  return Object.fromEntries(
    Object.entries(flat).filter(([k]) => !STANDARD_EXCLUDE_PREFIXES.some(p => k.startsWith(p)))
  );
}

// ── Size projection (#127) ───────────────────────────────────────────
// Answers "how big is my bootstrap" without paying for the bootstrap:
// per-namespace entry/byte counts over the tier-filtered store, plus the
// effective budget. Shared by MCP sizeOnly and CLI --size-only.

export interface ContextSizeReport {
  tier: 'essential' | 'standard' | 'full';
  namespaces: { ns: string; entries: number; bytes: number }[];
  totalEntries: number;
  totalBytes: number;
  budgetBytes: number;
  fitsBudget: boolean;
}

export function computeContextSizes(
  flat: Record<string, string>,
  tier: 'essential' | 'standard' | 'full'
): ContextSizeReport {
  const filtered = filterEntriesByTier(flat, tier);
  const byNs = new Map<string, { entries: number; bytes: number }>();
  let totalBytes = 0;
  for (const [k, v] of Object.entries(filtered)) {
    const display = isEncrypted(v) ? '[encrypted]' : v;
    // Byte cost as rendered in a bootstrap response: "key: value\n".
    const bytes = Buffer.byteLength(`${k}: ${display}\n`, 'utf8');
    const ns = k.includes('.') ? k.slice(0, k.indexOf('.')) : k;
    const agg = byNs.get(ns) ?? { entries: 0, bytes: 0 };
    agg.entries += 1;
    agg.bytes += bytes;
    byNs.set(ns, agg);
    totalBytes += bytes;
  }
  const envOverride = process.env.RVR_BOOTSTRAP_MAX_BYTES;
  const budgetBytes = envOverride && Number.isInteger(Number(envOverride)) && Number(envOverride) > 0
    ? Number(envOverride)
    : (loadConfig().bootstrap_max_response_bytes || DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES);
  return {
    tier,
    namespaces: [...byNs.entries()]
      .map(([ns, a]) => ({ ns, entries: a.entries, bytes: a.bytes }))
      .sort((a, b) => b.bytes - a.bytes),
    totalEntries: Object.keys(filtered).length,
    totalBytes,
    budgetBytes,
    fitsBudget: tier === 'full' || totalBytes <= budgetBytes,
  };
}

export function formatContextSizeReport(report: ContextSizeReport): string {
  const lines = [`Context size (tier: ${report.tier}):`];
  for (const n of report.namespaces) {
    lines.push(`  ${n.ns.padEnd(14)} ${String(n.entries).padStart(4)} entries  ${String(n.bytes).padStart(8)}B`);
  }
  lines.push(`  ${'total'.padEnd(14)} ${String(report.totalEntries).padStart(4)} entries  ${String(report.totalBytes).padStart(8)}B`);
  lines.push(report.tier === 'full'
    ? `Budget: ${report.budgetBytes}B (tier "full" bypasses the budget)`
    : `Budget: ${report.budgetBytes}B — entry bytes ${report.fitsBudget ? 'fit' : 'EXCEED the budget; a bootstrap at this tier will shed'} (response overhead excluded)`);
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
  const tier = (options.tier ?? 'standard') as 'essential' | 'standard' | 'full';

  const flat = getEntriesFlat(scope);

  // Size projection (#127): report what a bootstrap would cost instead of
  // paying it. Skips handoff/shed/render entirely.
  if (options.sizeOnly) {
    const report = computeContextSizes(flat, tier);
    if (isJsonMode()) {
      setResult(report);
    } else {
      console.log(formatContextSizeReport(report));
    }
    return;
  }

  const filtered = filterEntriesByTier(flat, tier);
  const aliases = loadAliases(scope);
  const meta = scope === 'global' ? loadMeta('global') : loadMetaMerged();

  // Handoff banner runs against the unfiltered map — it must render
  // regardless of tier since its whole point is to be impossible to miss
  // on session bootstrap (#91). When rendered, the key is dropped from
  // the entries list below so the content isn't duplicated.
  const handoff = buildHandoffBanner(flat, meta);
  if (handoff) {
    delete filtered[HANDOFF_KEY];
  }

  if (!handoff && Object.keys(filtered).length === 0 && Object.keys(aliases).length === 0) {
    if (!options.plain) {
      console.log(color.gray(`No entries stored. Add one with "${getBinaryName()} set <key> <value>"`));
    }
    return;
  }

  // Apply size-budget shed (#100) before either output path. tier:"full"
  // bypasses entirely. JSON output gets the shed too — agents that pipe
  // CLI output into a model hit the same host caps as direct MCP calls.
  let shedSegments: import('../utils/contextBudget').ShedSegment[] = [];
  let pathologicalOverflow = false;
  let kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(filtered)) {
    kept[k] = isEncrypted(v) ? '[encrypted]' : v;
  }
  if (tier !== 'full') {
    const envOverride = process.env.RVR_BOOTSTRAP_MAX_BYTES;
    const budget = envOverride && Number.isInteger(Number(envOverride)) && Number(envOverride) > 0
      ? Number(envOverride)
      : (loadConfig().bootstrap_max_response_bytes || DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES);

    // Estimate non-entry overhead using Buffer.byteLength for accurate UTF-8
    // byte counts — covers handoff banner, aliases section, tier footer, and a
    // conservative allowance for the shed-notice line itself.
    let fixedOverheadBytes = 0;
    if (handoff) {
      for (const line of handoff.lines) fixedOverheadBytes += Buffer.byteLength(`${line}\n`, 'utf8');
      fixedOverheadBytes += 1; // blank line separator
    }
    if (Object.keys(aliases).length > 0) {
      fixedOverheadBytes += Buffer.byteLength('\nAliases:\n', 'utf8');
      for (const [a, t] of Object.entries(aliases)) {
        fixedOverheadBytes += Buffer.byteLength(`  ${a} -> ${t}\n`, 'utf8');
      }
    }
    // Tier footer always present in this branch (tier !== 'full').
    // Use pre-shed entry count as an upper bound on footer length.
    const preSheddableCount = Object.keys(kept).length;
    fixedOverheadBytes += Buffer.byteLength(`\n[tier: ${tier} (${preSheddableCount} entries) — use --tier full for complete context]\n`, 'utf8');
    // Conservative budget for the shed-notice line (emitted only when shedding
    // occurs, but including it here prevents the notice itself from pushing the
    // final output over budget).
    fixedOverheadBytes += 256;

    const decision = shedToFitBudget(kept, (k) => getStalenessTag(k, meta), fixedOverheadBytes, budget);
    kept = decision.kept;
    shedSegments = decision.segments;
    pathologicalOverflow = decision.pathologicalOverflow;
  }

  // JSON output — payload goes inside the WS1 envelope's `result`. The shed
  // and pathological notices are surfaced both in the result (degraded/
  // shedNamespaces, as before for MCP parity) and in the envelope's
  // warnings[] so agents that only inspect warnings still see them.
  if (isJsonMode()) {
    const result: Record<string, unknown> = {};
    if (handoff) {
      result.handoff = {
        value: flat[HANDOFF_KEY],
        ageDays: handoff.ageDays,
        stale: handoff.isStale,
      };
    }
    if (Object.keys(kept).length > 0) {
      result.entries = kept;
    }
    if (Object.keys(aliases).length > 0) {
      result.aliases = aliases;
    }
    result.tier = tier;
    if (shedSegments.length > 0 || pathologicalOverflow) {
      result.degraded = true;
      result.shedNamespaces = shedSegments.map(s => s.label);
    }
    if (pathologicalOverflow) {
      result.pathologicalOverflow = true;
    }
    if (shedSegments.length > 0) addWarning(formatShedNotice(shedSegments));
    if (pathologicalOverflow) addWarning(PATHOLOGICAL_OVERFLOW_NOTICE);
    setResult(result);
    return;
  }

  // Shed notice — first thing the reader sees, ahead of the handoff banner
  // and entries (#100).
  if (shedSegments.length > 0) {
    const notice = formatShedNotice(shedSegments);
    console.log(options.plain ? notice : color.yellow(notice));
    console.log('');
  }
  if (pathologicalOverflow) {
    console.log(options.plain ? PATHOLOGICAL_OVERFLOW_NOTICE : color.yellow(PATHOLOGICAL_OVERFLOW_NOTICE));
    console.log('');
  }

  // Formatted output — banner first so it's the first thing the reader sees.
  if (handoff) {
    for (const line of handoff.lines) {
      if (options.plain) {
        console.log(line);
      } else {
        const colored = line.startsWith('→')
          ? (handoff.isStale ? color.yellow(line) : color.cyan(line))
          : color.white(line);
        console.log(colored);
      }
    }
    if (Object.keys(kept).length > 0 || Object.keys(aliases).length > 0) {
      console.log('');
    }
  }

  if (Object.keys(kept).length > 0) {
    for (const [k, displayVal] of Object.entries(kept)) {
      const ageTag = getStalenessTag(k, meta);
      if (options.plain) {
        console.log(`${k}: ${displayVal}${ageTag}`);
      } else {
        console.log(`${color.cyan(k)}: ${displayVal}${ageTag ? color.yellow(ageTag) : ''}`);
      }
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

  if (tier !== 'full') {
    const entryCount = Object.keys(kept).length;
    console.log('');
    const msg = `[tier: ${tier} (${entryCount} entries) — use --tier full for complete context]`;
    console.log(options.plain ? msg : color.gray(msg));
  }
}
