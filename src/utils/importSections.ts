import { deepMerge } from './deepMerge';
import { expandFlatKeys, flattenObject } from './objectPath';
import { assertKeysWritable } from './keyCollision';
import { assertAliasNamesFree, entryKeysIn } from './aliasNames';
import type { CodexData } from '../types';

export interface ImportSections {
  entries?: CodexData;
  aliases?: Record<string, string>;
  confirm?: Record<string, true>;
  /** #267: the hidden entries a replace drops (see UnifiedData.removed). */
  removed?: string[];
}

/**
 * Compute the final per-section payloads for an import — the single
 * cross-surface contract (#133). A section the import file OMITS is left
 * untouched, on both surfaces, for every type including 'all' with
 * merge:false. "Replace" replaces the sections present in the file, never
 * the ones absent from it: the preview only ever diffs present sections,
 * and deliberate wipes are reset's job.
 *
 * Current-state loaders are passed lazily so this stays pure (the alias
 * check aside, which asks the filesystem which file a name opens) and a
 * surface never pays a load for a section its file doesn't carry. CLI and
 * MCP import must both build their payload here, inside updateAll, from the
 * state it hands them under the store lock (#254) — do not reintroduce
 * surface-local section math, or a merge base loaded before the lock.
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
    /** #267: entries stored under another entry, which `entries()` cannot show. */
    hidden?: () => readonly string[];
    /** #279: the entry keys of the store the import does not write, read before the lock. */
    otherEntryKeys?: () => readonly string[];
  },
): ImportSections {
  const next: ImportSections = {};
  const incoming = sections.entries ? expandFlatKeys(sections.entries) : undefined;
  assertImportedAliasesFree(sections, merge, current);
  if (sections.entries && incoming) {
    if (merge) {
      const existing = current.entries();
      // An empty group names no entry. Merged as-is it replaced a leaf at
      // that key with nothing; it is a no-op.
      const incomingEntries = pruneEmptyBranches(incoming);
      // #216 / #224: a merge adds and overwrites keys; it does not get to
      // remove the entries under a key it flattens, the leaf above a key it
      // nests, or a key that differs only by case. Checked against the store
      // as it stands, before anything is merged. `current` must be the one
      // store being written, never a view layered over another store.
      assertKeysWritable(existing, Object.keys(flattenObject(incomingEntries)));
      next.entries = deepMerge(existing, incomingEntries) as CodexData;
    } else {
      next.entries = incoming as CodexData;
      // #267: a replace replaces every entry, the ones stored under another
      // entry (`ns.k.sub` beside `ns.k`) too. The tree cannot show them, so
      // the store keeps them unless the write names them: a replace that
      // kept `ns.k` kept a hidden `ns.k.sub` — and dropped its flag when the
      // file replaced the confirmation list, so it ran unconfirmed.
      const kept = flattenObject(incoming);
      const removed = (current.hidden?.() ?? []).filter(k => !Object.hasOwn(kept, k));
      if (removed.length > 0) next.removed = removed;
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

/**
 * #279: an imported alias must not be named after an entry. An alias stands
 * in for the entry of its name wherever the name is used, and a merge import
 * could put one over a confirm-gated entry. Refused, merge or replace: a name
 * that is the key of an entry the store will hold after the import (its
 * entries now, or the file's in place of them for a replace that brings
 * entries), of one this file brings, or of one in the other store — under
 * that spelling, another case, or a spelling the filesystem opens its file
 * under. An alias the store already has, with the same target, adds nothing
 * and passes (a file imported back into the store it came from). Throws the
 * refusal (KeyCollisionError, INVALID_INPUT).
 *
 * computeImportSections runs it under the store lock; a preview runs it on
 * the store as it stands, so a preview does not show an import that the
 * apply then refuses.
 */
export function assertImportedAliasesFree(
  sections: { entries?: Record<string, unknown> | undefined; aliases?: Record<string, unknown> | undefined },
  merge: boolean,
  current: {
    entries: () => CodexData;
    aliases: () => Record<string, string>;
    hidden?: () => readonly string[];
    otherEntryKeys?: () => readonly string[];
  },
): void {
  const aliases = sections.aliases;
  if (!aliases) return;
  const have = current.aliases();
  const added = Object.keys(aliases).filter(name => !(Object.hasOwn(have, name) && have[name] === aliases[name]));
  if (added.length === 0) return;
  const incoming = sections.entries ? Object.keys(flattenObject(expandFlatKeys(sections.entries))) : [];
  const kept = merge || !sections.entries ? entryKeysIn({ entries: current.entries(), hidden: current.hidden?.() }) : [];
  assertAliasNamesFree(added, [...kept, ...incoming, ...(current.otherEntryKeys?.() ?? [])]);
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
