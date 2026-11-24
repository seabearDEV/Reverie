// #215 step 1, end to end: every command against a store that `git merge`
// left conflict markers in. Before the fix the conflicted handoff read as
// "not found", the bootstrap showed nothing, lint passed, and the next `set`
// replaced the file — both sides of the conflict gone.
//
// Spawns the built dist/index.js (assumes `bun run build` has run), against
// the global store of a private data dir.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

interface Envelope {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings?: { code: string; message: string }[];
}

describe('a store with git conflict markers in it (#215)', () => {
  let dataDir: string;
  let storeDir: string;

  const HANDOFF = 'context.next_session';
  const env = () => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir, RVR_NO_PROJECT: '1' };
    delete e.RVR_SESSION;
    return e as NodeJS.ProcessEnv;
  };
  const rvr = (...args: string[]) => {
    const r = spawnSync('bun', ['dist/index.js', ...args], { env: env(), input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const json = (...args: string[]): Envelope => JSON.parse(rvr('--json', ...args).stdout) as Envelope;
  const file = (name: string) => path.join(storeDir, name);
  const read = (name: string) => fs.readFileSync(file(name), 'utf8');
  const epoch = (): number => (JSON.parse(read('_epoch.json')) as { epoch: number }).epoch;

  const conflictedEntry = (ours: string, theirs: string): string => [
    '{', '<<<<<<< HEAD', `  "value": ${JSON.stringify(ours)},`, '  "meta": {', '    "created": 1000,', '    "updated": 3000',
    '=======', `  "value": ${JSON.stringify(theirs)},`, '  "meta": {', '    "created": 1000,', '    "updated": 2000',
    '>>>>>>> theirs', '  }', '}', '',
  ].join('\n');
  const conflictedSidecar = (ours: string, theirs: string): string =>
    ['{', '<<<<<<< HEAD', `  ${ours}`, '=======', `  ${theirs}`, '>>>>>>> theirs', '}', ''].join('\n');
  /** Replace a file the way git does: remove, then create. */
  const gitWrite = (name: string, content: string): void => {
    fs.rmSync(file(name), { force: true });
    fs.writeFileSync(file(name), content);
  };

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-unreadable-cli-'));
    storeDir = path.join(dataDir, 'store');
    expect(rvr('set', '--global', HANDOFF, 'base handoff').status).toBe(0);
    expect(rvr('set', '--global', 'arch.store', 'file per entry', '-a', 'st').status).toBe(0);
    expect(rvr('set', '--global', 'commands.hello', 'echo hello').status).toBe(0);
  });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  describe('a conflicted entry', () => {
    let before: string;
    beforeEach(() => {
      before = conflictedEntry('our handoff', 'their handoff');
      gitWrite(`${HANDOFF}.json`, before);
    });

    it('get: an error that names the conflict, not "not found"', () => {
      const r = rvr('get', HANDOFF);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(`Cannot read entry '${HANDOFF}'`);
      expect(r.stderr).toContain('unresolved git conflict markers');
      expect(r.stderr).toContain('git checkout --ours --');
      expect(r.stderr).not.toMatch(/not found\b(?!")/);
      // One line, not a stack trace.
      expect(r.stderr).not.toContain('    at ');

      const e = json('get', HANDOFF);
      expect(e.ok).toBe(false);
      expect(e.error?.code).toBe('STORE_UNREADABLE');
    });

    it('get of a healthy key still works, with a warning on stderr and in warnings[]', () => {
      const r = rvr('get', 'arch.store');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('file per entry');
      expect(r.stderr).toContain('warning: ');
      expect(r.stderr).toContain(`entry '${HANDOFF}' is not being read`);

      const e = json('get', 'arch.store');
      expect(e.ok).toBe(true);
      expect(e.warnings?.map(w => w.code)).toEqual(['STORE_UNREADABLE']);
      expect(e.warnings?.[0].message).toContain(`${HANDOFF}.json has unresolved git conflict markers`);
    });

    it('set: refused, the file and the epoch untouched', () => {
      const epochBefore = epoch();
      const r = rvr('set', '--global', HANDOFF, 'a fresh handoff');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`Refusing to write entry '${HANDOFF}'`);
      expect(r.stderr).toContain('Nothing was written');
      // The refusal names the file itself; the wrapper must not repeat it.
      expect(r.stderr.match(/unresolved git conflict markers/g)).toHaveLength(1);
      expect(read(`${HANDOFF}.json`)).toBe(before);
      expect(epoch()).toBe(epochBefore);

      const e = json('set', '--global', HANDOFF, 'a fresh handoff');
      expect(e.ok).toBe(false);
      expect(e.error?.code).toBe('STORE_UNREADABLE');
      expect(e.error?.message).toMatch(/^Refusing to write/);
      expect(read(`${HANDOFF}.json`)).toBe(before);
    });

    it('set from stdin, set --force, copy --force and rename onto the key are all refused', () => {
      const piped = spawnSync('bun', ['dist/index.js', 'set', '--global', HANDOFF], { env: env(), input: 'piped handoff\n' });
      expect(piped.status).toBe(1);
      for (const args of [
        ['set', '--global', '--force', HANDOFF, 'forced'],
        ['copy', '--global', '--force', 'arch.store', HANDOFF],
        ['rename', '--global', 'arch.store', HANDOFF],
      ]) {
        const r = rvr(...args);
        expect(r.status, args.join(' ')).toBe(1);
        expect(r.stderr, args.join(' ')).toContain(`Refusing to write entry '${HANDOFF}'`);
      }
      expect(read(`${HANDOFF}.json`)).toBe(before);
      expect(json('get', 'arch.store').result).toEqual({ 'arch.store': 'file per entry' });
    });

    it('the slow write path is guarded too (a parent leaf forces a full save)', () => {
      // q.json is a leaf, so writing q.x cannot take the one-file fast path.
      expect(rvr('set', '--global', 'q', 'leaf').status).toBe(0);
      const child = conflictedEntry('ours', 'theirs');
      gitWrite('q.x.json', child);
      const e = json('set', '--global', 'q.x', 'new');
      expect(e.ok).toBe(false);
      expect(e.error?.code).toBe('STORE_UNREADABLE');
      expect(read('q.x.json')).toBe(child);
      expect(json('get', 'q').result).toEqual({ q: 'leaf' });
      expect(epoch() % 2).toBe(0);
    });

    it('rm of the conflicted key fails without deleting it', () => {
      const e = json('rm', '--global', HANDOFF);
      expect(e.ok).toBe(false);
      expect(e.error?.code).toBe('STORE_UNREADABLE');
      expect(read(`${HANDOFF}.json`)).toBe(before);
    });

    it('other keys can still be written, and the conflict is left alone', () => {
      expect(rvr('set', '--global', 'arch.new', 'still writable').status).toBe(0);
      expect(rvr('set', '--global', 'arch.store', 'rewritten').status).toBe(0);
      expect(read(`${HANDOFF}.json`)).toBe(before);
    });

    it('context: the report leads the output, ahead of everything else', () => {
      const r = rvr('context', '--plain');
      expect(r.status).toBe(0);
      const lines = r.stdout.split('\n');
      expect(lines[0]).toBe('!! 1 store file cannot be read. It is NOT shown below and NOT missing — do not write over it:');
      expect(lines[1]).toContain(`${HANDOFF} — `);
      expect(r.stdout).toContain('arch.store');
      // Said once, in the body — not again on stderr.
      expect(r.stderr).not.toContain('unresolved git conflict markers');

      const e = json('context');
      expect(e.ok).toBe(true);
      expect(e.result?.unreadable).toEqual([
        { kind: 'entry', key: HANDOFF, file: file(`${HANDOFF}.json`), reason: 'conflict' },
      ]);
      expect(e.result?.handoff).toBeUndefined();
      expect(e.warnings?.some(w => w.code === 'STORE_UNREADABLE')).toBe(true);
    });

    it('context: the report is counted against the budget, so the output still fits', () => {
      // Enough index lines to fill the budget, and enough conflicted files
      // that the report (~1.5 KB) is far larger than the composer's fixed
      // allowance for notices — leaving it out of the sum overshoots.
      for (let i = 0; i < 60; i++) {
        fs.writeFileSync(file(`context.filler${i}.json`), JSON.stringify({ value: `filler ${i} ${'x'.repeat(400)}`, meta: { created: 1, updated: 2 } }));
      }
      for (let i = 0; i < 7; i++) gitWrite(`context.conflicted${i}.json`, before);
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ bootstrap_max_response_bytes: 4096 }));
      const r = rvr('context', '--plain');
      expect(r.stdout.split('\n')[0]).toContain('8 store files cannot be read');
      const report = r.stdout.slice(0, r.stdout.indexOf('\n\n'));
      expect(Buffer.byteLength(report, 'utf8')).toBeGreaterThan(1024);
      expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(4096);
    });

    it('lint: lists it and fails', () => {
      const r = rvr('lint', '--global');
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('1 store file cannot be read');
      expect(r.stdout).toContain(`${HANDOFF}.json has unresolved git conflict markers`);
      expect(r.stderr).not.toContain('unresolved git conflict markers');

      const e = json('lint', '--global');
      expect(e.ok).toBe(false);
      expect(e.error?.code).toBe('STORE_UNREADABLE');
      expect(e.result?.unreadable).toEqual([
        expect.objectContaining({ kind: 'entry', key: HANDOFF, reason: 'conflict' }),
      ]);
    });

    it('everything is back to normal once the file is resolved', () => {
      gitWrite(`${HANDOFF}.json`, JSON.stringify({ value: 'their handoff', meta: { created: 1000, updated: 2000 } }, null, 2));
      const got = rvr('get', HANDOFF);
      expect(got.status).toBe(0);
      expect(got.stdout).toContain('their handoff');
      expect(got.stderr).toBe('');
      expect(rvr('lint', '--global').status).toBe(0);
      expect(json('context').result?.unreadable).toBeUndefined();
      expect(rvr('set', '--global', HANDOFF, 'next').status).toBe(0);
    });
  });

  describe('a healthy store', () => {
    it('lint passes and nothing is warned about', () => {
      const r = rvr('lint', '--global');
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      const e = json('context');
      expect(e.result?.unreadable).toBeUndefined();
      expect(e.warnings).toBeUndefined();
    });

    it('a missing key is still NOT_FOUND', () => {
      const e = json('get', 'context.nope');
      expect(e.ok).toBe(false);
      expect(e.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('a conflicted alias map', () => {
    let before: string;
    beforeEach(() => {
      before = conflictedSidecar('"hand": "context.next_session",', '"ho": "context.next_session",');
      gitWrite('_aliases.json', before);
    });

    it('alias set / remove are refused and the file is untouched', () => {
      for (const args of [['alias', 'set', 'zz', 'arch.store', '--global'], ['set', '--global', 'arch.store', '-a', 'zz']]) {
        const r = rvr(...args);
        expect(r.status, args.join(' ')).toBe(1);
        expect(r.stderr, args.join(' ')).toContain('Refusing to write the alias map');
        expect(r.stderr, args.join(' ')).not.toContain('    at ');
      }
      expect(read('_aliases.json')).toBe(before);
      const e = json('alias', 'set', 'zz', 'arch.store', '--global');
      expect(e.error?.code).toBe('STORE_UNREADABLE');
      expect(read('_aliases.json')).toBe(before);
    });

    it('reads say no aliases are being read; entry writes still work', () => {
      const r = rvr('get', 'arch.store');
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('no aliases are being read');
      expect(rvr('set', '--global', 'arch.store', 'rewritten').status).toBe(0);
      expect(read('_aliases.json')).toBe(before);
    });
  });

  describe('a conflicted confirmation list', () => {
    let before: string;
    beforeEach(() => {
      before = conflictedSidecar('"commands.deploy": true,', '"commands.wipe": true,');
      gitWrite('_confirm.json', before);
    });

    it('run fails closed: an entry with no flag requires confirmation', () => {
      const r = rvr('run', '--global', 'commands.hello');
      expect(r.status).toBe(1);
      expect(r.stdout).not.toMatch(/^hello$/m);
      expect(r.stderr).toContain('requires confirmation');
      expect(r.stderr).toContain('every entry is treated as requiring confirmation to run');

      const e = json('run', '--global', 'commands.hello');
      expect(e.ok).toBe(false);
      expect(e.error?.code).toBe('REQUIRES_CONFIRMATION');

      // The explicit override still works.
      expect(rvr('run', '--global', '--yes', '--capture', 'commands.hello').stdout).toContain('hello');
    });

    it('confirm set is refused and the file is untouched', () => {
      const r = rvr('confirm', 'set', 'arch.store', '--global');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Refusing to write the confirmation list');
      expect(read('_confirm.json')).toBe(before);
    });
  });
});
