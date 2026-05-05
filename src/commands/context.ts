import { getEntriesFlat, Scope } from '../storage';
import { loadAliases } from '../alias';
import { loadMeta, loadMetaMerged, getStalenessTag } from '../store';
import { isEncrypted } from '../utils/crypto';
import { color } from '../formatting';
import { getBinaryName } from '../utils/binaryName';
import { HANDOFF_KEY, buildHandoffBanner } from '../utils/handoff';
import { shedToFitBudget, formatShedNotice } from '../utils/contextBudget';
import { loadConfig } from '../config';

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

// ── CLI context command ──────────────────────────────────────────────

export interface ContextOptions {
  tier?: string | undefined;
  global?: boolean | undefined;
  plain?: boolean | undefined;
  json?: boolean | undefined;
}

export function showContext(options: ContextOptions = {}): void {
  const scope: Scope | undefined = options.global ? 'global' : undefined;
  const tier = (options.tier ?? 'standard') as 'essential' | 'standard' | 'full';

  const flat = getEntriesFlat(scope);
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
  let kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(filtered)) {
    kept[k] = isEncrypted(v) ? '[encrypted]' : v;
  }
  if (tier !== 'full') {
    const envOverride = process.env.CODEX_BOOTSTRAP_MAX_BYTES;
    const budget = envOverride && Number.isInteger(Number(envOverride)) && Number(envOverride) > 0
      ? Number(envOverride)
      : (loadConfig().bootstrap_max_response_bytes || 50 * 1024);
    const decision = shedToFitBudget(kept, (k) => getStalenessTag(k, meta), 0, budget);
    kept = decision.kept;
    shedSegments = decision.segments;
  }

  // JSON output
  if (options.json) {
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
    if (shedSegments.length > 0) {
      result.degraded = true;
      result.shedNamespaces = shedSegments.map(s => s.label);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Shed notice — first thing the reader sees, ahead of the handoff banner
  // and entries (#100).
  if (shedSegments.length > 0) {
    const notice = formatShedNotice(shedSegments);
    console.log(options.plain ? notice : color.yellow(notice));
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
