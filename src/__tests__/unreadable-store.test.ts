// #215 step 1 — a store file that exists but does not parse is an error, not
// an absence. Store-layer and vocabulary tests; the command surfaces are in
// unreadable-cli.test.ts and mcp-integration.test.ts.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDirectoryStore, serializeEntryWrapper } from '../utils/directoryStore';
import type { UnifiedData } from '../store';
import {
  StoreUnreadableError,
  UnreadableFile,
  assertSidecarsWritable,
  bootstrapUnreadableLines,
  classifyUnparseable,
  confirmListUnreadable,
  describeUnreadable,
  displayPath,
  listUnreadableFiles,
  markUnreadableShown,
  noteWriteRefused,
  readForWrite,
  registerUnreadableSource,
  resolutionHint,
  setAbsoluteDisplayPaths,
  takeWriteRefused,
  unreadableWarning,
  unreadableWarningBlock,
  withoutShown,
} from '../utils/unreadable';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-unreadable-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const makeStore = () => createDirectoryStore(() => dir, () => { fs.mkdirSync(dir, { recursive: true }); });

/** What `git merge` leaves in an entry file both sides rewrote. */
const conflictedEntry = (ours: string, theirs: string): string => [
  '{',
  '<<<<<<< HEAD',
  `  "value": ${JSON.stringify(ours)},`,
  '  "meta": {',
  '    "created": 1000,',
  '    "updated": 3000',
  '=======',
  `  "value": ${JSON.stringify(theirs)},`,
  '  "meta": {',
  '    "created": 1000,',
  '    "updated": 2000',
  '>>>>>>> theirs',
  '  }',
  '}',
  '',
].join('\n');

const conflictedSidecar = (ours: string, theirs: string): string =>
  ['{', '<<<<<<< HEAD', `  ${ours}`, '=======', `  ${theirs}`, '>>>>>>> theirs', '}', ''].join('\n');

/**
 * Put `content` at `file` the way git does — remove, then create — and move
 * both mtimes forward, so a store that already scanned the directory sees a
 * change without the test depending on filesystem timestamp granularity.
 */
let tick = 0;
function gitWrite(file: string, content: string): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, content);
  const when = Date.now() / 1000 + 10 * ++tick;
  fs.utimesSync(file, when, when);
  fs.utimesSync(path.dirname(file), when, when);
}

const entryPath = (key: string) => path.join(dir, `${key}.json`);
const epoch = (): number => (JSON.parse(fs.readFileSync(path.join(dir, '_epoch.json'), 'utf8')) as { epoch: number }).epoch;
const data = (entries: UnifiedData['entries'], extra: Partial<UnifiedData> = {}): UnifiedData =>
  ({ entries, aliases: {}, confirm: {}, ...extra });

function expectUnreadable(fn: () => unknown, attempted: 'read' | 'write'): StoreUnreadableError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(StoreUnreadableError);
  const err = thrown as StoreUnreadableError;
  expect(err.code).toBe('STORE_UNREADABLE');
  expect(err.attempted).toBe(attempted);
  return err;
}

/** A store holding two healthy entries and one that both sides of a merge rewrote. */
function storeWithConflict() {
  const store = makeStore();
  store.save(data({ arch: { store: 'healthy' }, context: { next_session: 'base', other: 'kept' } }));
  gitWrite(entryPath('context.next_session'), conflictedEntry('our handoff', 'their handoff'));
  return store;
}

describe('an entry file that does not parse', () => {
  it('is left out of load() but reported, with the conflict named', () => {
    const store = storeWithConflict();
    const loaded = store.load();
    expect(loaded.entries).toEqual({ arch: { store: 'healthy' }, context: { other: 'kept' } });
    expect(store.unreadable()).toEqual([
      { kind: 'entry', path: entryPath('context.next_session'), key: 'context.next_session', reason: 'conflict' },
    ]);
  });

  it('a healthy store reports nothing', () => {
    const store = makeStore();
    store.save(data({ a: { b: 'v' } }));
    store.load();
    expect(store.unreadable()).toEqual([]);
  });

  it('a valid entry whose VALUE contains conflict-marker lines is read normally', () => {
    // Classification happens only after a parse failure: these markers are
    // escaped inside a JSON string and the file parses.
    const store = makeStore();
    const value = 'how to resolve:\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch';
    store.save(data({ docs: { conflicts: value } }));
    expect(makeStore().load().entries).toEqual({ docs: { conflicts: value } });
    expect(store.unreadable()).toEqual([]);
    expect(makeStore().getOne('docs.conflicts')).toBe(value);
  });

  it('getOne() throws instead of reporting a miss; a missing key is still a miss', () => {
    const store = storeWithConflict();
    const err = expectUnreadable(() => store.getOne('context.next_session'), 'read');
    expect(err.files).toEqual([
      { kind: 'entry', path: entryPath('context.next_session'), key: 'context.next_session', reason: 'conflict' },
    ]);
    expect(err.message).toContain('not "not found"');
    expect(store.getOne('context.absent')).toBeUndefined();
    expect(store.getOne('arch.store')).toBe('healthy');
  });

  it('setOne() refuses, and leaves the file and the epoch exactly as they were', () => {
    const store = storeWithConflict();
    const before = fs.readFileSync(entryPath('context.next_session'), 'utf8');
    const epochBefore = epoch();
    const err = expectUnreadable(() => store.setOne('context.next_session', 'fresh handoff', Date.now()), 'write');
    expect(err.message).toContain('Nothing was written');
    expect(fs.readFileSync(entryPath('context.next_session'), 'utf8')).toBe(before);
    expect(epoch()).toBe(epochBefore);
  });

  it('save() refuses a write to that key, all-or-nothing, and leaves the epoch even', () => {
    const store = storeWithConflict();
    const before = fs.readFileSync(entryPath('context.next_session'), 'utf8');
    const loaded = store.load();
    const next = data({
      ...loaded.entries,
      context: { other: 'changed in the same save', next_session: 'fresh handoff', added: 'new key' },
    });
    expectUnreadable(() => store.save(next), 'write');

    expect(fs.readFileSync(entryPath('context.next_session'), 'utf8')).toBe(before);
    // Nothing else from the refused save landed either.
    expect(fs.existsSync(entryPath('context.added'))).toBe(false);
    expect(makeStore().getOne('context.other')).toBe('kept');
    // Readers must not be left looking at a writer that never finishes.
    expect(epoch() % 2).toBe(0);
  });

  it('save() of other keys works around it and never touches or deletes it', () => {
    const store = storeWithConflict();
    const before = fs.readFileSync(entryPath('context.next_session'), 'utf8');
    // The broken key is absent from the loaded data, so a save of that data
    // "does not contain" it. It must not be treated as a deletion.
    const loaded = store.load();
    store.save({ ...loaded, entries: { arch: { store: 'rewritten' } } });

    expect(fs.readFileSync(entryPath('context.next_session'), 'utf8')).toBe(before);
    expect(fs.existsSync(entryPath('context.other'))).toBe(false); // a real deletion still happens
    expect(makeStore().getOne('arch.store')).toBe('rewritten');
  });

  it('save() refuses a write UNDER it: once resolved, the leaf and the child could not both exist', () => {
    const store = storeWithConflict();
    const before = fs.readFileSync(entryPath('context.next_session'), 'utf8');
    const loaded = store.load();
    const err = expectUnreadable(
      () => store.save({ ...loaded, entries: { ...loaded.entries, context: { other: 'kept', next_session: { extra: 'v' } } } }),
      'write',
    );
    expect(err.files.map(f => f.key)).toEqual(['context.next_session']);
    expect(err.message).toMatch(/^Refusing to write 'context\.next_session\.extra' under entry 'context\.next_session'/);
    expect(err.message).toContain('Nothing was written');
    expect(fs.existsSync(entryPath('context.next_session.extra'))).toBe(false);
    expect(fs.readFileSync(entryPath('context.next_session'), 'utf8')).toBe(before);
    expect(epoch() % 2).toBe(0);
  });

  it('save() refuses a write OVER it, to a parent key', () => {
    const store = makeStore();
    store.save(data({ a: { b: { c: 'leaf' } }, z: { keep: 'v' } }));
    gitWrite(entryPath('a.b.c'), conflictedEntry('ours', 'theirs'));
    const loaded = store.load();
    expect(loaded.entries).toEqual({ z: { keep: 'v' } });
    const err = expectUnreadable(() => store.save({ ...loaded, entries: { ...loaded.entries, a: { b: 'now a leaf' } } }), 'write');
    expect(err.message).toMatch(/^Refusing to write 'a\.b' over entry 'a\.b\.c'/);
    expect(fs.existsSync(entryPath('a.b'))).toBe(false);
    expect(epoch() % 2).toBe(0);
  });

  it('a sibling of it is not a name collision', () => {
    const store = storeWithConflict();
    const loaded = store.load();
    store.save({ ...loaded, entries: { ...loaded.entries, context: { other: 'kept', next_sessions: 'plural', next: 'prefix' } } });
    expect(makeStore().getOne('context.next_sessions')).toBe('plural');
    expect(makeStore().getOne('context.next')).toBe('prefix');
  });

  it('classifies other damage as "parse": truncated JSON, and a wrapper with no value', () => {
    const store = makeStore();
    store.save(data({ a: { cut: 'x', bare: 'y', ok: 'z' } }));
    gitWrite(entryPath('a.cut'), '{\n  "value": "trunc');
    gitWrite(entryPath('a.bare'), '{ "meta": { "created": 1, "updated": 2 } }');
    store.load();
    expect(store.unreadable().map(f => [f.key, f.reason])).toEqual([['a.bare', 'parse'], ['a.cut', 'parse']]);
    expectUnreadable(() => store.setOne('a.cut', 'v', Date.now()), 'write');
  });

  it('a long-lived store stops serving the copy it parsed before the file broke', () => {
    const store = makeStore();
    store.save(data({ context: { next_session: 'base' } }));
    expect(store.load().entries).toEqual({ context: { next_session: 'base' } });

    gitWrite(entryPath('context.next_session'), conflictedEntry('ours', 'theirs'));
    expect(store.load().entries).toEqual({});
    expect(store.unreadable()).toHaveLength(1);
  });

  it('is read again, and no longer reported, once it is resolved', () => {
    const store = storeWithConflict();
    store.load();
    expect(store.unreadable()).toHaveLength(1);

    gitWrite(entryPath('context.next_session'), serializeEntryWrapper({ value: 'their handoff', meta: { created: 1000, updated: 2000 } }));
    expect(store.load().entries).toMatchObject({ context: { next_session: 'their handoff' } });
    expect(store.unreadable()).toEqual([]);
    expect(store.setOne('context.next_session', 'next', Date.now())).toBe(true);
  });

  it('removing the broken file clears the report', () => {
    const store = storeWithConflict();
    store.load();
    fs.rmSync(entryPath('context.next_session'));
    const when = Date.now() / 1000 + 1000;
    fs.utimesSync(dir, when, when);
    store.load();
    expect(store.unreadable()).toEqual([]);
  });
});

describe('a sidecar that does not parse', () => {
  const aliasesPath = () => path.join(dir, '_aliases.json');
  const confirmPath = () => path.join(dir, '_confirm.json');

  it('aliases: loads as empty but is reported, and a save that would rewrite it is refused', () => {
    const store = makeStore();
    store.save(data({ arch: { store: 'v' } }, { aliases: { st: 'arch.store' } }));
    gitWrite(aliasesPath(), conflictedSidecar('"hand": "arch.store",', '"ho": "arch.store",'));
    const before = fs.readFileSync(aliasesPath(), 'utf8');

    const loaded = store.load();
    expect(loaded.aliases).toEqual({});
    expect(store.unreadable()).toEqual([{ kind: 'aliases', path: aliasesPath(), reason: 'conflict' }]);

    // What `alias set` does: load, add one, save. It would write a one-alias
    // file over both sides of the conflict.
    const err = expectUnreadable(() => store.save({ ...loaded, aliases: { zz: 'arch.store' } }), 'write');
    expect(err.message).toContain('alias map');
    expect(fs.readFileSync(aliasesPath(), 'utf8')).toBe(before);
    expect(epoch() % 2).toBe(0);
  });

  it('aliases: a save that does not change them goes through and leaves the file alone', () => {
    const store = makeStore();
    store.save(data({ arch: { store: 'v' } }, { aliases: { st: 'arch.store' } }));
    gitWrite(aliasesPath(), conflictedSidecar('"hand": "arch.store",', '"ho": "arch.store",'));
    const before = fs.readFileSync(aliasesPath(), 'utf8');

    const loaded = store.load();
    store.save({ ...loaded, entries: { arch: { store: 'changed' } } });
    expect(makeStore().getOne('arch.store')).toBe('changed');
    expect(fs.readFileSync(aliasesPath(), 'utf8')).toBe(before);
  });

  it('confirm: loads as empty but is reported, and a rewrite is refused', () => {
    const store = makeStore();
    store.save(data({ commands: { deploy: 'echo deploy' } }, { confirm: { 'commands.deploy': true } }));
    gitWrite(confirmPath(), conflictedSidecar('"commands.deploy": true,', '"commands.wipe": true,'));
    const before = fs.readFileSync(confirmPath(), 'utf8');

    const loaded = store.load();
    expect(loaded.confirm).toEqual({});
    expect(store.unreadable()).toEqual([{ kind: 'confirm', path: confirmPath(), reason: 'conflict' }]);
    const err = expectUnreadable(() => store.save({ ...loaded, confirm: { 'commands.other': true } }), 'write');
    expect(err.message).toContain('confirmation list');
    expect(fs.readFileSync(confirmPath(), 'utf8')).toBe(before);
  });

  it('a sidecar that parses to something other than an object is unreadable too', () => {
    const store = makeStore();
    store.save(data({ a: { b: 'v' } }));
    gitWrite(aliasesPath(), '["not", "a", "map"]');
    gitWrite(confirmPath(), 'null');
    store.load();
    expect(store.unreadable().map(f => [f.kind, f.reason])).toEqual([['aliases', 'parse'], ['confirm', 'parse']]);
  });

  it('an empty or missing sidecar is simply empty', () => {
    const store = makeStore();
    store.save(data({ a: { b: 'v' } }));
    gitWrite(aliasesPath(), '');
    fs.rmSync(confirmPath());
    const when = Date.now() / 1000 + 2000;
    fs.utimesSync(dir, when, when);
    expect(store.load().aliases).toEqual({});
    expect(store.unreadable()).toEqual([]);
  });

  it('reports entries and sidecars together, ordered by path', () => {
    const store = storeWithConflict();
    gitWrite(aliasesPath(), conflictedSidecar('"a": "arch.store",', '"b": "arch.store",'));
    store.load();
    expect(store.unreadable().map(f => path.basename(f.path))).toEqual(['_aliases.json', 'context.next_session.json']);
  });
});

// A scan is skipped while the directory's own mtime is unchanged. git writes
// a file by removing and creating it, which moves the directory; an editor
// save or `cp backup <file>` rewrites the file in place and does not. A
// long-lived process (the MCP server) must still notice the repair — it used
// to keep reporting the file, leave the entry out, and delete the repaired
// file on its next full save.
describe('a file repaired in place, with the directory mtime unchanged', () => {
  const aliasesPath = () => path.join(dir, '_aliases.json');
  const confirmPath = () => path.join(dir, '_confirm.json');
  const repaired = (value: string) => serializeEntryWrapper({ value, meta: { created: 1000, updated: 4000 } });

  // Whole seconds, so pinning twice yields the identical mtime.
  const PINNED = Math.floor(Date.now() / 1000) + 50_000;
  /** Put the directory mtime where the store's last scan saw it. */
  const pinDir = (): void => { fs.utimesSync(dir, PINNED, PINNED); };
  const dirIsPinned = (): boolean => fs.statSync(dir).mtimeMs === PINNED * 1000;

  /** Rewrite `file` in place (no remove, no rename), give it a new mtime, and leave the directory as it was. */
  function inPlace(file: string, content: string): void {
    fs.writeFileSync(file, content);
    const when = Math.floor(Date.now() / 1000) + 60_000 + 10 * ++tick;
    fs.utimesSync(file, when, when);
    pinDir();
  }

  /** A store that has scanned a conflicted `context.next_session`, with the directory pinned. */
  function scannedConflict() {
    const store = storeWithConflict();
    pinDir();
    expect(store.load().entries).toEqual({ arch: { store: 'healthy' }, context: { other: 'kept' } });
    expect(store.unreadable()).toHaveLength(1);
    return store;
  }

  it('an entry is read again and no longer reported', () => {
    const store = scannedConflict();
    inPlace(entryPath('context.next_session'), repaired('our handoff'));
    expect(dirIsPinned()).toBe(true); // the scan's fast skip would apply

    expect(store.load().entries).toEqual({ arch: { store: 'healthy' }, context: { next_session: 'our handoff', other: 'kept' } });
    expect(store.unreadable()).toEqual([]);
  });

  it('a full save after the repair keeps the repaired entry', () => {
    const store = scannedConflict();
    inPlace(entryPath('context.next_session'), repaired('our handoff'));

    // What `alias set` does: load, change the alias map, save.
    const loaded = store.load();
    store.save({ ...loaded, aliases: { st: 'arch.store' } });

    expect(fs.existsSync(entryPath('context.next_session'))).toBe(true);
    expect(makeStore().getOne('context.next_session')).toBe('our handoff');
  });

  it('a repaired alias map is read again, and the next alias write keeps what it holds', () => {
    const store = makeStore();
    store.save(data({ arch: { store: 'v' }, commands: { hello: 'echo hello' } }, { aliases: { st: 'arch.store' } }));
    gitWrite(aliasesPath(), conflictedSidecar('"hand": "arch.store",', '"ho": "arch.store",'));
    pinDir();
    expect(store.load().aliases).toEqual({});
    expect(store.unreadable().map(f => f.kind)).toEqual(['aliases']);

    inPlace(aliasesPath(), JSON.stringify({ hand: 'arch.store' }, null, 2));
    expect(dirIsPinned()).toBe(true);
    const loaded = store.load();
    expect(loaded.aliases).toEqual({ hand: 'arch.store' });
    expect(store.unreadable()).toEqual([]);

    store.save({ ...loaded, aliases: { ...loaded.aliases, hl: 'commands.hello' } });
    expect(JSON.parse(fs.readFileSync(aliasesPath(), 'utf8'))).toEqual({ hand: 'arch.store', hl: 'commands.hello' });
  });

  it('a repaired confirmation list is read again', () => {
    const store = makeStore();
    store.save(data({ commands: { deploy: 'echo deploy' } }, { confirm: { 'commands.deploy': true } }));
    gitWrite(confirmPath(), conflictedSidecar('"commands.deploy": true,', '"commands.wipe": true,'));
    pinDir();
    expect(store.load().confirm).toEqual({});
    expect(store.unreadable().map(f => f.kind)).toEqual(['confirm']);

    inPlace(confirmPath(), JSON.stringify({ 'commands.deploy': true }, null, 2));
    expect(dirIsPinned()).toBe(true);
    expect(store.load().confirm).toEqual({ 'commands.deploy': true });
    expect(store.unreadable()).toEqual([]);
  });

  it('a broken file that is gone is no longer reported', () => {
    const store = scannedConflict();
    fs.rmSync(entryPath('context.next_session'));
    pinDir();
    store.load();
    expect(store.unreadable()).toEqual([]);
  });

  it('a file that is still broken is still reported, and still left alone', () => {
    const store = scannedConflict();
    const before = fs.readFileSync(entryPath('context.next_session'), 'utf8');
    pinDir();
    expect(store.load().entries).toEqual({ arch: { store: 'healthy' }, context: { other: 'kept' } });
    expect(store.unreadable()).toHaveLength(1);
    expect(fs.readFileSync(entryPath('context.next_session'), 'utf8')).toBe(before);
  });

  it('a key written after its repair stops being reported at once', () => {
    const store = scannedConflict();
    inPlace(entryPath('context.next_session'), repaired('our handoff'));

    // setOne reads its target fresh and never scans: the write goes through.
    expect(store.setOne('context.next_session', 'next handoff', Date.now())).toBe(true);
    expect(store.unreadable()).toEqual([]);
    pinDir();
    expect(store.load().entries).toMatchObject({ context: { next_session: 'next handoff' } });
    expect(store.unreadable()).toEqual([]);
  });
});

describe('classifyUnparseable', () => {
  it('names a conflict only when both an opening and a closing marker start a line', () => {
    expect(classifyUnparseable(conflictedEntry('a', 'b'))).toBe('conflict');
    expect(classifyUnparseable('{\r\n<<<<<<< HEAD\r\n"value": 1\r\n=======\r\n"value": 2\r\n>>>>>>> x\r\n}')).toBe('conflict');
    expect(classifyUnparseable('{ "value": "<<<<<<< HEAD and >>>>>>> x" ')).toBe('parse');
    expect(classifyUnparseable('<<<<<<< HEAD\nonly an opening marker')).toBe('parse');
    expect(classifyUnparseable('<<<<<<<<< nine of them\n>>>>>>>>> nine')).toBe('parse');
    expect(classifyUnparseable('')).toBe('parse');
  });
});

describe('messages', () => {
  const entry: UnreadableFile = { kind: 'entry', path: '/repo/.reverie/context.next_session.json', key: 'context.next_session', reason: 'conflict' };
  const aliases: UnreadableFile = { kind: 'aliases', path: '/repo/.reverie/_aliases.json', reason: 'conflict' };
  const confirm: UnreadableFile = { kind: 'confirm', path: '/repo/.reverie/_confirm.json', reason: 'parse' };

  describe('displayPath', () => {
    const inCwd = path.join(process.cwd(), '.reverie', 'k.json');
    afterEach(() => { setAbsoluteDisplayPaths(false); });

    it('is relative under the working directory, absolute outside it', () => {
      expect(displayPath(inCwd)).toBe(path.join('.reverie', 'k.json'));
      expect(displayPath('/somewhere/else/.reverie/k.json')).toBe('/somewhere/else/.reverie/k.json');
    });

    it('is never relative to a filesystem root, which would only strip the leading slash', () => {
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(path.parse(process.cwd()).root);
      try {
        expect(displayPath(inCwd)).toBe(inCwd);
        expect(resolutionHint({ kind: 'entry', path: inCwd, key: 'k', reason: 'conflict' })).toContain(`git checkout --ours -- ${inCwd}`);
      } finally {
        cwd.mockRestore();
      }
    });

    it('is absolute everywhere once a surface asks for that (the MCP server)', () => {
      setAbsoluteDisplayPaths(true);
      expect(displayPath(inCwd)).toBe(inCwd);
      expect(describeUnreadable({ kind: 'aliases', path: inCwd, reason: 'parse' })).toBe(`${inCwd} is not a valid store file`);
    });
  });

  it('a read error says the entry exists, and never says "not found" on its own', () => {
    const msg = new StoreUnreadableError([entry], 'read').message;
    expect(msg).toContain("Cannot read entry 'context.next_session'");
    expect(msg).toContain('unresolved git conflict markers');
    expect(msg).toContain('It exists; this is not "not found"');
  });

  it('a write refusal says what would be lost and that nothing was written', () => {
    expect(new StoreUnreadableError([entry], 'write').message).toContain('would discard both sides of it. Nothing was written.');
    expect(new StoreUnreadableError([aliases], 'write').message).toContain('would discard every alias in it');
    expect(new StoreUnreadableError([confirm], 'write').message).toContain('would discard every confirmation flag in it');
    expect(new StoreUnreadableError([entry, aliases, confirm], 'write').message).toContain('(and 2 more unreadable files)');
  });

  it('the conflict fix is whole-file, valid as written, and leaves the choice of side to the user', () => {
    const hint = resolutionHint(entry);
    expect(hint).toContain("Which side to keep is the user's call");
    expect(hint).toContain('`git checkout --ours -- /repo/.reverie/context.next_session.json` (or `--theirs`)');
    // No form that fails when pasted as one command, and no invitation to hand-edit.
    expect(hint).not.toContain('--ours|--theirs');
    expect(hint).not.toMatch(/edit|merge by hand/i);
    expect(resolutionHint(confirm)).toBe('Restore /repo/.reverie/_confirm.json from version control or a backup, or remove it.');
  });

  it('a warning says what the store is doing without the file', () => {
    expect(unreadableWarning(entry)).toContain("entry 'context.next_session' is not being read");
    expect(unreadableWarning(aliases)).toContain('no aliases are being read');
    expect(unreadableWarning(confirm)).toContain('every entry is treated as requiring confirmation to run');
    expect(describeUnreadable(confirm)).toBe('/repo/.reverie/_confirm.json is not a valid store file');
  });

  it('the terminal block is one line for one file, and states the fix once for several', () => {
    expect(unreadableWarningBlock([])).toEqual([]);
    expect(unreadableWarningBlock([entry])).toEqual([`warning: ${unreadableWarning(entry)}`]);
    const block = unreadableWarningBlock([entry, aliases]);
    expect(block[0]).toBe('warning: 2 store files cannot be read:');
    expect(block).toHaveLength(4);
    expect(block.filter(l => l.includes('git checkout'))).toHaveLength(1);
  });

  it('the bootstrap block leads with the count and the instruction not to write over them', () => {
    expect(bootstrapUnreadableLines([])).toEqual([]);
    const one = bootstrapUnreadableLines([entry]);
    expect(one[0]).toBe('!! 1 store file cannot be read. It is NOT shown below and NOT missing — do not write over it:');
    expect(one[1]).toContain('context.next_session — /repo/.reverie/context.next_session.json has unresolved git conflict markers');
    const many = bootstrapUnreadableLines(Array.from({ length: 11 }, (_, i) => ({ ...entry, key: `k.${i}`, path: `/repo/.reverie/k.${i}.json` })));
    expect(many[0]).toContain('11 store files cannot be read. They are');
    expect(many).toContain('   … and 3 more');
    expect(many).toHaveLength(1 + 8 + 1 + 1);
  });
});

describe('bookkeeping', () => {
  const a: UnreadableFile = { kind: 'entry', path: '/s/a.json', key: 'a', reason: 'conflict' };
  const b: UnreadableFile = { kind: 'entry', path: '/s/b.json', key: 'b', reason: 'parse' };

  it('withoutShown drops what was already named, then forgets', () => {
    markUnreadableShown([a]);
    expect(withoutShown([a, b])).toEqual([b]);
    expect(withoutShown([a, b])).toEqual([a, b]);
    markUnreadableShown();
    expect(withoutShown([a, b])).toEqual([]);
    expect(withoutShown([a, b])).toEqual([a, b]);
  });

  it('assertSidecarsWritable scans first, then refuses only for the sidecars asked about', () => {
    const aliases: UnreadableFile = { kind: 'aliases', path: '/s/_aliases.json', reason: 'conflict' };
    let scanned = 0;
    let found: UnreadableFile[] = [];
    registerUnreadableSource('test-store', () => found, () => { scanned++; found = [a, aliases]; });
    try {
      // The unreadable ENTRY is not this check's business, and neither is a sidecar it was not asked about.
      expect(() => assertSidecarsWritable(() => 'test-store', ['confirm'])).not.toThrow();
      expect(scanned).toBe(1);
      let thrown: unknown;
      try { assertSidecarsWritable(() => 'test-store', ['aliases', 'confirm']); } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(StoreUnreadableError);
      expect((thrown as StoreUnreadableError).attempted).toBe('write');
      expect((thrown as StoreUnreadableError).files).toEqual([aliases]);
      // A store nobody registered (a mocked one) has nothing to refuse.
      expect(() => assertSidecarsWritable(() => 'test-unregistered', ['aliases', 'confirm'])).not.toThrow();
      // No resolvable target: the write refuses on its own; this check does not pre-empt it.
      expect(() => assertSidecarsWritable(() => { throw new Error('unresolved'); }, ['aliases', 'confirm'])).not.toThrow();
      expect(scanned).toBe(2);
    } finally {
      registerUnreadableSource('test-store', () => []);
    }
  });

  it('confirmListUnreadable is true only for a confirmation list', () => {
    registerUnreadableSource('test-store', () => [a, { kind: 'aliases', path: '/s/_aliases.json', reason: 'conflict' }]);
    try {
      expect(confirmListUnreadable()).toBe(false);
      registerUnreadableSource('test-store', () => [{ kind: 'confirm', path: '/s/_confirm.json', reason: 'parse' }]);
      expect(confirmListUnreadable()).toBe(true);
    } finally {
      registerUnreadableSource('test-store', () => []);
    }
  });

  describe('readForWrite: the pre-read of a key about to be written', () => {
    const globalFile: UnreadableFile = { kind: 'entry', path: '/home/.reverie/store/k.json', key: 'k', reason: 'parse' };
    const projectFile: UnreadableFile = { kind: 'entry', path: '/repo/.reverie/k.json', key: 'k', reason: 'conflict' };
    type S = 'project' | 'global' | 'auto';

    it('returns what the lookup returns when nothing is wrong, without asking for the write scope', () => {
      const writeScope = vi.fn((): S => 'project');
      expect(readForWrite<string | undefined, S>(() => 'global value', 'auto', writeScope)).toBe('global value');
      expect(writeScope).not.toHaveBeenCalled();
    });

    it('an unreadable file in the OTHER store does not block the write', () => {
      // auto scope: the lookup fell through to the global store and hit a
      // broken file there; the write goes to the project, where the key is absent.
      const read = (scope: S | undefined): string | undefined => {
        if (scope === 'project') return undefined;
        throw new StoreUnreadableError([globalFile], 'read');
      };
      expect(readForWrite<string | undefined, S>(read, 'auto', () => 'project')).toBeUndefined();
    });

    it('an unreadable file in the store being written is a refused write', () => {
      const read = (): string | undefined => { throw new StoreUnreadableError([projectFile], 'read'); };
      const err = expectUnreadable(() => readForWrite<string | undefined, S>(read, 'auto', () => 'project'), 'write');
      expect(err.files).toEqual([projectFile]);
    });

    it('when the write has no resolvable target, that error is the one reported', () => {
      const read = (): string | undefined => { throw new StoreUnreadableError([globalFile], 'read'); };
      expect(() => readForWrite<string | undefined, S>(read, 'auto', () => { throw new Error('PROJECT_UNRESOLVED'); })).toThrow('PROJECT_UNRESOLVED');
    });

    it('other errors pass through untouched', () => {
      expect(() => readForWrite<string, S>(() => { throw new Error('disk on fire'); }, 'auto', () => 'project')).toThrow('disk on fire');
    });
  });

  it('the refused-write note is read once', () => {
    expect(takeWriteRefused()).toBe(false);
    noteWriteRefused();
    expect(takeWriteRefused()).toBe(true);
    expect(takeWriteRefused()).toBe(false);
  });

  it('listUnreadableFiles collects every source once, tolerating one that throws', () => {
    registerUnreadableSource('test-one', () => [a, b]);
    registerUnreadableSource('test-two', () => [b]);
    registerUnreadableSource('test-broken', () => { throw new Error('no'); });
    try {
      expect(listUnreadableFiles()).toEqual([a, b]);
    } finally {
      registerUnreadableSource('test-one', () => []);
      registerUnreadableSource('test-two', () => []);
      registerUnreadableSource('test-broken', () => []);
    }
  });
});
