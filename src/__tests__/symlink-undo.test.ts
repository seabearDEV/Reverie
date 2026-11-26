/**
 * #283: a commit's undo read through a symlinked entry file.
 *
 * A cloned repository ships `.reverie/x.json` as a symlink to a file of the
 * victim's (`~/.aws/credentials`). The scan skips a symlinked entry file
 * (#159), so a commit writing `x` found no cached copy, and `priorOf` read
 * the path with a plain readFileSync — through the link. When a later write
 * in the same commit failed, the undo wrote those bytes into the store as a
 * regular `x.json` and the command said "Nothing was written". The store is
 * committed, so the next `git commit -a` published the credentials.
 *
 * The repository forces the failure: `_aliases.json` shipped as a directory
 * (read as an empty map, so the alias write failed after the entry write), or
 * a directory where a later entry file goes. Each test points its links at a
 * file in its own temp dir.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDirectoryStore } from '../utils/directoryStore';
import { StoreUnreadableError } from '../utils/unreadable';
import { StoreWriteError } from '../utils/storeWriteError';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

const SECRET = 'AWS_SECRET=supersecret123\n';

let root: string;
let secretFile: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-symlink-undo-'));
  fs.mkdirSync(path.join(root, 'home'));
  secretFile = path.join(root, 'home', 'secret.txt');
  fs.writeFileSync(secretFile, SECRET);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

/** Every regular file under `dir` whose bytes hold the secret. */
function filesHoldingSecret(dir: string): string[] {
  const hits: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) hits.push(...filesHoldingSecret(p));
    else if (st.isFile() && fs.readFileSync(p, 'utf8').includes('supersecret123')) hits.push(p);
  }
  return hits;
}

describe('the undo of a failed commit puts a symlink back as a symlink (#283)', () => {
  const makeStore = (dir: string) => createDirectoryStore(() => dir, () => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); });

  it('a write over a symlinked entry, then a later write that fails', () => {
    const dir = path.join(root, 'store');
    const store = makeStore(dir);
    store.save({ entries: { keep: '1' }, aliases: {}, confirm: {} });
    fs.symlinkSync(secretFile, path.join(dir, 'a.json'));
    fs.mkdirSync(path.join(dir, 'zz.json'));
    fs.writeFileSync(path.join(dir, 'zz.json', 'placeholder'), '');

    const err = caught(() => store.update(current => ({ ...current, entries: { ...current.entries, a: 'v', zz: 'w' } })));

    // The failure happened, at the later write, and was taken back.
    expect(err).toBeInstanceOf(StoreWriteError);
    expect((err as Error).message).toMatch(/zz\.json: a directory is in its place \(EISDIR\)\. Nothing was written\.$/);
    // The link is a link again, to the same place; its target's bytes are nowhere in the store.
    const st = fs.lstatSync(path.join(dir, 'a.json'));
    expect(st.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(dir, 'a.json'))).toBe(secretFile);
    expect(filesHoldingSecret(dir)).toEqual([]);
    expect(fs.readFileSync(secretFile, 'utf8')).toBe(SECRET);
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.link'))).toEqual([]);
  });

  it('a relative link is put back as written', () => {
    const dir = path.join(root, 'store');
    const store = makeStore(dir);
    store.save({ entries: { keep: '1' }, aliases: {}, confirm: {} });
    const relative = path.relative(dir, secretFile);
    fs.symlinkSync(relative, path.join(dir, 'a.json'));
    fs.mkdirSync(path.join(dir, 'zz.json'));

    expect(caught(() => store.update(current => ({ ...current, entries: { ...current.entries, a: 'v', zz: 'w' } })))).toBeInstanceOf(StoreWriteError);

    expect(fs.readlinkSync(path.join(dir, 'a.json'))).toBe(relative);
    expect(filesHoldingSecret(dir)).toEqual([]);
  });
});

describe('a sidecar that is not a regular file is unreadable, not empty (#283)', () => {
  const makeStore = (dir: string) => createDirectoryStore(() => dir, () => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); });

  it('_aliases.json as a directory: a write that changes the alias map is refused before anything is written', () => {
    const dir = path.join(root, 'store');
    const store = makeStore(dir);
    store.save({ entries: { keep: '1' }, aliases: {}, confirm: {} });
    fs.symlinkSync(secretFile, path.join(dir, 'x.json'));
    fs.rmSync(path.join(dir, '_aliases.json'), { force: true });
    fs.mkdirSync(path.join(dir, '_aliases.json'));

    const err = caught(() => store.update(current => ({ ...current, entries: { ...current.entries, x: 'v' }, aliases: { xa: 'x' } })));

    expect(err).toBeInstanceOf(StoreUnreadableError);
    expect((err as StoreUnreadableError).files).toEqual([{ kind: 'aliases', path: path.join(dir, '_aliases.json'), reason: 'read' }]);
    expect((err as Error).message).toContain('is not a regular file the store can read');
    expect((err as Error).message).toContain('Nothing was written.');
    // Refused up front: the entry file was never touched.
    expect(fs.lstatSync(path.join(dir, 'x.json')).isSymbolicLink()).toBe(true);
    expect(store.unreadable().map(f => [path.basename(f.path), f.reason])).toEqual([['_aliases.json', 'read']]);
  });

  it('a symlinked _confirm.json is reported, not read as an empty list', () => {
    const dir = path.join(root, 'store');
    const store = makeStore(dir);
    store.save({ entries: { keep: '1' }, aliases: {}, confirm: {} });
    fs.rmSync(path.join(dir, '_confirm.json'), { force: true });
    fs.symlinkSync(secretFile, path.join(dir, '_confirm.json'));

    store.clear();
    store.load();

    expect(store.unreadable()).toEqual([{ kind: 'confirm', path: path.join(dir, '_confirm.json'), reason: 'read' }]);
  });

  it('a dangling symlinked _aliases.json is reported too', () => {
    const dir = path.join(root, 'store');
    const store = makeStore(dir);
    store.save({ entries: { keep: '1' }, aliases: {}, confirm: {} });
    fs.rmSync(path.join(dir, '_aliases.json'), { force: true });
    fs.symlinkSync(path.join(root, 'nowhere.json'), path.join(dir, '_aliases.json'));

    store.clear();
    store.load();

    expect(store.unreadable().map(f => [f.kind, f.reason])).toEqual([['aliases', 'read']]);
  });
});

describe('the exploit, end to end through the CLI (#283)', () => {
  const cli = path.resolve('dist/index.js');
  let project: string;
  let storeDir: string;

  const rvr = (...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home') };
    delete e.RVR_SESSION;
    delete e.RVR_NO_PROJECT;
    delete e.RVR_PROJECT;
    delete e.RVR_OUTPUT;
    const r = spawnSync('bun', [cli, ...args], { cwd: project, env: e as NodeJS.ProcessEnv, input: '', timeout: 15000 });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };

  beforeAll(() => { assertDistHonorsDataDir(); });
  beforeEach(() => {
    project = path.join(root, 'clone');
    storeDir = path.join(project, '.reverie');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(storeDir, 'keep.json'), JSON.stringify({ value: 'kept' }));
    // What the repository ships: the entry an agent is told to write, as a
    // link to a file of the victim's.
    fs.symlinkSync(secretFile, path.join(storeDir, 'x.json'));
  });

  it('`set x v -a xa` with _aliases.json shipped as a directory: refused up front, STORE_UNREADABLE', () => {
    fs.mkdirSync(path.join(storeDir, '_aliases.json'));
    fs.writeFileSync(path.join(storeDir, '_aliases.json', 'placeholder'), '');

    const r = rvr('--json', 'set', 'x', 'v', '-a', 'xa');

    expect(r.status).toBe(1);
    const envelope = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('STORE_UNREADABLE');
    expect(envelope.error.message).toContain('_aliases.json is not a regular file the store can read');
    expect(fs.lstatSync(path.join(storeDir, 'x.json')).isSymbolicLink()).toBe(true);
    expect(filesHoldingSecret(storeDir)).toEqual([]);
  }, 30000);

  it('`copy` onto a symlinked entry, then a directory in a later file\'s place: the link is put back', () => {
    fs.writeFileSync(path.join(storeDir, 'src.x.json'), JSON.stringify({ value: '1' }));
    fs.writeFileSync(path.join(storeDir, 'src.zz.json'), JSON.stringify({ value: '2' }));
    fs.symlinkSync(secretFile, path.join(storeDir, 'dst.x.json'));
    fs.mkdirSync(path.join(storeDir, 'dst.zz.json'));
    fs.writeFileSync(path.join(storeDir, 'dst.zz.json', 'placeholder'), '');

    const r = rvr('copy', 'src', 'dst');

    // The commit failed at its second write, and says the store is as it was.
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Cannot write .*dst\.zz\.json: a directory is in its place \(EISDIR\)\. Nothing was written\./);
    // It is: the link is still a link, and the victim's bytes are not in the store.
    expect(fs.lstatSync(path.join(storeDir, 'dst.x.json')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(storeDir, 'dst.x.json'))).toBe(secretFile);
    expect(filesHoldingSecret(storeDir)).toEqual([]);
  }, 30000);

  it('lint names a sidecar that is not a regular file', () => {
    fs.mkdirSync(path.join(storeDir, '_aliases.json'));

    const r = rvr('lint');

    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('_aliases.json is not a regular file the store can read');
  }, 30000);
});
