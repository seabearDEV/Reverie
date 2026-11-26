/**
 * A store write that fails partway (#262), and how the failure reads (#271).
 *
 * #262: a commit bumps the epoch odd, writes, and bumps it even. Readers that
 * see it odd retry, then fall back to a snapshot they cannot trust. The even
 * value was written back at each `throw` the commit had, and a failure after
 * the entry writes — the delete loop, the final list write, a key the store
 * cannot name — left it odd until the next write.
 *
 * #271: such a failure printed a raw Node message with the temp file's name
 * (`Failed to set entry:: EISDIR: … rename '<tmp>' -> '<file>'`) or a Bun
 * source excerpt. It is one line now, naming the file and why: exit 1, code
 * IO, in text, --json, the telemetry and audit rows, and over MCP.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDirectoryStore } from '../utils/directoryStore';
import { StoreWriteError } from '../utils/storeWriteError';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

let tmpRoot: string;
beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-writefail-')); });
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

function makeStore(dir: string) {
  return createDirectoryStore(() => dir, () => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); });
}
const epochOf = (dir: string): number => (JSON.parse(fs.readFileSync(path.join(dir, '_epoch.json'), 'utf8')) as { epoch: number }).epoch;

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('a commit that fails partway leaves the epoch even (#262)', () => {
  it('the final list write, after the deletes, fails', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1', k: 'v' }, aliases: {}, confirm: { k: true } });
    const before = epochOf(dir);

    // The commit removes `a` and the flag of `k`. The list loses a flag, so
    // it is written last, after the delete — and a directory is in its place.
    // It appears during the delete: one there before the commit's writes is
    // refused up front as unreadable (#283), and nothing is deleted.
    const unlink = fs.unlinkSync.bind(fs);
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      unlink(p);
      if (String(p) === path.join(dir, 'a.json')) {
        fs.rmSync(path.join(dir, '_confirm.json'));
        fs.mkdirSync(path.join(dir, '_confirm.json'));
      }
    }) as typeof fs.unlinkSync);
    let err: unknown;
    try {
      err = caught(() => store.update(current => ({ ...current, entries: { k: 'v' }, confirm: {} })));
    } finally {
      spy.mockRestore();
    }

    expect(epochOf(dir) % 2).toBe(0);
    expect(epochOf(dir)).toBeGreaterThan(before);
    // #271: the file it could not write, and why; not "nothing was written":
    // `a` is gone by then.
    expect(err).toBeInstanceOf(StoreWriteError);
    expect((err as StoreWriteError).code).toBe('EISDIR');
    expect((err as StoreWriteError).path).toBe(path.join(dir, '_confirm.json'));
    expect((err as Error).message).toMatch(/^Cannot write .*_confirm\.json: a directory is in its place \(EISDIR\)\.$/);
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(false);
  });

  it('a delete that fails: the commit fails naming the file, and the list keeps the flag it would have lost', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1', k: 'v' }, aliases: {}, confirm: { a: true } });

    // `a` is removed with its flag; its file cannot be deleted. Swallowed,
    // the command reported `a` removed, and the list then dropped its flag.
    const err = caught(() => store.update(current => {
      fs.rmSync(path.join(dir, 'a.json'));
      fs.mkdirSync(path.join(dir, 'a.json'));
      fs.writeFileSync(path.join(dir, 'a.json', 'x'), '');
      return { ...current, entries: { k: 'v' }, confirm: {} };
    }));

    expect(err).toBeInstanceOf(StoreWriteError);
    expect((err as Error).message).toMatch(/^Cannot remove .*a\.json: /);
    // Nothing else was to change, and the list was left as it was: the
    // store is as it was, and the message says so.
    expect((err as Error).message).toMatch(/\. Nothing was written\.$/);
    expect(epochOf(dir) % 2).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '_confirm.json'), 'utf8'))).toEqual({ a: true });
    expect(store.load().confirm).toEqual({ a: true });
  });

  it('a delete that fails after a write went through: no "Nothing was written"', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1', k: 'v' }, aliases: {}, confirm: {} });

    const err = caught(() => store.update(current => {
      fs.rmSync(path.join(dir, 'a.json'));
      fs.mkdirSync(path.join(dir, 'a.json'));
      fs.writeFileSync(path.join(dir, 'a.json', 'x'), '');
      return { ...current, entries: { k: 'v2' } };
    }));

    expect((err as Error).message).toMatch(/^Cannot remove .*a\.json: /);
    expect((err as Error).message).not.toContain('Nothing was written');
    expect(store.load().entries.k).toBe('v2');
  });

  it('a key the store cannot name as a file, found after the change is made', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });

    const err = caught(() => store.update(current => ({ ...current, entries: { ...current.entries, 'b/c': 'x' } })));

    expect((err as Error).message).toContain('Invalid store key');
    expect(epochOf(dir) % 2).toBe(0);
    expect(store.load().entries).toEqual({ a: '1' });
  });

  it('an entry write that fails: taken back, the epoch even, the message names the entry file', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });
    fs.mkdirSync(path.join(dir, 'zz.json'));

    const err = caught(() => store.update(current => ({ ...current, entries: { ...current.entries, b: '2', zz: 'v' } })));

    expect(epochOf(dir) % 2).toBe(0);
    expect(err).toBeInstanceOf(StoreWriteError);
    expect((err as Error).message).toMatch(/^Cannot write .*zz\.json: a directory is in its place \(EISDIR\)\. Nothing was written\.$/);
    expect((err as Error).message).not.toContain('.tmp');
    expect((err as Error).cause).toBeDefined();
    expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(false);
  });

  it('setOne: a failed write, the epoch even, the error named', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });
    fs.mkdirSync(path.join(dir, 'zz.json'));

    const err = caught(() => store.setOne('zz', 'v', Date.now()));

    expect(epochOf(dir) % 2).toBe(0);
    expect(err).toBeInstanceOf(StoreWriteError);
    expect((err as Error).message).toMatch(/zz\.json: a directory is in its place \(EISDIR\)\. Nothing was written\.$/);
  });

  it('what the change itself throws is thrown as it is', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });
    const own = Object.assign(new Error('ENOSPC: from the change'), { code: 'ENOSPC', syscall: 'write' });

    expect(caught(() => store.update(() => { throw own; }))).toBe(own);
    expect(epochOf(dir) % 2).toBe(0);
  });
});

describe('a store write the filesystem refuses, on every surface (#271)', () => {
  let dataDir: string;
  const env = () => ({ ...process.env, RVR_DATA_DIR: dataDir, RVR_NO_PROJECT: '1' });
  const rvr = (...args: string[]) => {
    const r = spawnSync('bun', ['dist/index.js', ...args], { env: env(), input: '', timeout: 15000 });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const store = () => path.join(dataDir, 'store');
  const lastRow = (file: string, tool: string) => fs.readFileSync(path.join(dataDir, file), 'utf8').trim().split('\n')
    .map(l => JSON.parse(l) as { tool?: string; errorCode?: string; success?: boolean })
    .reverse().find(r => r.tool === tool);

  beforeAll(() => assertDistHonorsDataDir());
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-writefail-cli-'));
    expect(rvr('set', '-G', 'k', 'v').status).toBe(0);
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('set onto a directory: one line naming the file, exit 1; IO in --json, telemetry and audit', () => {
    fs.mkdirSync(path.join(store(), 'zz.json'));
    const text = rvr('set', '-G', 'zz', 'v');
    expect(text.status).toBe(1);
    expect(text.stderr.trim().split('\n')).toHaveLength(1);
    expect(text.stderr).toMatch(/Cannot write .*zz\.json: a directory is in its place \(EISDIR\)\. Nothing was written\./);
    expect(text.stderr).not.toContain('Failed to');
    expect(text.stderr).not.toContain('.tmp');
    expect(lastRow('telemetry.jsonl', 'reverie_set')?.errorCode).toBe('IO');
    expect(lastRow('audit.jsonl', 'reverie_set')?.errorCode).toBe('IO');

    const json = rvr('--json', 'set', '-G', 'zz', 'v');
    expect(json.status).toBe(1);
    const envelope = JSON.parse(json.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('IO');
    expect(envelope.error.message).toContain('zz.json: a directory is in its place');
    expect(epochOf(store()) % 2).toBe(0);
  }, 30000);

  it.skipIf(process.platform !== 'darwin')('confirm remove with an immutable list (chflags uchg): one line, no source excerpt, epoch even', () => {
    expect(rvr('confirm', 'set', '-G', 'k').status).toBe(0);
    const list = path.join(store(), '_confirm.json');
    expect(spawnSync('chflags', ['uchg', list]).status).toBe(0);
    try {
      const r = rvr('confirm', 'remove', '-G', 'k');
      expect(r.status).toBe(1);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toMatch(/Cannot write .*_confirm\.json: operation not permitted.*\(EPERM\)/);
      expect(r.stderr).not.toMatch(/^\s*\d+ \| /m);   // a Bun source excerpt
      expect(r.stderr).not.toMatch(/^\s+at /m);
      expect(lastRow('telemetry.jsonl', 'reverie_confirm_remove')?.errorCode).toBe('IO');
      expect(epochOf(store()) % 2).toBe(0);
    } finally {
      spawnSync('chflags', ['nouchg', list]);
    }
  }, 30000);

  it.skipIf(process.platform !== 'darwin')('rm of an entry whose file cannot be deleted (chflags uchg): one line, exit 1, not "removed"', () => {
    const file = path.join(store(), 'k.json');
    expect(spawnSync('chflags', ['uchg', file]).status).toBe(0);
    try {
      const r = rvr('rm', '-G', 'k', '-f');
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain('removed successfully');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toMatch(/Cannot remove .*k\.json: operation not permitted.*\(EPERM\)\. Nothing was written\./);
      expect(lastRow('telemetry.jsonl', 'reverie_remove')?.errorCode).toBe('IO');
    } finally {
      spawnSync('chflags', ['nouchg', file]);
    }
  }, 30000);

  it('reverie_set over MCP: an error result with the same message, IO in telemetry', () => {
    fs.mkdirSync(path.join(store(), 'zz.json'));
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reverie_set', arguments: { key: 'zz', value: 'v', scope: 'global' } } },
    ].map(m => JSON.stringify(m)).join('\n') + '\n';
    const r = spawnSync('bun', ['dist/index.js', 'mcp-server'], { env: env(), input: lines, timeout: 15000 });
    const reply = r.stdout.toString().trim().split('\n').map(l => { try { return JSON.parse(l) as { id?: number; result?: { isError?: boolean; content: { text: string }[] } }; } catch { return {}; } })
      .find(m => m.id === 2);
    expect(reply?.result?.isError).toBe(true);
    expect(reply?.result?.content[0].text).toMatch(/^Cannot write .*zz\.json: a directory is in its place \(EISDIR\)\. Nothing was written\.$/);
    const rows = fs.readFileSync(path.join(dataDir, 'telemetry.jsonl'), 'utf8').trim().split('\n')
      .map(l => JSON.parse(l) as { tool?: string; src?: string; errorCode?: string });
    expect(rows.reverse().find(x => x.tool === 'reverie_set' && x.src === 'mcp')?.errorCode).toBe('IO');
  }, 30000);
});
