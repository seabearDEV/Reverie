import { deepMerge } from './deepMerge';
import { expandFlatKeys, flattenObject } from './objectPath';
import { assertKeysWritable } from './keyCollision';
import type { CodexData } from '../types';

export interface ImportSections {
  entries?: CodexData;
  aliases?: Record<string, string>;
  confirm?: Record<string, true>;
}

/**
 * Compute the final per-section payloads for an import — the single
 * cross-surface contract (#133). A section the import file OMITS is left
 * untouched, on both surfaces, for every type including 'all' with
 * merge:false. "Replace" replaces the sections present in the file, never
 * the ones absent from it: the preview only ever diffs present sections,
 * and deliberate wipes are reset's job.
 *
 * Current-state loaders are passed lazily so this stays pure and a surface
 * never pays a load for a section its file doesn't carry. CLI and MCP
 * import must both build their saveAll payload here — do not reintroduce
 * surface-local section math.
 */
export function computeImportSections(
  sections: {
    entries?: Record<string, unknown> | undefined;
    aliases?: Record<string, string> | undefined;
    confirm?: Record<string, true> | undefined;
  },
  merge: boolean,
  current: {
    entries: () => CodexData;
    aliases: () => Record<string, string>;
    confirm: () => Record<string, true>;
    /**
     * The entries of the one store the import writes to, for the collision
     * check. `entries` may be a merged view (project over global in the
     * default scope); a key that exists only in the other store is not in the
     * way of a write to this one. Falls back to `entries`.
     */
    targetEntries?: () => CodexData;
  },
): ImportSections {
  const next: ImportSections = {};
  if (sections.entries) {
    const incoming = expandFlatKeys(sections.entries);
    if (merge) {
      const existing = current.entries();
      // An empty group names no entry. Merged as-is it replaced a leaf at
      // that key with nothing; it is a no-op.
      const incomingEntries = pruneEmptyBranches(incoming);
      // #216 / #224: a merge adds and overwrites keys; it does not get to
      // remove the entries under a key it flattens, the leaf above a key it
      // nests, or a key that differs only by case. Checked against the store
      // being written, as it stands, before anything is merged.
      assertKeysWritable(current.targetEntries?.() ?? existing, Object.keys(flattenObject(incomingEntries)));
      next.entries = deepMerge(existing, incomingEntries) as CodexData;
    } else {
      next.entries = incoming as CodexData;
    }
  }
  if (sections.aliases) {
    next.aliases = merge ? { ...current.aliases(), ...sections.aliases } : sections.aliases;
  }
  if (sections.confirm) {
    next.confirm = merge ? { ...current.confirm(), ...sections.confirm } : sections.confirm;
  }
  return next;
}

/** A copy of `node` without groups that hold no entry at any depth. */
function pruneEmptyBranches(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const pruned = pruneEmptyBranches(value as Record<string, unknown>);
      if (Object.keys(pruned).length > 0) out[key] = pruned;
    } else {
      out[key] = value;
    }
  }
  return out;
}
