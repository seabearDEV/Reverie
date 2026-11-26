/**
 * #254 test harness: a second writer, process B, that commits a write at
 * every point process A goes for the store lock.
 *
 * B is its own store instance over the same directory, so it has caches of
 * its own, as another process would. A is this process: the store.ts
 * singletons and everything above them. The interleaving is driven from the
 * lock acquisition itself — no timing.
 *
 * Call useTempGlobalStore() at the top of a suite: each test gets a fresh
 * global store under a temp data dir, with no project resolving from the cwd.
 */
import { afterEach, beforeEach, vi } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDirectoryStore } from '../../utils/directoryStore';
import { clearDataDirectoryCache } from '../../utils/paths';
import { flattenObject } from '../../utils/objectPath';
import { clearStoreCaches, loadAliasMap, loadConfirmMap, loadEntries } from '../../store';
import type { ScopedStore, UnifiedData } from '../../store';

const state = { root: '', storeDir: '' };

export function useTempGlobalStore(): { readonly root: string; readonly storeDir: string } {
  const saved = { data: process.env.RVR_DATA_DIR, noProject: process.env.RVR_NO_PROJECT };
  const originalLog = console.log;
  const originalError = console.error;
  beforeEach(() => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-254-'));
    state.storeDir = path.join(state.root, 'store');
    process.env.RVR_DATA_DIR = state.root;
    process.env.RVR_NO_PROJECT = '1';
    clearDataDirectoryCache();
    clearStoreCaches();
    console.log = vi.fn();
    console.error = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    console.log = originalLog;
    console.error = originalError;
    if (saved.data === undefined) delete process.env.RVR_DATA_DIR; else process.env.RVR_DATA_DIR = saved.data;
    if (saved.noProject === undefined) delete process.env.RVR_NO_PROJECT; else process.env.RVR_NO_PROJECT = saved.noProject;
    clearDataDirectoryCache();
    clearStoreCaches();
    fs.rmSync(state.root, { recursive: true, force: true });
  });
  return state;
}

/** Another process: a store instance of its own over the same directory. */
export function otherProcess(): ScopedStore {
  const dir = state.storeDir;
  return createDirectoryStore(() => dir, () => { fs.mkdirSync(dir, { recursive: true }); });
}

/** The store as a fresh reader sees it. */
export function onDisk(): UnifiedData {
  return otherProcess().load();
}

export function seed(data: Partial<UnifiedData>): void {
  otherProcess().save({ entries: {}, aliases: {}, confirm: {}, ...data });
  clearStoreCaches();
}

export const entryKeys = (d: UnifiedData): string[] => Object.keys(flattenObject(d.entries)).sort();

/** One write by B, under a name of its own (`n` counts B's writes). Returns the name. */
export type BWrite = (b: ScopedStore, n: number) => string;

export const bEntry: BWrite = (b, n) => {
  const key = `b.entry${n}`;
  if (!b.setOne(key, `v${n}`, Date.now())) throw new Error(`setOne(${key}) declined`);
  return key;
};
export const bFlag: BWrite = (b, n) => {
  const key = `b.flag${n}`;
  const d = b.load();
  d.confirm[key] = true;
  b.save(d);
  return key;
};
export const bAlias: BWrite = (b, n) => {
  const name = `balias${n}`;
  const d = b.load();
  d.aliases[name] = `b.target${n}`;
  b.save(d);
  return name;
};
/** B's writes in turn: an entry, a flag, an alias, ... */
export const bMixed: BWrite = (b, n) => [bEntry, bFlag, bAlias][n % 3](b, n);

/** Did B's write named `name` survive, whichever kind it was? */
export function survived(d: UnifiedData, name: string): boolean {
  return entryKeys(d).includes(name) || d.confirm[name] === true || d.aliases[name] !== undefined;
}

/**
 * Run A's command with B writing in every gap: once after A last read the
 * store (A's caches are then stale), and once just before each of A's lock
 * acquisitions. Returns the names B wrote.
 */
export async function interleave(op: () => unknown, bWrite: BWrite): Promise<string[]> {
  const b = otherProcess();
  const written: string[] = [];

  // A has read the store — as the caller of any command has — and B writes.
  loadEntries('global');
  loadAliasMap('global');
  loadConfirmMap('global');
  written.push(bWrite(b, written.length));

  const lockPath = state.storeDir + '.lock';
  const realOpen = fs.openSync.bind(fs);
  let inB = false;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (!inB && String(p) === lockPath) {
      inB = true;
      try { written.push(bWrite(b, written.length)); } finally { inB = false; }
    }
    return (realOpen as (...args: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
  try {
    await op();
  } finally {
    vi.restoreAllMocks();
  }
  return written;
}
