/**
 * #267: a key stored both as an entry and as a namespace — `ns.k.json`
 * beside `ns.k.sub.json`, after a hand edit or a git merge.
 *
 * The tree a write starts from holds one of the two, and the write deleted
 * every file absent from the tree it got back: `rename` of an unrelated key,
 * `confirm set`, `alias set` and `remove` all deleted the hidden half without
 * a word. Which half was hidden depended on the order the directory listed
 * them. `lint` said nothing, and `rm -G` of the hidden half told the user to
 * pass --global.
 *
 * Now the entry is always the half that shows, a write deletes a hidden file
 * only when it removes that key or the entry it is hidden under, `rm` finds
 * what `get` finds, and `lint` reports the pair.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDirectoryStore } from '../utils/directoryStore';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

let tmpRoot: string;
beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-pair-')); });
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

function makeStore(dir: string) {
  return createDirectoryStore(() => dir, () => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); });
}
const writeEntry = (dir: string, key: string, value: string) =>
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ value }));
const files = (dir: string) => fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();

describe('the store keeps both halves of a pair (#267)', () => {
  // Either half can be the one the cache lists first: the one already loaded
  // when the other appears on disk. Both orders, every time.
  for (const first of ['ns.k', 'ns.k.sub'] as const) {
    describe(`with '${first}' loaded first`, () => {
      let dir: string;
      let store: ReturnType<typeof makeStore>;
      beforeEach(() => {
        dir = path.join(tmpRoot, 'store');
        store = makeStore(dir);
        store.save({ entries: { ns: { other: 'o' } }, aliases: {}, confirm: {} });
        const second = first === 'ns.k' ? 'ns.k.sub' : 'ns.k';
        writeEntry(dir, first, first === 'ns.k' ? 'leaf' : 'sub');
        store.load();
        writeEntry(dir, second, second === 'ns.k' ? 'leaf' : 'sub');
      });

      it('shows the entry and lists the rest as hidden', () => {
        const data = store.load();
        expect(data.entries).toEqual({ ns: { k: 'leaf', other: 'o' } });
        expect(data.hidden).toEqual(['ns.k.sub']);
        expect(store.storedKeys().sort()).toEqual(['ns.k', 'ns.k.sub', 'ns.other']);
      });

      it('a write that changes something else deletes neither', () => {
        store.update(current => ({ ...current, aliases: { al: 'ns.other' }, confirm: { 'ns.other': true } }));
        store.update(current => ({ ...current, entries: { ns: { k: 'leaf', moved: 'o' } } }));   // a rename of ns.other
        expect(files(dir)).toEqual(['ns.k.json', 'ns.k.sub.json', 'ns.moved.json']);
      });

      it('a write that removes the entry removes what is hidden under it', () => {
        store.update(current => ({ ...current, entries: { ns: { other: 'o' } } }));
        expect(files(dir)).toEqual(['ns.other.json']);
      });

      it('a write that names a hidden key in `removed` deletes that file alone', () => {
        store.update(current => ({ ...current, removed: ['ns.k.sub'] }));
        expect(files(dir)).toEqual(['ns.k.json', 'ns.other.json']);
      });
    });
  }
});

describe('a pair on the command line (#267)', () => {
  let dataDir: string;
  const env = () => ({ ...process.env, RVR_DATA_DIR: dataDir, RVR_NO_PROJECT: '1' });
  const rvr = (...args: string[]) => {
    const r = spawnSync('bun', ['dist/index.js', ...args], { env: env(), input: '', timeout: 15000 });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const store = () => path.join(dataDir, 'store');
  const bothThere = () => ['ns.k.json', 'ns.k.sub.json'].every(f => fs.existsSync(path.join(store(), f)));

  beforeAll(() => assertDistHonorsDataDir());
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-pair-cli-'));
    expect(rvr('set', '-G', 'ns.other', 'o').status).toBe(0);
    writeEntry(store(), 'ns.k', 'leaf');
    writeEntry(store(), 'ns.k.sub', 'sub');
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('rename elsewhere, confirm set, alias set and rm elsewhere keep both files', () => {
    expect(rvr('rename', '-G', 'ns.other', 'ns.moved').status).toBe(0);
    expect(bothThere()).toBe(true);
    expect(rvr('confirm', 'set', '-G', 'ns.moved').status).toBe(0);
    expect(bothThere()).toBe(true);
    expect(rvr('alias', 'set', '-G', 'al', 'ns.moved').status).toBe(0);
    expect(bothThere()).toBe(true);
    expect(rvr('rm', '-G', 'ns.moved', '-f').status).toBe(0);
    expect(bothThere()).toBe(true);
  }, 60000);

  it('lint names both keys and fails; --json carries a warning', () => {
    const text = rvr('lint', '-G');
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("'ns.k' and 'ns.k.sub'");
    expect(text.stdout).toContain('stored both as an entry and as a namespace');

    const json = rvr('--json', 'lint', '-G');
    expect(json.status).toBe(1);
    const envelope = JSON.parse(json.stdout) as {
      ok: boolean;
      error: { code: string };
      warnings: { code: string; message: string }[];
      result: { entryNamespacePairs: { entry: string; under: string[] }[] };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.result.entryNamespacePairs).toEqual([{ entry: 'ns.k', under: ['ns.k.sub'] }]);
    const warning = envelope.warnings.find(w => w.code === 'ENTRY_NAMESPACE_PAIR');
    expect(warning?.message).toContain("'ns.k'");
    expect(warning?.message).toContain("'ns.k.sub'");
  }, 30000);

  it('rm -G of the hidden half: get finds it, rm removes it and nothing else', () => {
    expect(rvr('get', '-G', 'ns.k.sub', '-s').stdout).toContain('sub');
    const r = rvr('rm', '-G', 'ns.k.sub', '-f');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('pass --global');
    expect(fs.existsSync(path.join(store(), 'ns.k.sub.json'))).toBe(false);
    expect(fs.existsSync(path.join(store(), 'ns.k.json'))).toBe(true);
    expect(rvr('get', '-G', 'ns.k.sub', '-s').status).toBe(1);
  }, 30000);

  it("rename's refusal names a route that works: copy the hidden half to a free key, then rm the entry", () => {
    const refused = rvr('rename', '-G', 'ns.k', 'ns.kk');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('rvr copy');
    expect(rvr('copy', '-G', 'ns.k.sub', 'keep.sub').status).toBe(0);
    expect(rvr('rm', '-G', 'ns.k', '-f').status).toBe(0);
    expect(files(store())).toEqual(['keep.sub.json', 'ns.other.json']);
    expect(rvr('get', '-G', 'keep.sub', '-s').stdout.trim()).toBe('keep.sub: sub');
    expect(rvr('lint', '-G').stdout).not.toContain('stored both as an entry and as a namespace');
  }, 60000);

  it('reverie_remove over MCP removes the hidden half', () => {
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reverie_remove', arguments: { key: 'ns.k.sub', scope: 'global' } } },
    ].map(m => JSON.stringify(m)).join('\n') + '\n';
    const r = spawnSync('bun', ['dist/index.js', 'mcp-server'], { env: env(), input: lines, timeout: 15000 });
    const reply = r.stdout.toString().trim().split('\n').map(l => { try { return JSON.parse(l) as { id?: number; result?: { isError?: boolean; content: { text: string }[] } }; } catch { return {}; } })
      .find(m => m.id === 2);
    expect(reply?.result?.isError).toBeFalsy();
    expect(reply?.result?.content[0].text).toBe('Removed: ns.k.sub');
    expect(files(store())).toEqual(['ns.k.json', 'ns.other.json']);
  }, 30000);
});
