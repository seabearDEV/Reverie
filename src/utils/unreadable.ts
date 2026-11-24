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

/** Path as the user would type it: relative when it is under the cwd. */
export function displayPath(p: string): string {
  const rel = path.relative(process.cwd(), p);
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
  return f.reason === 'conflict' ? conflictHint(displayPath(f.path)) : `Restore ${displayPath(f.path)} from version control or a backup, or remove it.`;
}

function conflictHint(p: string): string {
  return `Which side to keep is the user's call: \`git checkout --ours -- ${p}\` (or \`--theirs\`), then \`git add ${p}\`.`;
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
  lines.push(`  ${files.some(f => f.reason === 'conflict') ? conflictHint('<file>') : 'Restore each from version control or a backup, or remove it.'}`);
  return lines;
}

function buildMessage(files: UnreadableFile[], attempted: 'read' | 'write'): string {
  const f = files[0];
  const more = files.length > 1 ? ` (and ${files.length - 1} more unreadable file${files.length > 2 ? 's' : ''})` : '';
  if (attempted === 'read') {
    return `Cannot read ${subject(f)}: ${describeUnreadable(f)}${more}. It exists; this is not "not found". ${resolutionHint(f)}`;
  }
  const lost = f.kind === 'entry' ? 'both sides of it' : f.kind === 'aliases' ? 'every alias in it' : 'every confirmation flag in it';
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

  constructor(files: UnreadableFile[], attempted: 'read' | 'write') {
    super(buildMessage(files, attempted));
    this.name = 'StoreUnreadableError';
    this.files = files;
    this.attempted = attempted;
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
  for (const f of files.slice(0, BOOTSTRAP_LIST_CAP)) {
    const what = f.kind === 'entry' ? (f.key ?? path.basename(f.path, '.json')) : f.kind === 'aliases' ? '(alias map)' : '(confirmation list)';
    lines.push(`   ${what} — ${describeUnreadable(f)}`);
  }
  if (n > BOOTSTRAP_LIST_CAP) lines.push(`   … and ${n - BOOTSTRAP_LIST_CAP} more`);
  lines.push(`   ${files.some(f => f.reason === 'conflict') ? conflictHint('<file>') : 'Restore each from version control or a backup, or remove it.'}`);
  return lines;
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

const sources = new Map<string, () => UnreadableFile[]>();

/** Register (or replace) a named source of unreadable files. Listed in registration order. */
export function registerUnreadableSource(id: string, source: () => UnreadableFile[]): void {
  sources.set(id, source);
}

/**
 * Store files that exist but did not parse, across every store this process
 * has already scanned. Does no I/O: it reports what the command's own reads
 * turned up, and never fails.
 */
export function listUnreadableFiles(): UnreadableFile[] {
  const files: UnreadableFile[] = [];
  const seen = new Set<string>();
  for (const source of sources.values()) {
    try {
      for (const f of source()) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        files.push(f);
      }
    } catch { /* a source that cannot answer has nothing to report */ }
  }
  return files;
}
