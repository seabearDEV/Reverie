// Store files that exist but do not parse (#215, step 1).
//
// A store is committed to git, so two committers writing the same key leave
// conflict markers in `<key>.json` (or in a sidecar) at the next merge. The
// store used to skip such a file behind a debug line, which made a conflict
// indistinguishable from an absence: `get` said "not found", the bootstrap
// showed no handoff, and the next `set` replaced the file — discarding both
// sides of the conflict without a word. An unparseable store file is an
// error, and this module is the vocabulary for saying so.
//
// No store imports here: directoryStore.ts, store.ts and the commands all
// depend on this file.

import path from 'path';

export type UnreadableKind = 'entry' | 'aliases' | 'confirm';

/** `conflict`: git conflict markers. `parse`: anything else that fails to parse. */
export type UnreadableReason = 'conflict' | 'parse';

export interface UnreadableFile {
  kind: UnreadableKind;
  /** Absolute path of the file on disk. */
  path: string;
  /** The entry's dotted key, for kind 'entry'. */
  key?: string;
  reason: UnreadableReason;
}

/**
 * Classify a file that has ALREADY failed to parse. Never call this on a file
 * that parses: a valid entry can hold `<<<<<<<` inside its (escaped) value,
 * and a line-anchored match cannot tell on its own.
 */
export function classifyUnparseable(raw: string): UnreadableReason {
  return /^<{7}(?: |\r?$)/m.test(raw) && /^>{7}(?: |\r?$)/m.test(raw) ? 'conflict' : 'parse';
}

let absoluteDisplayPaths = false;

/**
 * Always name files by absolute path. The MCP server turns this on: it takes
 * its project from RVR_PROJECT or the client's roots, not from its own
 * working directory, so a path relative to that directory points nowhere the
 * reader is — and the fix the messages print is a command to paste.
 */
export function setAbsoluteDisplayPaths(on: boolean): void {
  absoluteDisplayPaths = on;
}

/**
 * Path as the user would type it: relative when it is under the cwd. Never
 * relative to a filesystem root — `path.relative('/', p)` only strips the
 * leading slash, which names a file that exists from nowhere else.
 */
export function displayPath(p: string): string {
  if (absoluteDisplayPaths) return p;
  const cwd = process.cwd();
  if (path.parse(cwd).root === cwd) return p;
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

function subject(f: UnreadableFile): string {
  if (f.kind === 'entry') return `entry '${f.key ?? path.basename(f.path, '.json')}'`;
  return f.kind === 'aliases' ? 'the alias map' : 'the confirmation list';
}

/** `<path> has unresolved git conflict markers` / `<path> is not a valid store file`. */
export function describeUnreadable(f: UnreadableFile): string {
  const why = f.reason === 'conflict' ? 'has unresolved git conflict markers' : 'is not a valid store file';
  return `${displayPath(f.path)} ${why}`;
}

/**
 * How to get out of it. For a conflict the only supported resolution is
 * whole-file: one side or the other. Hand-merging the JSON is not suggested —
 * `_README.md` declares hand edits unsupported. The commands are written so
 * that copying the first one verbatim is valid, and the choice of side is
 * named as the user's: an agent that picks one to unblock itself discards
 * the other committer's entry.
 */
export function resolutionHint(f: UnreadableFile): string {
  return f.reason === 'conflict' ? conflictHint(displayPath(f.path)) : restoreHint(`Restore ${displayPath(f.path)}`, 'that file');
}

function conflictHint(p: string): string {
  return `Which side to keep is the user's call: \`git checkout --ours -- ${p}\` (or \`--theirs\`), then \`git add ${p}\`.`;
}

/**
 * For a file that is simply not valid (truncated, emptied, hand-edited).
 * "Delete it by hand" is spelled out because the store offers no way to:
 * `rm` refuses a file it cannot read, as it does for a conflict, and reset
 * leaves it in place.
 */
function restoreHint(lead: string, it: string): string {
  return `${lead} from version control or a backup, or delete ${it} by hand (the store will not remove a file it cannot read).`;
}

/**
 * The fix stated once for a list of files: one line when they are all the
 * same kind of broken, two labelled lines when the list mixes conflicts with
 * files that are merely invalid — the git commands do nothing for those.
 */
function sharedHints(files: UnreadableFile[]): string[] {
  const conflict = files.some(f => f.reason === 'conflict');
  const parse = files.some(f => f.reason === 'parse');
  if (conflict && parse) {
    const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
    return [
      `With conflict markers: ${lower(conflictHint('<file>'))}`,
      `Not a valid store file: ${lower(restoreHint('Restore each', 'it'))}`,
    ];
  }
  return [conflict ? conflictHint('<file>') : restoreHint('Restore each', 'it')];
}

/** What the store is doing without the file. */
function consequence(f: UnreadableFile): string {
  if (f.kind === 'entry') return `${subject(f)} is not being read`;
  return f.kind === 'aliases' ? 'no aliases are being read' : 'every entry is treated as requiring confirmation to run';
}

/** One self-contained line per file — `warnings[]` and MCP text blocks. */
export function unreadableWarning(f: UnreadableFile): string {
  return `${describeUnreadable(f)} — ${consequence(f)}. ${resolutionHint(f)}`;
}

/**
 * The same report as one block, for a terminal: what is wrong with each file
 * and what it costs, then the fix once. Empty when there is nothing to say.
 */
export function unreadableWarningBlock(files: UnreadableFile[]): string[] {
  if (files.length === 0) return [];
  if (files.length === 1) return [`warning: ${unreadableWarning(files[0])}`];
  const lines = [`warning: ${files.length} store files cannot be read:`];
  for (const f of files) lines.push(`  ${describeUnreadable(f)} — ${consequence(f)}`);
  for (const hint of sharedHints(files)) lines.push(`  ${hint}`);
  return lines;
}

function buildMessage(files: UnreadableFile[], attempted: 'read' | 'write', lead?: string): string {
  const f = files[0];
  const more = files.length > 1 ? ` (and ${files.length - 1} more unreadable file${files.length > 2 ? 's' : ''})` : '';
  if (lead !== undefined) {
    return `${lead}: ${describeUnreadable(f)}${more}. Nothing was written. ${resolutionHint(f)} Then retry.`;
  }
  if (attempted === 'read') {
    return `Cannot read ${subject(f)}: ${describeUnreadable(f)}${more}. It exists; this is not "not found". ${resolutionHint(f)}`;
  }
  // "Both sides" is true of a conflict only; a truncated file has no sides.
  const lost = f.kind === 'entry' ? (f.reason === 'conflict' ? 'both sides of it' : 'what is left of it')
    : f.kind === 'aliases' ? 'every alias in it' : 'every confirmation flag in it';
  return `Refusing to write ${subject(f)}: ${describeUnreadable(f)}${more}, and writing would discard ${lost}. Nothing was written. ${resolutionHint(f)} Then retry.`;
}

/**
 * Thrown when a read targets, or a write would replace, a store file that
 * does not parse. Carries code 'STORE_UNREADABLE' — deliberately not
 * NOT_FOUND, which is what sends an agent off to write a fresh entry.
 */
export class StoreUnreadableError extends Error {
  readonly code = 'STORE_UNREADABLE';
  readonly files: UnreadableFile[];
  readonly attempted: 'read' | 'write';

  /**
   * `lead` replaces the opening clause for a refusal that is not "this very
   * file would be replaced" — a write beside an unreadable entry, or an
   * operation on its parent. It names what was refused and why.
   */
  constructor(files: UnreadableFile[], attempted: 'read' | 'write', lead?: string) {
    super(buildMessage(files, attempted, lead));
    this.name = 'StoreUnreadableError';
    this.files = files;
    this.attempted = attempted;
  }
}

/**
 * Existence pre-read for a key a command is about to write: the overwrite
 * prompt, a copy or rename destination. `read` looks the key up the way reads
 * do — in auto scope that falls through from the project store to the global
 * one — and the healthy path is exactly that lookup: a value that exists only
 * in the global store still counts as "already exists".
 *
 * A file that does not parse is a refused write only if it sits in the store
 * the write will land in. An unreadable global file must not block a write to
 * the project store, which would never touch it. So when the lookup fails on
 * one, ask again in the write's own store (`writeScope`; if that cannot be
 * resolved, its error is the precise one and propagates), and re-word a
 * failure there as the refused write it is.
 */
export function readForWrite<T, S>(read: (scope: S | undefined) => T, scope: S | undefined, writeScope: () => S): T {
  try {
    return read(scope);
  } catch (err) {
    if (!(err instanceof StoreUnreadableError) || err.attempted !== 'read') throw err;
    const target = writeScope();
    try {
      return read(target);
    } catch (inner) {
      if (inner instanceof StoreUnreadableError && inner.attempted === 'read') {
        throw new StoreUnreadableError(inner.files, 'write');
      }
      throw inner;
    }
  }
}

// ── Bootstrap block ────────────────────────────────────────────────────

const BOOTSTRAP_LIST_CAP = 8;

/**
 * Lines that lead a bootstrap when the store holds unreadable files. They go
 * first, ahead of the handoff banner: the usual casualty is the handoff
 * itself, and a harness that persists a large result shows only its opening
 * 2 KB. Empty when there is nothing to report.
 */
export function bootstrapUnreadableLines(files: UnreadableFile[]): string[] {
  if (files.length === 0) return [];
  const n = files.length;
  const lines = [
    `!! ${n} store file${n === 1 ? '' : 's'} cannot be read. ${n === 1 ? 'It is' : 'They are'} NOT shown below and NOT missing — do not write over ${n === 1 ? 'it' : 'them'}:`,
  ];
  for (const f of bootstrapListed(files)) {
    const what = f.kind === 'entry' ? (f.key ?? path.basename(f.path, '.json')) : f.kind === 'aliases' ? '(alias map)' : '(confirmation list)';
    lines.push(`   ${what} — ${describeUnreadable(f)}`);
  }
  if (n > BOOTSTRAP_LIST_CAP) lines.push(`   … and ${n - BOOTSTRAP_LIST_CAP} more`);
  for (const hint of sharedHints(files)) lines.push(`   ${hint}`);
  return lines;
}

/**
 * The files the bootstrap block names; past the cap it only counts the rest.
 * Callers mark these — not all of them — as shown, so the files the block
 * left out are still named by the surface's own warning channel.
 */
export function bootstrapListed(files: UnreadableFile[]): UnreadableFile[] {
  return files.slice(0, BOOTSTRAP_LIST_CAP);
}

// ── "Already shown" bookkeeping ────────────────────────────────────────
// The CLI wrapper warns about unreadable files after any command whose reads
// turned some up. Output that already named a file — the text bootstrap and
// `lint` list them all; a refusal names its own — records it here, so the
// wrapper does not print the same file twice.

let shownAll = false;
const shownPaths = new Set<string>();

/** Record files as already shown to the user; with no argument, all of them. */
export function markUnreadableShown(files?: UnreadableFile[]): void {
  if (!files) {
    shownAll = true;
    return;
  }
  for (const f of files) shownPaths.add(f.path);
}

/** A refused write was rendered by a command's own error handling (the wrapper never saw the throw). */
let writeRefused = false;

export function noteWriteRefused(): void {
  writeRefused = true;
}

/** Read and clear: did this command render a refused write? */
export function takeWriteRefused(): boolean {
  const was = writeRefused;
  writeRefused = false;
  return was;
}

/** Drop the files already shown, and reset the bookkeeping. */
export function withoutShown(files: UnreadableFile[]): UnreadableFile[] {
  const rest = shownAll ? [] : files.filter(f => !shownPaths.has(f.path));
  shownAll = false;
  shownPaths.clear();
  return rest;
}

// ── Registry ───────────────────────────────────────────────────────────
// store.ts registers one source per store singleton; everything else asks
// here. Keeping the question out of store.ts means the many suites that mock
// that module need no new export, and a mocked store simply reports nothing.

interface UnreadableSource {
  list: () => UnreadableFile[];
  /** Scan the store now, so `list` is current. */
  refresh?: (() => void) | undefined;
}

const sources = new Map<string, UnreadableSource>();

/**
 * Register (or replace) a named source of unreadable files — store.ts uses
 * the ids 'project' and 'global'. Listed in registration order.
 */
export function registerUnreadableSource(id: string, list: () => UnreadableFile[], refresh?: () => void): void {
  sources.set(id, { list, refresh });
}

/**
 * Store files that exist but did not parse, across every store this process
 * has already scanned — or only the store `sourceId` names. Does no I/O: it
 * reports what the command's own reads turned up, and never fails.
 */
export function listUnreadableFiles(sourceId?: string): UnreadableFile[] {
  const files: UnreadableFile[] = [];
  const seen = new Set<string>();
  for (const [id, source] of sources) {
    if (sourceId !== undefined && id !== sourceId) continue;
    try {
      for (const f of source.list()) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        files.push(f);
      }
    } catch { /* a source that cannot answer has nothing to report */ }
  }
  return files;
}

/**
 * Pre-flight for a command that writes more than one store file. save()
 * refuses to rewrite an unreadable sidecar, but it is called once per file:
 * `set k v -a alias` writes the value and only then meets the refusal on the
 * alias map; `rename` moves the value before it reaches the flags. Checking
 * every sidecar the command will touch before its first write keeps "nothing
 * was written" true for the command, not just for one save.
 *
 * `target` resolves the store the command writes to ('project' | 'global').
 * If it throws, the write has no resolvable target and will refuse on its own
 * with the precise error (PROJECT_UNRESOLVED) — this check stays out of the
 * way. Scans that store first. A no-op when no such store is registered (a
 * mocked store).
 */
export function assertSidecarsWritable(target: () => string, kinds: ('aliases' | 'confirm')[]): void {
  let sourceId: string;
  try {
    sourceId = target();
  } catch {
    return;
  }
  const source = sources.get(sourceId);
  if (!source) return;
  source.refresh?.();
  const broken = source.list().filter(f => f.kind !== 'entry' && kinds.includes(f.kind));
  if (broken.length > 0) throw new StoreUnreadableError(broken, 'write');
}

/**
 * The refusal for a write to an ancestor or a descendant of an unreadable
 * entry. `a.b` and `a.b.c` cannot both be stored: one is a leaf where the
 * other needs a subtree. While `a.b.json` cannot be read the store does not
 * know it is there, so a write to `a.b.c` would land beside it — and once the
 * file is resolved, the next full save deletes one of the two.
 */
export function nameCollisionError(key: string, file: UnreadableFile): StoreUnreadableError {
  const other = file.key ?? path.basename(file.path, '.json');
  const lower = key.toLowerCase();
  const otherLower = other.toLowerCase();
  // Keys compare case-insensitively (#216): a spelling that differs only by
  // case is the same file on a case-insensitive filesystem.
  const message = lower === otherLower
    ? `Refusing to write '${key}': it differs only by case from ${subject(file)}, which cannot be read (the two cannot both exist)`
    : `Refusing to write '${key}' ${lower.startsWith(`${otherLower}.`) ? 'under' : 'over'} ${subject(file)}, which cannot be read (the two cannot both exist)`;
  return new StoreUnreadableError([file], 'write', message);
}

/**
 * Can `key` and `other` not both be stored? True when one is an ancestor of
 * the other in the dotted-key tree, or when they differ only by case —
 * compared case-insensitively, as every key collision is (#216). The same
 * key, spelled the same way, is not a collision.
 */
export function keysCollide(key: string, other: string): boolean {
  if (key === other) return false;
  const lower = key.toLowerCase();
  const otherLower = other.toLowerCase();
  return lower === otherLower || lower.startsWith(`${otherLower}.`) || otherLower.startsWith(`${lower}.`);
}

/**
 * Pre-flight for a command that removes or moves a whole subtree. The command
 * sees only the entries it can read: an unreadable one under `key` would be
 * left on disk while the cascade drops (or re-points) its alias and its
 * confirmation flag — so that once the file is resolved, an entry that
 * required confirmation runs without it. Refuse before anything changes.
 * Same contract as assertSidecarsWritable: scans the target store first, and
 * stays out of the way when the target cannot be resolved or is not registered.
 */
export function assertSubtreeReadable(target: () => string, key: string, verb: 'remove' | 'rename'): void {
  let sourceId: string;
  try {
    sourceId = target();
  } catch {
    return;
  }
  const source = sources.get(sourceId);
  if (!source) return;
  source.refresh?.();
  const prefix = `${key}.`;
  const broken = source.list().filter(f => f.kind === 'entry' && f.key?.startsWith(prefix));
  if (broken.length > 0) {
    throw new StoreUnreadableError(broken, 'write', `Refusing to ${verb} '${key}' while ${subject(broken[0])} under it cannot be read`);
  }
}

/**
 * True while any scanned store's confirmation list is unreadable. The `run`
 * gates OR this with the entry's own flag, so they fail closed: a conflicted
 * `_confirm.json` loads as empty, and "no flag" would run entries that
 * required confirmation. Call after the flag lookup, which does the scan.
 * Kept apart from hasConfirm(), which answers from the list as loaded. A
 * rename does not answer at all while a list is unreadable: it refuses
 * (rename.ts, #245).
 */
export function confirmListUnreadable(): boolean {
  return listUnreadableFiles().some(f => f.kind === 'confirm');
}
