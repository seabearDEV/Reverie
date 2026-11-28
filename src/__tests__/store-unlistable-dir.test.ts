/**
 * A store directory that cannot be listed never reads as an empty store
 * (#305 PR 3 review).
 *
 * scanAndSync recorded the directory's mtime as the fast skip's mark before
 * it listed the directory. When the listing failed (the directory lost its
 * read bit), the next scan found the mark matching and skipped over caches
 * that were never filled: the store read as empty, its entries and aliases
 * gone, with nothing reported. A long-lived MCP server that rescans its
 * stores at every call (rescanStores) then lost a global alias to a flagged
 * command, and the gate with it. The mark is now recorded only once a scan
 * completes, so every read fails until the directory can be listed again.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDirectoryStore } from '../utils/directoryStore';

const isRoot = process.getuid?.() === 0;
let dir: string;

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-unlistable-')), 'store');
  fs.mkdirSync(dir);
});

afterEach(() => {
  fs.chmodSync(dir, 0o755);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const open = () => createDirectoryStore(() => dir, () => { fs.mkdirSync(dir, { recursive: true }); });

describe.skipIf(isRoot)('a store directory that cannot be listed', () => {
  it('fails every read after a cleared cache, never answering an empty store', () => {
    const store = open();
    store.save({ entries: { g: { flag: 'echo flag' } }, aliases: { dup: 'g.flag' }, confirm: {} });
    expect(store.load().aliases).toEqual({ dup: 'g.flag' });

    fs.chmodSync(dir, 0o300);   // listable no more; its mtime does not move
    store.clear();
    expect(() => store.load()).toThrow();
    // The second read must not take the fast skip over the empty caches.
    expect(() => store.load()).toThrow();

    fs.chmodSync(dir, 0o755);
    expect(store.load().aliases).toEqual({ dup: 'g.flag' });
  });

  it('a store first opened while it cannot be listed fails its reads too', () => {
    open().save({ entries: { k: 'v' }, aliases: { a: 'k' }, confirm: {} });
    fs.chmodSync(dir, 0o300);
    const store = open();
    expect(() => store.load()).toThrow();
    expect(() => store.load()).toThrow();
  });
});
