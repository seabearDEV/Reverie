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

    it('import onto the key is refused whole: merge or replace, nothing lands', () => {
      const payload = path.join(dataDir, 'import.json');
      fs.writeFileSync(payload, JSON.stringify({ context: { next_session: 'imported', extra: 'x' }, arch: { store: 'imported' } }));
      for (const mode of [['--merge'], []]) {
        const r = rvr('data', 'import', 'entries', payload, '--force', '--global', ...mode);
        expect(r.status, mode.join(' ') || 'replace').toBe(1);
        expect(r.stderr).toContain(`Refusing to write entry '${HANDOFF}'`);
      }
      expect(read(`${HANDOFF}.json`)).toBe(before);
      expect(json('get', 'arch.store').result).toEqual({ 'arch.store': 'file per entry' });
      expect(fs.existsSync(file('context.extra.json'))).toBe(false);
    });

    it('a refused write is recorded as a refusal in the audit log', () => {
      rvr('set', '--global', HANDOFF, 'fresh');
      const rows = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n')
        .map(l => JSON.parse(l) as { tool: string; key?: string; success: boolean; refusedReason?: string });
      const last = rows[rows.length - 1];
      expect(last).toMatchObject({ tool: 'reverie_set', key: HANDOFF, success: false, refusedReason: 'store_unreadable' });
      // A failed read is an error, not a refusal.
      rvr('get', HANDOFF);
      const after = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n')
        .map(l => JSON.parse(l) as { tool: string; refusedReason?: string });
      expect(after[after.length - 1].tool).toBe('reverie_get');
      expect(after[after.length - 1].refusedReason).toBeUndefined();
    });

    it('a write under the conflicted key is refused: the two could not both exist', () => {
      const r = rvr('set', '--global', `${HANDOFF}.extra`, 'v');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`Refusing to write '${HANDOFF}.extra' under entry '${HANDOFF}'`);
      expect(fs.existsSync(file(`${HANDOFF}.extra.json`))).toBe(false);
      expect(read(`${HANDOFF}.json`)).toBe(before);
      expect(json('set', '--global', `${HANDOFF}.extra`, 'v').error?.code).toBe('STORE_UNREADABLE');
    });

    it('rm and rename of its parent are refused, even when it is the only child', () => {
      // `context` holds nothing but the conflicted handoff, so it looks absent.
      const removed = rvr('rm', '--global', '--force', 'context');
      expect(removed.status).toBe(1);
      expect(removed.stderr).toContain(`Refusing to remove 'context' while entry '${HANDOFF}' under it cannot be read`);
      expect(removed.stderr).not.toContain('not found');

      const renamed = rvr('rename', '--global', 'context', 'ctx');
      expect(renamed.status).toBe(1);
      expect(renamed.stderr).toContain(`Refusing to rename 'context' while entry '${HANDOFF}' under it cannot be read`);
      expect(read(`${HANDOFF}.json`)).toBe(before);
      expect(json('rm', '--global', '--force', 'context').error?.code).toBe('STORE_UNREADABLE');
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

    it('context: past the cap, the files the report does not name are named on stderr', () => {
      for (let i = 0; i < 10; i++) gitWrite(`context.conflicted${String(i).padStart(2, '0')}.json`, before);
      const r = rvr('context', '--plain');
      expect(r.stdout.split('\n')[0]).toContain('11 store files cannot be read');
      expect(r.stdout).toContain('… and 3 more');
      // 11 files sorted by path: the report lists the first eight.
      expect(r.stdout).toContain('context.conflicted07 — ');
      expect(r.stdout).not.toContain('context.conflicted08');
      expect(r.stderr).toContain('warning: 3 store files cannot be read:');
      for (const rest of ['context.conflicted08.json', 'context.conflicted09.json', `${HANDOFF}.json`]) {
        expect(r.stderr, rest).toContain(`${rest} has unresolved git conflict markers`);
      }
      expect(r.stderr).not.toContain('context.conflicted07');
    });

    it('run of a command that interpolates the conflicted key fails as unreadable, and names it once', () => {
      expect(rvr('set', '--global', 'commands.show', 'echo ${context.next_session}').status).toBe(0);
      const e = json('run', '--global', '--yes', 'commands.show');
      expect(e.ok).toBe(false);
      expect(e.error?.code).toBe('STORE_UNREADABLE');

      const r = rvr('run', '--global', '--yes', 'commands.show');
      expect(r.status).toBe(1);
      expect(r.stderr.match(/has unresolved git conflict markers/g)).toHaveLength(1);
    });

    it('lint: lists it and fails', () => {
      const r = rvr('lint', '--global');
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('1 store file cannot be read');
      // The line under the list must not read as an all-clear.
      expect(r.stdout).not.toContain('No schema issues found.');
      expect(r.stdout).toContain('No schema issues in the entries that could be read.');
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

  describe('a conflicted entry under a parent, with an alias and a confirm flag of its own', () => {
    let aliasesBefore: string;
    let confirmBefore: string;
    beforeEach(() => {
      expect(rvr('set', '--global', 'commands.deploy', 'echo deploy', '--confirm', '-a', 'dep').status).toBe(0);
      aliasesBefore = read('_aliases.json');
      confirmBefore = read('_confirm.json');
      gitWrite('commands.deploy.json', conflictedEntry('echo deploy-ours', 'echo deploy-theirs'));
    });

    it('rm of the parent is refused: it would keep the file and drop its alias and its flag', () => {
      // The cascade removes every alias and flag under the prefix. The file
      // it could not read stayed on disk — and ran unconfirmed once resolved.
      const r = rvr('rm', '--global', '--force', 'commands');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Refusing to remove 'commands' while entry 'commands.deploy' under it cannot be read");
      expect(r.stdout).not.toContain('removed successfully');
      expect(fs.existsSync(file('commands.hello.json'))).toBe(true);
      expect(read('_aliases.json')).toBe(aliasesBefore);
      expect(read('_confirm.json')).toBe(confirmBefore);
    });

    it('rename of the parent is refused before anything moves', () => {
      const r = rvr('rename', '--global', 'commands', 'cmds');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Refusing to rename 'commands' while entry 'commands.deploy' under it cannot be read");
      expect(fs.existsSync(file('commands.hello.json'))).toBe(true);
      expect(fs.existsSync(file('cmds.hello.json'))).toBe(false);
      expect(read('_aliases.json')).toBe(aliasesBefore);
      expect(read('_confirm.json')).toBe(confirmBefore);
    });

    it('a sibling can still be removed', () => {
      expect(rvr('rm', '--global', '--force', 'commands.hello').status).toBe(0);
      expect(fs.existsSync(file('commands.hello.json'))).toBe(false);
      expect(read('_confirm.json')).toBe(confirmBefore);
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

    it('alias remove and alias rename are refused — not "not found"', () => {
      // Both sides of the conflict define `hand`. The map loads as empty, so
      // a lookup in it used to answer NOT_FOUND.
      for (const args of [['alias', 'remove', 'hand', '--global'], ['alias', 'rename', 'hand', 'h2', '--global'], ['rm', '--global', '-a', 'hand']]) {
        const r = rvr(...args);
        expect(r.status, args.join(' ')).toBe(1);
        expect(r.stderr, args.join(' ')).toContain('Refusing to write the alias map');
        expect(r.stderr, args.join(' ')).not.toContain('not found');
      }
      expect(json('alias', 'remove', 'hand', '--global').error?.code).toBe('STORE_UNREADABLE');
      expect(json('alias', 'rename', 'hand', 'h2', '--global').error?.code).toBe('STORE_UNREADABLE');
      expect(read('_aliases.json')).toBe(before);
    });

    it('commands that also touch the alias map refuse BEFORE their first write', () => {
      // Each of these writes the entry first and the alias map second. A
      // refusal that arrives at the second write leaves the first one done.
      const setBoth = rvr('set', '--global', 'arch.store', 'v2', '-a', 'zz');
      expect(setBoth.status).toBe(1);
      expect(setBoth.stderr).toContain('Refusing to write the alias map');
      expect(setBoth.stdout).not.toContain('set successfully');

      const renamed = rvr('rename', '--global', 'arch.store', 'arch.moved');
      expect(renamed.status).toBe(1);
      expect(renamed.stderr).toContain('Refusing to write the alias map');

      const removed = rvr('rm', '--global', '--force', 'arch.store');
      expect(removed.status).toBe(1);
      expect(removed.stderr).toContain('Refusing to write the alias map');

      expect(json('get', 'arch.store').result).toEqual({ 'arch.store': 'file per entry' });
      expect(fs.existsSync(file('arch.moved.json'))).toBe(false);
      expect(read('_aliases.json')).toBe(before);
    });

    it('set --confirm -a with no value refuses before the confirmation list is written', () => {
      // Two writes: the flag, then the alias. A refusal at the second used to
      // leave the first one done, under a message saying nothing was written.
      const confirmBefore = read('_confirm.json');
      const r = rvr('set', '--global', 'commands.hello', '--confirm', '-a', 'hi');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Refusing to write the alias map');
      expect(r.stdout).not.toContain('now requires confirmation');
      expect(read('_confirm.json')).toBe(confirmBefore);
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

    it('set --confirm, rename and rm refuse BEFORE their first write', () => {
      const setBoth = rvr('set', '--global', 'arch.store', 'v2', '--confirm');
      expect(setBoth.status).toBe(1);
      expect(setBoth.stderr).toContain('Refusing to write the confirmation list');
      expect(setBoth.stdout).not.toContain('set successfully');

      // rename asks "does the old key carry a flag to move?". That answer
      // must not be the run gate's fail-closed "yes", and with the list
      // unreadable there is no honest answer — so it refuses up front.
      const renamed = rvr('rename', '--global', 'arch.store', 'arch.moved');
      expect(renamed.status).toBe(1);
      expect(renamed.stderr).toContain('Refusing to write the confirmation list');

      expect(rvr('rm', '--global', '--force', 'arch.store').status).toBe(1);

      expect(json('get', 'arch.store').result).toEqual({ 'arch.store': 'file per entry' });
      expect(fs.existsSync(file('arch.moved.json'))).toBe(false);
      expect(read('_confirm.json')).toBe(before);
    });

    it('a plain set and a copy do not involve the list and still work', () => {
      expect(rvr('set', '--global', 'arch.store', 'v2').status).toBe(0);
      expect(rvr('copy', '--global', 'arch.store', 'arch.copy').status).toBe(0);
      expect(json('get', 'arch.copy').result).toEqual({ 'arch.copy': 'v2' });
      expect(read('_confirm.json')).toBe(before);
    });

    it('confirm remove and set --no-confirm are refused — they used to report success and change nothing', () => {
      const removed = rvr('confirm', 'remove', 'commands.deploy', '--global');
      expect(removed.status).toBe(1);
      expect(removed.stderr).toContain('Refusing to write the confirmation list');
      expect(removed.stdout).not.toContain('Confirmation removed');

      const unset = rvr('set', '--global', 'commands.hello', '--no-confirm');
      expect(unset.status).toBe(1);
      expect(unset.stderr).toContain('Refusing to write the confirmation list');
      expect(unset.stdout).not.toContain('no longer requires confirmation');

      expect(json('confirm', 'remove', 'commands.deploy', '--global').error?.code).toBe('STORE_UNREADABLE');
      expect(read('_confirm.json')).toBe(before);
    });

    it('confirm set is refused and the file is untouched', () => {
      const r = rvr('confirm', 'set', 'arch.store', '--global');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Refusing to write the confirmation list');
      expect(read('_confirm.json')).toBe(before);
    });
  });
});

// A project store beside the global one. Reads in the default scope look in
// the project first and fall through to the global store; writes land in the
// project. A broken file is a refused write only where the write would land.
describe('a project store beside a global one (#215)', () => {
  const cli = path.resolve('dist/index.js');
  let dataDir: string;
  let projectDir: string;

  const rvrIn = (cwd: string, ...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir };
    delete e.RVR_SESSION;
    delete e.RVR_NO_PROJECT;
    delete e.RVR_PROJECT;
    const r = spawnSync('bun', [cli, ...args], { cwd, env: e as NodeJS.ProcessEnv, input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const json = (...args: string[]): Envelope => JSON.parse(rvrIn(projectDir, '--json', ...args).stdout) as Envelope;
  const globalFile = (name: string) => path.join(dataDir, 'store', name);
  const projectFile = (name: string) => path.join(projectDir, '.reverie', name);
  const TRUNCATED = '{\n  "value": "trunc';

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-unreadable-data-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-unreadable-proj-'));
    expect(rvrIn(projectDir, 'init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    expect(rvrIn(projectDir, 'set', '--global', 'zz.note', 'global value').status).toBe(0);
    expect(rvrIn(projectDir, 'set', 'arch.store', 'file per entry').status).toBe(0);
    fs.writeFileSync(globalFile('zz.note.json'), TRUNCATED);
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('a broken GLOBAL file does not block a project write of the same key', () => {
    const e = json('set', 'zz.note', 'project value');
    expect(e.ok).toBe(true);
    expect((JSON.parse(fs.readFileSync(projectFile('zz.note.json'), 'utf8')) as { value: string }).value).toBe('project value');
    expect(fs.readFileSync(globalFile('zz.note.json'), 'utf8')).toBe(TRUNCATED);
  });

  it('nor a copy or a rename onto that key in the project', () => {
    expect(json('copy', 'arch.store', 'zz.note').ok).toBe(true);
    expect(fs.existsSync(projectFile('zz.note.json'))).toBe(true);
    fs.rmSync(projectFile('zz.note.json'));
    expect(json('rename', 'arch.store', 'zz.note').ok).toBe(true);
    expect(fs.existsSync(projectFile('zz.note.json'))).toBe(true);
    expect(fs.readFileSync(globalFile('zz.note.json'), 'utf8')).toBe(TRUNCATED);
  });

  it('a write aimed at the global store is still refused, and a read still fails', () => {
    const w = json('set', '--global', 'zz.note', 'replacement');
    expect(w.ok).toBe(false);
    expect(w.error?.code).toBe('STORE_UNREADABLE');
    expect(w.error?.message).toMatch(/^Refusing to write entry 'zz\.note'/);
    expect(fs.readFileSync(globalFile('zz.note.json'), 'utf8')).toBe(TRUNCATED);

    const r = json('get', 'zz.note');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('STORE_UNREADABLE');
  });

  it('rm in the default scope does not claim to remove a key that exists only in the global store', () => {
    // The lookup falls through to the global store; the removal never does.
    expect(rvrIn(projectDir, 'set', '--global', 'notes.todo', 'global only').status).toBe(0);
    const r = rvrIn(projectDir, 'rm', '--force', 'notes.todo');
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('removed successfully');
    expect(r.stderr).toContain("Entry 'notes.todo' not found in the project store");
    expect(r.stderr).toContain('--global');

    const e = json('rm', '--force', 'notes.todo');
    expect(e.ok).toBe(false);
    expect(e.error?.code).toBe('NOT_FOUND');
    expect(json('get', 'notes.todo').result).toEqual({ 'notes.todo': 'global only' });

    expect(rvrIn(projectDir, 'rm', '--force', '--global', 'notes.todo').status).toBe(0);
    expect(json('get', 'notes.todo').error?.code).toBe('NOT_FOUND');
  });

  it('init skips a seed key it cannot read, and still finishes', () => {
    // Two branches both ran the first-session bootstrap: the marker conflicts.
    fs.writeFileSync(projectFile('context.initialized.json'), TRUNCATED);
    const r = rvrIn(projectDir, 'init', '--force');
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain('Skipped context.initialized');
    expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(true);
    // The other seed still landed, and the broken file was left alone.
    expect(fs.existsSync(projectFile('conventions.persistence.json'))).toBe(true);
    expect(fs.readFileSync(projectFile('context.initialized.json'), 'utf8')).toBe(TRUNCATED);
  });

  it('a broken PROJECT file is still a refused write', () => {
    fs.writeFileSync(projectFile('arch.store.json'), TRUNCATED);
    const e = json('set', 'arch.store', 'replacement');
    expect(e.ok).toBe(false);
    expect(e.error?.code).toBe('STORE_UNREADABLE');
    expect(fs.readFileSync(projectFile('arch.store.json'), 'utf8')).toBe(TRUNCATED);
  });
});
