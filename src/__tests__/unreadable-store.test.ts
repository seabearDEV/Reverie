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
  bootstrapUnreadableLines,
  classifyUnparseable,
  describeUnreadable,
  listUnreadableFiles,
  markUnreadableShown,
  registerUnreadableSource,
  resolutionHint,
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
