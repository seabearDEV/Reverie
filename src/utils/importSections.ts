import { deepMerge } from './deepMerge';
import { expandFlatKeys, flattenObject } from './objectPath';
import { assertKeyWritable } from './keyCollision';
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
  },
): ImportSections {
  const next: ImportSections = {};
  if (sections.entries) {
    const incoming = expandFlatKeys(sections.entries);
    if (merge) {
      const existing = current.entries();
      // #216 / #224: a merge adds and overwrites keys; it does not get to
      // remove the entries under a key it flattens, the leaf above a key it
      // nests, or a key that differs only by case. Checked against the store
      // as it stands, before anything is merged.
      for (const leafKey of Object.keys(flattenObject(incoming))) {
        assertKeyWritable(existing, leafKey);
      }
      next.entries = deepMerge(existing, incoming) as CodexData;
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
