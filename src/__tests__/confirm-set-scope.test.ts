// Where `confirm set` and a flag-only `set --confirm` list a flag, and what
// `confirm remove` says afterwards.
//
//   #255  The flag is listed under the entry's stored spelling. `confirm set`
//         accepts any spelling that opens the entry, and on APFS `ops.ﬁx`
//         (fi ligature) or `opſ.fix` (long s) opens `ops.fix`'s file — but
//         nothing on a case-sensitive volume or on Linux. A flag listed as
//         typed gated there nothing, while `confirm list` showed a name that
//         looks like the real key.
//   #256  An entry stored only in the global store takes a flag in the global
//         list. In a project's list, a `rename -G` run from another project
//         could not see it: it moved the entry, carried no flag, and the
//         renamed command ran unasked in the project that had flagged it.
//   #257  The flag-only `set --confirm` / `--no-confirm` looks the key up as
//         `confirm set` does; `confirm remove` says every list that still
//         holds a flag, says a list it cannot read may, succeeds when it did
//         remove the flag, and ignores names every object has.
//
// Spawns the built dist/index.js against two projects, a directory outside
// any project and one global store, all in temp directories. What another
// spelling opens is the filesystem's rule: a case that needs one asks the
// temp dir first and has nothing to check where it does not fold.

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

const LIGATURE = String.fromCodePoint(0xfb01);   // ﬁ
const LONG_S = String.fromCodePoint(0x17f);      // ſ
const NFC_E = String.fromCodePoint(0xe9);        // é, one code point
const NFD_E = `e${String.fromCodePoint(0x301)}`; // e + combining acute

describe('where a confirmation flag is listed (#255, #256, #257)', () => {
  const cli = path.resolve('dist/index.js');
  const REFUSAL = 'Entry requires confirmation';
  const SLOW_TEST_MS = 30_000;
  let root: string;
  let dataDir: string;
  const dir = (where: 'p1' | 'p2' | 'outside') => path.join(root, where);

  const rvrIn = (where: 'p1' | 'p2' | 'outside', ...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir, RVR_AGENT_NAME: 'test' };
    delete e.RVR_SESSION;
    delete e.RVR_NO_PROJECT;
    delete e.RVR_PROJECT;
    delete e.RVR_OUTPUT;
    const r = spawnSync('bun', [cli, ...args], { cwd: dir(where), env: e as NodeJS.ProcessEnv, input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const rvr = (...args: string[]) => rvrIn('p1', ...args);
  const jsonIn = (where: 'p1' | 'p2' | 'outside', ...args: string[]): Envelope => JSON.parse(rvrIn(where, '--json', ...args).stdout) as Envelope;
  const json = (...args: string[]) => jsonIn('p1', ...args);
  const marker = (name: string) => path.join(root, `ran-${name}`);
  const touch = (name: string) => `touch ${marker(name)}`;
  const ran = (name: string) => fs.existsSync(marker(name));
  const flagsIn = (storeDir: string): string[] => {
    const file = path.join(storeDir, '_confirm.json');
    return fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')) as object).sort() : [];
  };
  const projectStore = (p: 'p1' | 'p2' = 'p1') => path.join(dir(p), '.reverie');
  const globalStore = () => path.join(dataDir, 'store');
  const projectFlags = (p: 'p1' | 'p2' = 'p1') => flagsIn(projectStore(p));
  const globalFlags = () => flagsIn(globalStore());
  const aliasesIn = (storeDir: string): Record<string, string> => {
    const file = path.join(storeDir, '_aliases.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string> : {};
  };
  /** Does `storeDir`'s filesystem open `stored`'s entry file for `asked`? */
  const opens = (storeDir: string, asked: string, stored: string) => {
    const a = path.join(storeDir, `${asked}.json`);
    const b = path.join(storeDir, `${stored}.json`);
    return a !== b && fs.existsSync(a) && fs.existsSync(b) && fs.statSync(a).ino === fs.statSync(b).ino;
  };

  beforeAll(() => { assertDistHonorsDataDir(); });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-flagscope-'));
    dataDir = path.join(root, 'data');
    for (const d of ['p1', 'p2', 'outside', 'data']) fs.mkdirSync(path.join(root, d), { recursive: true });
    expect(rvrIn('p1', 'init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    expect(rvrIn('p2', 'init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // ── #255: the stored spelling ────────────────────────────────────────

  describe('the flag is listed under the stored spelling (#255)', () => {
    it.each([
      ['fi ligature (U+FB01)', 'ops.fix', `ops.${LIGATURE}x`],
      ['long s (U+017F)', 'ops.start', `op${LONG_S}.start`],
      ['NFD for an NFC key', `caf${NFC_E}.go`, `caf${NFD_E}.go`],
    ])('confirm set under a %s spelling', (_name, stored, asked) => {
      expect(rvr('set', stored, touch('stored')).status).toBe(0);
      const folds = opens(projectStore(), asked, stored);
      const r = rvr('confirm', 'set', asked);
      if (!folds) {
        // This filesystem keeps the two apart: the spelling names nothing.
        expect(r.status).toBe(1);
        expect(projectFlags()).toEqual([]);
        return;
      }
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Entry '${stored}' (as typed: '${asked}') now requires confirmation to run.`);
      // Listed as stored: it gates by name wherever the files are copied.
      expect(projectFlags()).toEqual([stored]);
      expect(rvr('run', stored).stderr).toContain(REFUSAL);
      expect(ran('stored')).toBe(false);
      // In JSON, the name it is listed under and the one typed.
      expect(rvr('confirm', 'remove', stored).status).toBe(0);
      expect(json('confirm', 'set', asked).result).toEqual({ key: stored, confirm: true, typed: asked });
      expect(projectFlags()).toEqual([stored]);
    });

    it('a flag-only set --confirm under such a spelling: the same', () => {
      const stored = 'ops.fix';
      const asked = `ops.${LIGATURE}x`;
      expect(rvr('set', stored, touch('fix')).status).toBe(0);
      const r = rvr('set', asked, '--confirm');
      if (!opens(projectStore(), asked, stored)) {
        expect(r.status).toBe(1);
        return;
      }
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Entry '${stored}' (as typed: '${asked}') now requires confirmation to run.`);
      expect(projectFlags()).toEqual([stored]);
    });

    it('a flag listed so still gates on a filesystem that folds nothing: copied there, the list names the stored key', () => {
      // What a clone on Linux sees is the list as written. Copy the store's
      // files to a case-sensitive-like check: the flag's name is the stored
      // file's name, so it opens that file on every filesystem.
      const stored = 'ops.start';
      const asked = `op${LONG_S}.start`;
      expect(rvr('set', stored, touch('start')).status).toBe(0);
      if (!opens(projectStore(), asked, stored)) return;
      expect(rvr('confirm', 'set', asked).status).toBe(0);
      for (const flag of projectFlags()) {
        expect(fs.readdirSync(projectStore())).toContain(`${flag}.json`);
      }
    });

    it('the exact key is kept when it is stored', () => {
      expect(rvr('set', 'ops.deploy', 'true').status).toBe(0);
      const r = rvr('confirm', 'set', 'ops.deploy');
      expect(r.stdout).toContain("Entry 'ops.deploy' now requires confirmation to run.");
      expect(r.stdout).not.toContain('as typed');
      expect(json('confirm', 'set', 'ops.deploy').result).toEqual({ key: 'ops.deploy', confirm: true });
    });

    it('an unreadable entry reached by another case is listed under its stored name', () => {
      expect(rvr('set', 'ops.deploy', 'true').status).toBe(0);
      fs.writeFileSync(path.join(projectStore(), 'ops.deploy.json'), '{\n<<<<<<< ours\n=======\n>>>>>>> theirs\n}\n');
      const r = rvr('confirm', 'set', 'OPS.deploy');
      if (!opens(projectStore(), 'OPS.deploy', 'ops.deploy')) {
        // A case-sensitive volume: the spelling opens nothing, and an
        // unreadable entry has no name to compare it with.
        expect(r.status).toBe(1);
        return;
      }
      expect(r.status).toBe(0);
      expect(projectFlags()).toEqual(['ops.deploy']);
    });
  });

  // ── #256: a global-only entry takes a global flag ────────────────────

  describe('an entry stored only in the global store takes a flag in the global list (#256)', () => {
    it('the repro: flagged in p1, renamed with -G from p2, still gated in p1', () => {
      expect(rvrIn('outside', 'set', '-G', 'ops.deploy', touch('deploy')).status).toBe(0);
      const set = rvrIn('p1', 'confirm', 'set', 'ops.deploy');
      expect(set.status).toBe(0);
      expect(set.stdout).toContain("Entry 'ops.deploy' now requires confirmation to run. It is stored only in the global store, so its flag is in the global list and applies in every project.");
      expect(rvrIn('p2', 'rename', '-G', 'ops.deploy', 'ops.ship').status).toBe(0);
      const r = rvrIn('p1', 'run', 'ops.ship');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(REFUSAL);
      expect(ran('deploy')).toBe(false);
      expect(jsonIn('p1', 'run', 'ops.ship').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(ran('deploy')).toBe(false);
    }, SLOW_TEST_MS);

    it('confirm set in a project, without -G: the global list, the project list untouched, and it gates in every project', () => {
      expect(rvrIn('outside', 'set', '-G', 'g.deploy', touch('g')).status).toBe(0);
      const env = json('confirm', 'set', 'g.deploy');
      expect(env.ok).toBe(true);
      expect(env.result).toEqual({ key: 'g.deploy', confirm: true, list: 'global' });
      expect(globalFlags()).toEqual(['g.deploy']);
      expect(projectFlags()).toEqual([]);
      for (const where of ['p1', 'p2', 'outside'] as const) {
        expect(rvrIn(where, 'run', ...(where === 'outside' ? ['-G'] : []), 'g.deploy').stderr, where).toContain(REFUSAL);
      }
      expect(ran('g')).toBe(false);
    }, SLOW_TEST_MS);

    it('the flag-only set --confirm: the same', () => {
      expect(rvrIn('outside', 'set', '-G', 'g.deploy', touch('g')).status).toBe(0);
      const r = rvr('set', 'g.deploy', '--confirm');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('stored only in the global store');
      expect(globalFlags()).toEqual(['g.deploy']);
      expect(projectFlags()).toEqual([]);
    });

    it('an entry in the project, alone or over a global one, takes the list asked for', () => {
      expect(rvr('set', 'p.deploy', 'true').status).toBe(0);
      expect(rvrIn('outside', 'set', '-G', 'both.deploy', 'true').status).toBe(0);
      expect(rvr('set', 'both.deploy', 'true').status).toBe(0);
      for (const key of ['p.deploy', 'both.deploy']) {
        const r = rvr('confirm', 'set', key);
        expect(r.status, key).toBe(0);
        expect(r.stdout, key).not.toContain('global');
      }
      expect(projectFlags()).toEqual(['both.deploy', 'p.deploy']);
      expect(globalFlags()).toEqual([]);
      // -G: the global list, for both, as before.
      for (const key of ['p.deploy', 'both.deploy']) expect(rvr('confirm', 'set', '-G', key).status, key).toBe(0);
      expect(globalFlags()).toEqual(['both.deploy', 'p.deploy']);
    });
  });

  // ── review of #256: a store this process cannot write ────────────────

  describe('a store this process cannot write (review of #256)', () => {
    /** Run `fn` with `paths` read-only, and put them back. */
    const readOnly = (paths: string[], fn: () => void) => {
      for (const p of paths) fs.chmodSync(p, 0o555);
      try {
        fn();
      } finally {
        for (const p of [...paths].reverse()) fs.chmodSync(p, 0o755);
      }
    };
    const noStack = (out: string) => expect(out).not.toMatch(/^\s+at |^\d+ \| /m);

    it('the global store cannot be written: a global-only entry is flagged in the project list, with a warning', () => {
      expect(rvrIn('outside', 'set', '-G', 'ops.deploy', touch('deploy')).status).toBe(0);
      readOnly([globalStore()], () => {
        const r = rvr('confirm', 'set', 'ops.deploy');
        noStack(r.stdout + r.stderr);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("Entry 'ops.deploy' now requires confirmation to run.");
        expect(r.stdout).toContain("The global store cannot be written, so the flag is in this project's list: it applies only in this project");
        expect(projectFlags()).toEqual(['ops.deploy']);
        expect(rvr('run', 'ops.deploy').stderr).toContain(REFUSAL);
        expect(ran('deploy')).toBe(false);
        // In JSON: the list it is in, and the warning.
        expect(rvr('confirm', 'remove', 'ops.deploy').status).toBe(0);
        const env = json('confirm', 'set', 'ops.deploy');
        expect(env.ok).toBe(true);
        expect(env.result).toEqual({ key: 'ops.deploy', confirm: true, list: 'project' });
        expect((env.warnings ?? []).map(w => w.message).join('\n')).toContain('The global store cannot be written');
        // The flag-only set the same way.
        expect(rvr('confirm', 'remove', 'ops.deploy').status).toBe(0);
        const viaSet = rvr('set', 'ops.deploy', '--confirm');
        expect(viaSet.status).toBe(0);
        expect(viaSet.stdout).toContain('The global store cannot be written');
        expect(projectFlags()).toEqual(['ops.deploy']);
      });
      expect(globalFlags()).toEqual([]);
    });

    it('... and with -G: refused in one line, nothing written', () => {
      expect(rvrIn('outside', 'set', '-G', 'ops.deploy', 'true').status).toBe(0);
      readOnly([globalStore()], () => {
        const r = rvr('confirm', 'set', '-G', 'ops.deploy');
        expect(r.status).toBe(1);
        noStack(r.stdout + r.stderr);
        expect(r.stderr).toContain("No flag was set on 'ops.deploy': the store cannot be written");
        expect(json('confirm', 'set', '-G', 'ops.deploy').error?.code).toBe('IO');
        expect(rvr('set', '-G', 'ops.deploy', '--confirm').status).toBe(1);
      });
      expect(globalFlags()).toEqual([]);
      expect(projectFlags()).toEqual([]);
    });

    it.each([
      ['no lock file', false],
      ['a stale lock left there', true],
    ])('a data directory that cannot be written, so neither can the global lock (%s): the project list, with the warning', (_name, staleLock) => {
      // The lock file sits beside the store directory: a read-only data
      // directory takes the lock with it. A stale one there cannot be
      // cleared, and waiting for it ended in a lock timeout, nothing written.
      expect(rvrIn('outside', 'set', '-G', 'ops.deploy', touch('deploy')).status).toBe(0);
      if (staleLock) {
        const lock = path.join(dataDir, 'store.lock');
        fs.writeFileSync(lock, '99999');
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, old, old);
      }
      readOnly([dataDir], () => {
        const r = rvr('confirm', 'set', 'ops.deploy');
        noStack(r.stdout + r.stderr);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('The global store cannot be written, so the flag is in this project\'s list');
        expect(projectFlags()).toEqual(['ops.deploy']);
        const run = rvr('run', 'ops.deploy');
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(REFUSAL);
        // With -G: refused in one line, nothing written.
        const viaG = rvr('confirm', 'set', '-G', 'ops.deploy');
        expect(viaG.status).toBe(1);
        noStack(viaG.stdout + viaG.stderr);
      });
      expect(ran('deploy')).toBe(false);
      expect(globalFlags()).toEqual([]);
    }, SLOW_TEST_MS);

    it.skipIf(process.platform !== 'darwin')('a global confirmation list that cannot be replaced (chflags uchg): the project list, with the warning', () => {
      expect(rvrIn('outside', 'set', '-G', 'ops.deploy', 'true').status).toBe(0);
      expect(rvrIn('outside', 'set', '-G', 'g.other', 'true').status).toBe(0);
      expect(rvrIn('outside', 'confirm', 'set', '-G', 'g.other').status).toBe(0);
      const list = path.join(globalStore(), '_confirm.json');
      expect(spawnSync('chflags', ['uchg', list]).status).toBe(0);
      try {
        const r = rvr('confirm', 'set', 'ops.deploy');
        noStack(r.stdout + r.stderr);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('The global store cannot be written');
        expect(projectFlags()).toEqual(['ops.deploy']);
      } finally {
        spawnSync('chflags', ['nouchg', list]);
      }
      expect(globalFlags()).toEqual(['g.other']);
    });

    it('an unreadable global list is not a fallback: STORE_UNREADABLE, nothing written', () => {
      expect(rvrIn('outside', 'set', '-G', 'ops.deploy', 'true').status).toBe(0);
      fs.writeFileSync(path.join(globalStore(), '_confirm.json'), '{\n<<<<<<< ours\n=======\n>>>>>>> theirs\n}\n');
      expect(json('confirm', 'set', 'ops.deploy').error?.code).toBe('STORE_UNREADABLE');
      expect(projectFlags()).toEqual([]);
    });

    it('a project this process cannot write: a global-only entry is still flagged, in the global list', () => {
      expect(rvrIn('outside', 'set', '-G', 'ops.deploy', touch('deploy')).status).toBe(0);
      expect(rvrIn('outside', 'set', '-G', 'ops.build', 'true').status).toBe(0);
      readOnly([dir('p1'), projectStore()], () => {
        const r = rvr('confirm', 'set', 'ops.deploy');
        noStack(r.stdout + r.stderr);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('stored only in the global store');
        // -G, and the flag-only set.
        expect(rvr('confirm', 'set', '-G', 'ops.build').status).toBe(0);
        expect(rvr('confirm', 'remove', '-G', 'ops.deploy').status).toBe(0);
        expect(rvr('set', 'ops.deploy', '--confirm').status).toBe(0);
        // Already listed: answered from the read, nothing opened for writing.
        expect(rvr('confirm', 'set', 'ops.deploy').status).toBe(0);
        expect(rvr('run', 'ops.deploy').stderr).toContain(REFUSAL);
      });
      expect(globalFlags()).toEqual(['ops.build', 'ops.deploy']);
      expect(projectFlags()).toEqual([]);
      expect(ran('deploy')).toBe(false);
    });

    it('-G lists the global store\'s spelling, though the project holds a fold of it (review F2)', () => {
      // On APFS `ops.start` opens the project's `opſ.start`. The global list
      // gets the name the global entry is stored as: the other gates nothing
      // where nothing folds.
      expect(rvrIn('outside', 'set', '-G', 'ops.start', 'echo G').status).toBe(0);
      expect(rvr('set', `op${LONG_S}.start`, 'echo P').status).toBe(0);
      expect(rvr('confirm', 'set', '-G', 'ops.start').status).toBe(0);
      expect(globalFlags()).toEqual(['ops.start']);
    });
  });

  // ── #257: the flag-only set looks the key up as confirm set does ─────

  describe('the flag-only set looks the key up as confirm set does (#257)', () => {
    it('set -G <project-only key> --confirm: accepted, listed globally', () => {
      expect(rvr('set', 'p.deploy', touch('p')).status).toBe(0);
      const r = rvr('set', '-G', 'p.deploy', '--confirm');
      expect(r.status).toBe(0);
      expect(globalFlags()).toEqual(['p.deploy']);
      expect(rvr('run', 'p.deploy').stderr).toContain(REFUSAL);
      expect(ran('p')).toBe(false);
    });

    it('set -G <project-only key> --no-confirm: accepted, clears the global flag', () => {
      expect(rvr('set', 'p.deploy', 'true').status).toBe(0);
      expect(rvr('confirm', 'set', '-G', 'p.deploy').status).toBe(0);
      const r = rvr('set', '-G', 'p.deploy', '--no-confirm');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Entry 'p.deploy' no longer requires confirmation to run.");
      expect(globalFlags()).toEqual([]);
    });

    it('a key in neither store is still refused, with -G as without', () => {
      for (const args of [['set', 'no.such', '--confirm'], ['set', '-G', 'no.such', '--confirm'], ['set', '-G', 'no.such', '--no-confirm']]) {
        expect(json(...args).error?.code, args.join(' ')).toBe('NOT_FOUND');
      }
    });
  });

  // ── #257: what confirm remove and --no-confirm say ───────────────────

  describe('what confirm remove says (#257)', () => {
    it('a name every object has is not a flag: constructor, toString', () => {
      expect(rvr('set', 'toString', 'true').status).toBe(0);
      for (const key of ['constructor', 'toString']) {
        const r = rvr('confirm', 'remove', key);
        expect(r.status, key).toBe(0);
        expect(r.stdout, key).toContain(`'${key}' did not require confirmation: no flag is listed for it.`);
        expect(r.stdout, key).not.toContain('Confirmation removed');
      }
      // A flag listed under such a name is removed.
      expect(rvr('confirm', 'set', 'toString').status).toBe(0);
      expect(rvr('confirm', 'remove', 'toString').stdout).toContain("Confirmation removed from 'toString'.");
      expect(projectFlags()).toEqual([]);
    });

    it('a name flagged in both lists: one message names both, and following it clears the key', () => {
      expect(rvr('set', 'ops.deploy', touch('deploy')).status).toBe(0);
      expect(rvr('confirm', 'set', 'ops.deploy').status).toBe(0);
      expect(rvr('confirm', 'set', '-G', 'ops.deploy').status).toBe(0);
      const r = rvr('confirm', 'remove', 'OPS.DEPLOY');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("it is flagged as 'ops.deploy' in the project list and 'ops.deploy' in the global list");
      expect(r.stderr).toContain('confirm remove ops.deploy`');
      expect(r.stderr).toContain('confirm remove -G ops.deploy`');
      // Following it, once each: the second call is the last.
      expect(rvr('confirm', 'remove', 'ops.deploy').status).toBe(0);
      const last = rvr('confirm', 'remove', '-G', 'ops.deploy');
      expect(last.status).toBe(0);
      expect(last.stdout).toContain("Confirmation removed from 'ops.deploy'.");
      expect(last.stdout).not.toContain('still requires');
      expect(rvr('run', 'ops.deploy').status).toBe(0);
      expect(ran('deploy')).toBe(true);
    });

    it('a confirm remove -G that removed a flag succeeds, and its audit row says so, though the project list still gates the key', () => {
      expect(rvr('set', 'ops.deploy', 'true').status).toBe(0);
      expect(rvr('confirm', 'set', 'ops.deploy').status).toBe(0);
      expect(rvr('confirm', 'set', '-G', 'ops.deploy').status).toBe(0);
      const env = json('confirm', 'remove', '-G', 'ops.deploy');
      expect(env.ok).toBe(true);
      expect(env.error).toBeUndefined();
      expect(env.result).toEqual({ key: 'ops.deploy', confirm: false, stillGated: true });
      expect((env.warnings ?? []).map(w => w.message).join('\n')).toContain("it is flagged as 'ops.deploy' in the project list");
      expect(globalFlags()).toEqual([]);
      const rows = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { tool: string; success: boolean });
      const row = rows.filter(r => r.tool === 'reverie_confirm_remove').pop();
      expect(row?.success).toBe(true);
    });

    it('with the global list unreadable: it does not say "no flag", and run stays closed', () => {
      expect(rvr('set', 'ops.deploy', touch('deploy')).status).toBe(0);
      expect(rvr('set', 'ops.other', 'true').status).toBe(0);
      expect(rvr('confirm', 'set', 'ops.other').status).toBe(0);
      expect(rvrIn('outside', 'set', '-G', 'g.k', 'true').status).toBe(0);
      fs.writeFileSync(path.join(globalStore(), '_confirm.json'), '{\n<<<<<<< ours\n=======\n>>>>>>> theirs\n}\n');
      // Nothing listed in the project for it: refused, the reason given.
      const r = rvr('confirm', 'remove', 'ops.deploy');
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain('no flag is listed');
      expect(r.stderr).toContain("'ops.deploy' may still require confirmation: the global store's confirmation list cannot be read");
      expect(json('confirm', 'remove', 'ops.deploy').error?.code).toBe('STORE_UNREADABLE');
      // A flag it did remove: removed, and the same caution as a warning.
      const removed = rvr('confirm', 'remove', 'ops.other');
      expect(removed.status).toBe(0);
      expect(removed.stdout).toContain("Confirmation removed from 'ops.other'.");
      expect(removed.stdout).toContain("'ops.other' may still require confirmation: the global store's confirmation list cannot be read");
      expect(json('run', 'ops.deploy').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(ran('deploy')).toBe(false);
    });
  });

  it('set <key> <value> --no-confirm on a key that stays gated: the result says so (review F4)', () => {
    expect(rvr('set', 'ops.deploy', 'true').status).toBe(0);
    expect(rvr('confirm', 'set', '-G', 'ops.deploy').status).toBe(0);
    const env = json('set', 'ops.deploy', 'echo new', '--no-confirm');
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ key: 'ops.deploy', confirm: false, stillGated: true });
    expect(json('set', 'ops.other', 'v', '--no-confirm').result).toEqual({ key: 'ops.other', confirm: false });
  });

  describe('set --no-confirm -a says what it did (#257)', () => {
    it('nothing to clear under the name and still gated: refused, and the alias is not written', () => {
      expect(rvr('set', 'ops.deploy', 'true').status).toBe(0);
      expect(rvr('confirm', 'set', '-G', 'ops.deploy').status).toBe(0);
      const env = json('set', 'ops.deploy', '--no-confirm', '-a', 'dpa');
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('INVALID_INPUT');
      expect(aliasesIn(projectStore())).toEqual({});
      expect(globalFlags()).toEqual(['ops.deploy']);
    });

    it('a flag cleared and the alias set, though another list still gates the key: ok, with a result and a warning', () => {
      expect(rvr('set', 'ops.deploy', 'true').status).toBe(0);
      expect(rvr('confirm', 'set', 'ops.deploy').status).toBe(0);
      expect(rvr('confirm', 'set', '-G', 'ops.deploy').status).toBe(0);
      const env = json('set', 'ops.deploy', '--no-confirm', '-a', 'dpa');
      expect(env.ok).toBe(true);
      expect(env.result).toEqual({ key: 'ops.deploy', confirm: false, alias: 'dpa', stillGated: true });
      expect((env.warnings ?? []).map(w => w.message).join('\n')).toContain("it is flagged as 'ops.deploy' in the global list");
      expect(aliasesIn(projectStore())).toEqual({ dpa: 'ops.deploy' });
      expect(projectFlags()).toEqual([]);
    });

    it('an alias that cannot be stored: nothing written, the flag stays', () => {
      expect(rvr('set', 'ops.deploy', 'true').status).toBe(0);
      expect(rvr('confirm', 'set', 'ops.deploy').status).toBe(0);
      const env = json('set', 'ops.deploy', '--no-confirm', '-a', '_bad');
      expect(env.ok).toBe(false);
      expect(projectFlags()).toEqual(['ops.deploy']);
      expect(aliasesIn(projectStore())).toEqual({});
    });
  });
});
