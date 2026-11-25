// #216 and #224: a write that would remove or overwrite an entry it did not
// name is refused. Before the fix `rvr set arch x` deleted every arch.* entry,
// a write under a leaf deleted the leaf, and on a case-insensitive filesystem
// a key differing only by case replaced the other — all reporting success.
//
// The unit tests compare keys in code, so they hold on any filesystem. The
// spawned tests run the built dist/index.js (assumes `bun run build` has run)
// against a project store in a temp directory.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';
import { findKeyCollision, assertKeyWritable, collidesWithAny, findCollidingPairs, KeyCollisionError } from '../utils/keyCollision';
import type { CodexData } from '../types';

describe('findKeyCollision', () => {
  const data = (): CodexData => ({
    arch: { api: 'leaf', auth: 'JWT', deep: { one: '1', two: '2' } },
    project: { name: 'x' },
    solo: 'value',
  } as CodexData);

  it('a new key, and the same key spelled the same way, are not collisions', () => {
    expect(findKeyCollision(data(), 'arch.new')).toBeNull();
    expect(findKeyCollision(data(), 'brand.new.key')).toBeNull();
    expect(findKeyCollision(data(), 'arch.api')).toBeNull();
    expect(findKeyCollision(data(), 'solo')).toBeNull();
  });

  it('a value written to a parent names every entry under it', () => {
    expect(findKeyCollision(data(), 'arch')).toEqual({
      kind: 'parent', key: 'arch', existing: ['arch.api', 'arch.auth', 'arch.deep.one', 'arch.deep.two'],
    });
    expect(findKeyCollision(data(), 'arch.deep')).toEqual({
      kind: 'parent', key: 'arch.deep', existing: ['arch.deep.one', 'arch.deep.two'],
    });
  });

  it('a key under a leaf names the leaf, at any depth', () => {
    expect(findKeyCollision(data(), 'arch.api.v2')).toEqual({ kind: 'child', key: 'arch.api.v2', existing: ['arch.api'] });
    expect(findKeyCollision(data(), 'solo.a.b.c')).toEqual({ kind: 'child', key: 'solo.a.b.c', existing: ['solo'] });
  });

  it('a key that differs only by case names the existing spelling', () => {
    expect(findKeyCollision(data(), 'arch.API')).toEqual({ kind: 'case', key: 'arch.API', existing: ['arch.api'] });
    expect(findKeyCollision(data(), 'Solo')).toEqual({ kind: 'case', key: 'Solo', existing: ['solo'] });
    // The difference can sit in any segment: these are one file on a case-insensitive filesystem.
    expect(findKeyCollision(data(), 'ARCH.deep.one')).toEqual({ kind: 'case', key: 'ARCH.deep.one', existing: ['arch.deep.one'] });
  });

  it('case is ignored for the parent and child checks too', () => {
    expect(findKeyCollision(data(), 'ARCH')?.kind).toBe('parent');
    expect(findKeyCollision(data(), 'Arch.Api.v2')).toEqual({ kind: 'child', key: 'Arch.Api.v2', existing: ['arch.api'] });
  });

  it('a new leaf beside a differently-cased parent is allowed: no two keys become one file', () => {
    // arch.deep.one and Arch.deep.three are different files on every filesystem.
    expect(findKeyCollision(data(), 'Arch.deep.three')).toBeNull();
  });

  it('assertKeyWritable throws a KeyCollisionError with an existing envelope code and a message naming both keys', () => {
    let thrown: unknown;
    try { assertKeyWritable(data(), 'arch'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(KeyCollisionError);
    const err = thrown as KeyCollisionError;
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain("Refusing to write 'arch'");
    expect(err.message).toContain("parent of 4 entries ('arch.api', 'arch.auth', 'arch.deep.one', 'arch.deep.two')");
    expect(() => assertKeyWritable(data(), 'arch.api.v2')).toThrow(/'arch\.api' holds a value/);
    expect(() => assertKeyWritable(data(), 'arch.API')).toThrow(/differs only by case from the existing key 'arch\.api'/);
    expect(() => assertKeyWritable(data(), 'arch.api')).not.toThrow();
  });

  it('a parent of many entries names five and counts the rest', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 8; i++) many[`k${i}`] = 'v';
    expect(() => assertKeyWritable({ big: many } as CodexData, 'big')).toThrow(/parent of 8 entries \('big\.k0', 'big\.k1', 'big\.k2', 'big\.k3', 'big\.k4', and 3 more\)/);
  });
});

describe('collidesWithAny and findCollidingPairs', () => {
  it('collidesWithAny answers for a directory listing', () => {
    const keys = ['arch.api', 'arch.auth', 'solo'];
    expect(collidesWithAny('arch.api', keys)).toBe(false);      // the same key
    expect(collidesWithAny('arch.new', keys)).toBe(false);
    expect(collidesWithAny('arch', keys)).toBe(true);           // parent
    expect(collidesWithAny('solo.child', keys)).toBe(true);     // child
    expect(collidesWithAny('arch.API', keys)).toBe(true);       // case
    expect(collidesWithAny('ARCH', keys)).toBe(true);
    expect(collidesWithAny('archive', keys)).toBe(false);       // a shared prefix is not a parent
  });

  it('findCollidingPairs lists keys that cannot both exist', () => {
    expect(findCollidingPairs(['arch.authFlow', 'arch.authflow', 'arch.api', 'solo'])).toEqual([['arch.authFlow', 'arch.authflow']]);
    expect(findCollidingPairs(['arch.API', 'arch.api.v2', 'arch.api-x'])).toEqual([['arch.API', 'arch.api.v2']]);
    expect(findCollidingPairs(['a.b', 'a.c', 'ab'])).toEqual([]);
  });
});

interface Envelope {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings?: { code: string; message: string }[];
}

describe('a write that would remove or overwrite another entry is refused (#216, #224)', () => {
  const cli = path.resolve('dist/index.js');
  let dataDir: string;
  let projectDir: string;

  const rvr = (...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir };
    delete e.RVR_SESSION;
    delete e.RVR_NO_PROJECT;
    delete e.RVR_PROJECT;
    const r = spawnSync('bun', [cli, ...args], { cwd: projectDir, env: e as NodeJS.ProcessEnv, input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const json = (...args: string[]): Envelope => JSON.parse(rvr('--json', ...args).stdout) as Envelope;
  /** Entry keys on disk, without the two that `init` seeds. */
  const keys = (): string[] => fs.readdirSync(path.join(projectDir, '.reverie'))
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => f.slice(0, -'.json'.length))
    .filter(k => k !== 'conventions.persistence' && k !== 'context.initialized')
    .sort();
  const value = (key: string): string =>
    (JSON.parse(fs.readFileSync(path.join(projectDir, '.reverie', `${key}.json`), 'utf8')) as { value: string }).value;

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-collision-data-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-collision-proj-'));
    expect(rvr('init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    expect(rvr('set', 'arch.api', 'leaf value').status).toBe(0);
    expect(rvr('set', 'arch.auth', 'JWT').status).toBe(0);
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── set ──────────────────────────────────────────────────────────────

  it('set: a value written to a parent is refused and removes nothing', () => {
    const r = rvr('set', 'arch', 'a string');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing to write 'arch': it is the parent of 2 entries ('arch.api', 'arch.auth')");
    expect(r.stderr).not.toContain('Failed to set entry');
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
  });

  it('set: -f does not get past the refusal', () => {
    expect(rvr('set', '-f', 'arch', 'a string').status).toBe(1);
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
  });

  it('set: a key under a leaf is refused and the leaf keeps its value', () => {
    const r = rvr('set', 'arch.api.v2', 'child');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing to write 'arch.api.v2': 'arch.api' holds a value");
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
    expect(value('arch.api')).toBe('leaf value');
  });

  it('set: a key differing only by case is refused, on any filesystem', () => {
    const r = rvr('set', 'arch.API', 'from bob');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing to write 'arch.API': it differs only by case from the existing key 'arch.api'");
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
    expect(value('arch.api')).toBe('leaf value');
  });

  it('set: the JSON envelope carries INVALID_INPUT and the message', () => {
    for (const key of ['arch', 'arch.api.v2', 'arch.API']) {
      const env = json('set', key, 'v');
      expect(env.ok, key).toBe(false);
      expect(env.error?.code, key).toBe('INVALID_INPUT');
      expect(env.error?.message, key).toContain(`Refusing to write '${key}'`);
    }
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
  });

  it('set: ordinary writes are unaffected — overwrite, a sibling, a new namespace', () => {
    expect(rvr('set', '-f', 'arch.api', 'new value').status).toBe(0);
    expect(rvr('set', 'arch.cache', 'LRU').status).toBe(0);
    expect(rvr('set', 'archive.old', 'kept').status).toBe(0);
    expect(keys()).toEqual(['arch.api', 'arch.auth', 'arch.cache', 'archive.old']);
    expect(value('arch.api')).toBe('new value');
  });

  // ── copy ─────────────────────────────────────────────────────────────

  it('copy: onto a parent is refused even with -f', () => {
    expect(rvr('set', 'solo', 'value').status).toBe(0);
    const r = rvr('copy', 'solo', 'arch', '-f');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing to write 'arch'");
    expect(keys()).toEqual(['arch.api', 'arch.auth', 'solo']);
  });

  it('copy: under a leaf is refused', () => {
    const r = rvr('copy', 'arch.auth', 'arch.api.copy');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("'arch.api' holds a value");
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
  });

  it('copy: a subtree whose leaves would land under a leaf is refused, and nothing is half-written', () => {
    expect(rvr('set', 'dest', 'a leaf').status).toBe(0);
    const r = rvr('copy', 'arch', 'dest.sub', '-f');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("'dest' holds a value");
    expect(keys()).toEqual(['arch.api', 'arch.auth', 'dest']);
  });

  it('copy: to a new key, and a subtree to a new parent, still work', () => {
    expect(rvr('copy', 'arch.api', 'arch.api2').status).toBe(0);
    expect(rvr('copy', 'arch', 'mirror').status).toBe(0);
    expect(keys()).toEqual(['arch.api', 'arch.api2', 'arch.auth', 'mirror.api', 'mirror.api2', 'mirror.auth']);
  });

  // ── rename ───────────────────────────────────────────────────────────

  it('rename: to a key under a leaf is refused and the source stays', () => {
    expect(rvr('set', 'solo', 'value').status).toBe(0);
    const r = rvr('rename', 'solo', 'arch.api.moved');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("'arch.api' holds a value");
    expect(keys()).toEqual(['arch.api', 'arch.auth', 'solo']);
    expect(value('solo')).toBe('value');
  });

  it('rename: to a key differing only by case from another entry is refused', () => {
    expect(rvr('set', 'solo', 'value').status).toBe(0);
    const r = rvr('rename', 'solo', 'arch.API');
    expect(r.status).toBe(1);
    expect(keys()).toEqual(['arch.api', 'arch.auth', 'solo']);
    expect(value('arch.api')).toBe('leaf value');
  });

  it('rename: changing only the case of a key is refused on any filesystem, and the entry stays', () => {
    const r = rvr('rename', 'arch.api', 'arch.API');
    expect(r.status).toBe(1);
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
    expect(value('arch.api')).toBe('leaf value');
  });

  it('rename: a leaf and a subtree to new keys still work', () => {
    expect(rvr('rename', 'arch.api', 'arch.rest').status).toBe(0);
    expect(rvr('rename', 'arch', 'design').status).toBe(0);
    expect(keys()).toEqual(['design.auth', 'design.rest']);
  });

  // ── import ───────────────────────────────────────────────────────────

  const importFile = (content: unknown): string => {
    const f = path.join(projectDir, 'incoming.json');
    fs.writeFileSync(f, JSON.stringify(content));
    return f;
  };

  it('import --merge: a leaf over a subtree is refused and nothing is imported', () => {
    const r = rvr('data', 'import', 'entries', importFile({ arch: 'flat', other: { key: 'v' } }), '--merge', '-f');
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("Refusing to write 'arch'");
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
  });

  it('import --merge: a subtree under a leaf, and a case variant, are refused', () => {
    expect(rvr('data', 'import', 'entries', importFile({ arch: { api: { v2: 'child' } } }), '--merge', '-f').status).toBe(1);
    expect(rvr('data', 'import', 'entries', importFile({ arch: { API: 'other' } }), '--merge', '-f').status).toBe(1);
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
    expect(value('arch.api')).toBe('leaf value');
  });

  it('import: a file holding two keys that differ only by case is refused in either mode', () => {
    const f = importFile({ notes: { Key: 'one', key: 'two' } });
    expect(rvr('data', 'import', 'entries', f, '--merge', '-f').status).toBe(1);
    expect(rvr('data', 'import', 'entries', f, '-f').status).toBe(1);
    expect(keys()).toEqual(['arch.api', 'arch.auth']);
  });

  it('import --merge: new keys and overwrites of the same key still merge', () => {
    const r = rvr('data', 'import', 'entries', importFile({ arch: { api: 'updated', cache: 'LRU' }, fresh: { k: 'v' } }), '--merge', '-f');
    expect(r.status).toBe(0);
    expect(keys()).toEqual(['arch.api', 'arch.auth', 'arch.cache', 'fresh.k']);
    expect(value('arch.api')).toBe('updated');
  });

  // ── lint ─────────────────────────────────────────────────────────────

  it('lint: flags a pair already on disk that differs only by case, and exits 1', () => {
    // A pair a case-sensitive committer pushed. Written as files, the way a
    // checkout delivers them; skipped where the filesystem folds them into one.
    const dir = path.join(projectDir, '.reverie');
    fs.writeFileSync(path.join(dir, 'arch.authFlow.json'), JSON.stringify({ value: 'alice', meta: { created: 1, updated: 1 } }));
    fs.writeFileSync(path.join(dir, 'arch.authflow.json'), JSON.stringify({ value: 'bob', meta: { created: 2, updated: 2 } }));
    const both = fs.readdirSync(dir).filter(f => f.toLowerCase() === 'arch.authflow.json').length === 2;
    if (!both) return;   // case-insensitive filesystem: the pair cannot exist as two files here
    const r = rvr('lint');
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("'arch.authFlow' and 'arch.authflow'");
  });
});
