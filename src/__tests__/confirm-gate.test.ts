// The confirmation gate follows the entry.
//
// A confirm flag is a tripwire in front of `run`. It came loose from the entry
// it was set on in three ways, each one reporting success:
//
//   1. Another spelling. A key maps to its filename, and a filesystem that
//      folds names opened the entry's file for a key that is not stored:
//      another case on default macOS and Windows volumes, and on APFS other
//      Unicode forms too (`ſ` for `s`, NFD for NFC). The flagged command ran
//      unconfirmed under that spelling — given to `run`, in a ${reference} or
//      $(exec ref) in another entry, or behind an alias. A read is now
//      answered only by the key as stored.
//      The reverse: a flag listed in another case than the entry (which
//      `confirm set` used to accept) gated nothing. Asking whether a key is
//      flagged now ignores case.
//   2. `confirm set` did not look the key up. A typo, a namespace or another
//      spelling reported "now requires confirmation" and gated nothing.
//   3. Renaming a namespace moved the entries and left their flags behind.
//
// And the rule that keeps the fix from opening the same hole elsewhere:
// nothing takes a flag off an entry that is still there.
//
// Spawns the built dist/index.js (assumes `bun run build` has run) against a
// project store and a global store in temp directories. Nothing here depends
// on what the filesystem folds: where a spelling would not open the entry's
// file anyway, the assertions still hold.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';
import { readDirectoryStore } from './helpers/readStoreState';

interface Envelope {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

describe('the confirmation gate follows the entry', () => {
  const cli = path.resolve('dist/index.js');
  const REFUSAL = 'Entry requires confirmation';
  // For the tests that spawn the CLI a few dozen times; the default is 5s.
  const SLOW_TEST_MS = 30_000;
  let dataDir: string;
  let projectDir: string;

  // stdin is an empty pipe: not a TTY, so a gated run refuses instead of
  // prompting, and a run that gets past the gate leaves its marker.
  const rvrIn = (cwd: string, ...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir };
    delete e.RVR_SESSION;
    delete e.RVR_NO_PROJECT;
    delete e.RVR_PROJECT;
    const r = spawnSync('bun', [cli, ...args], { cwd, env: e as NodeJS.ProcessEnv, input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const rvr = (...args: string[]) => rvrIn(projectDir, ...args);
  const json = (...args: string[]): Envelope => JSON.parse(rvr('--json', ...args).stdout) as Envelope;
  // Each command leaves a file behind when it runs. A refusal prints the
  // command it refused, so the command's own text on stdout proves nothing.
  const marker = (name: string) => path.join(projectDir, `ran-${name}`);
  const touch = (name: string) => `touch ${marker(name)}`;
  const ran = (name: string) => fs.existsSync(marker(name));
  const projectFlags = () => Object.keys(readDirectoryStore(path.join(projectDir, '.reverie')).confirm).sort();
  const globalFlags = () => Object.keys(readDirectoryStore(path.join(dataDir, 'store')).confirm).sort();
  const projectKeys = () => fs.readdirSync(path.join(projectDir, '.reverie'))
    .filter(f => f.endsWith('.json') && !f.startsWith('_')).map(f => f.slice(0, -'.json'.length)).sort();
  /** Put flags in the project list exactly as spelled — the state a store written by 1.3.0 or earlier can be in. */
  const listFlags = (...keys: string[]) => {
    const file = path.join(dataDir, 'flags.json');
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(keys.map(k => [k, true]))));
    expect(rvr('data', 'import', 'confirm', file, '--force').status).toBe(0);
  };
  /** Refused or not found, but never run: what every other spelling of a flagged key must get. */
  const expectNotRun = (name: string, ...args: string[]) => {
    const label = args.join(' ');
    expect(rvr(...args).status, label).toBe(1);
    expect(json(...args).ok, label).toBe(false);
    expect(ran(name), label).toBe(false);
  };

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-gate-data-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-gate-proj-'));
    expect(rvr('init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    expect(rvr('set', 'commands.deploy', touch('deploy'), '--confirm').status).toBe(0);
    expect(rvr('set', 'commands.status', touch('status')).status).toBe(0);
    expect(projectFlags()).toEqual(['commands.deploy']);
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('baseline: the flagged entry is refused without --yes, and an unflagged one runs', () => {
    const gated = rvr('run', 'commands.deploy');
    expect(gated.status).toBe(1);
    expect(gated.stderr).toContain(REFUSAL);
    expect(ran('deploy')).toBe(false);
    expect(rvr('run', 'commands.status').status).toBe(0);
    expect(ran('status')).toBe(true);
    expect(rvr('run', 'commands.deploy', '--yes').status).toBe(0);
    expect(ran('deploy')).toBe(true);
  });

  // ── 1. another spelling of the key ───────────────────────────────────

  describe('a key spelled another way', () => {
    // Case; a letter the filesystem folds and toLowerCase does not (U+017F
    // LONG S for the `s` of `commands`); and both together.
    const spellings = ['commands.DEPLOY', 'Commands.Deploy', 'commandſ.deploy', 'COMMANDſ.deploy'];

    it('is not a stored key: get and run say NOT_FOUND', () => {
      for (const key of spellings) {
        expect(json('get', key).error?.code, key).toBe('NOT_FOUND');
        expect(json('run', key).error?.code, key).toBe('NOT_FOUND');
        expect(json('run', key, '--yes').error?.code, key).toBe('NOT_FOUND');
      }
      expect(ran('deploy')).toBe(false);
    });

    it('run: never executes the flagged command, however the spelling reaches it', () => {
      // One spelling of each kind: about seventeen spawns apiece.
      for (const key of ['commands.DEPLOY', 'command\u017f.deploy']) {
        expectNotRun('deploy', 'run', key);
        // A ${reference} and a $(exec ref) from an unflagged entry.
        expect(rvr('set', 'x.ref', '${' + key + '} && ' + touch('ref')).status).toBe(0);
        expectNotRun('deploy', 'run', 'x.ref');
        expect(rvr('set', 'x.exec', 'echo $(' + key + ') && ' + touch('exec')).status).toBe(0);
        expectNotRun('deploy', 'run', 'x.exec');
        // An alias, a chain, and `:` composition.
        expect(rvr('alias', 'set', 'dp', key).status).toBe(0);
        expectNotRun('deploy', 'run', 'dp');
        expect(rvr('set', 'x.chain', key).status).toBe(0);
        expectNotRun('deploy', 'run', '--chain', 'x.chain');
        expect(rvr('set', 'x.pre', 'true &&').status).toBe(0);
        expectNotRun('deploy', 'run', `x.pre:${key}`);
      }
      expect(ran('ref')).toBe(false);
      expect(ran('exec')).toBe(false);
    }, SLOW_TEST_MS);

    it('a key stored in one Unicode form is not answered by the other', () => {
      const nfc = 'café.go';
      const nfd = 'café.go';
      expect(rvr('set', nfc, touch('cafe'), '--confirm').status).toBe(0);
      expect(json('get', nfc).ok).toBe(true);
      expect(json('get', nfd).error?.code).toBe('NOT_FOUND');
      expectNotRun('cafe', 'run', nfd);
      expect(rvr('run', nfc).stderr).toContain(REFUSAL);
      expect(ran('cafe')).toBe(false);
    });

    it('rename: is refused as a source, and nothing is copied or unflagged', () => {
      // The read used to succeed and the removal — exact — to do nothing: a
      // "rename" that left the entry where it was and made a copy.
      for (const key of spellings) {
        const r = rvr('rename', key, 'tmp.x');
        expect(r.status, key).toBe(1);
        expect(json('rename', key, 'tmp.x').error?.code, key).toBe('NOT_FOUND');
      }
      expect(projectKeys()).not.toContain('tmp.x');
      expect(projectFlags()).toEqual(['commands.deploy']);
      expect(rvr('run', 'commands.deploy').stderr).toContain(REFUSAL);
      expect(ran('deploy')).toBe(false);
    });
  });

  // ── the reverse: a flag listed in another case than the entry ────────

  describe('a flag listed in another case than the entry', () => {
    beforeEach(() => {
      listFlags('commands.DEPLOY', 'Commands.Status');
      expect(projectFlags()).toEqual(['Commands.Status', 'commands.DEPLOY']);
    });

    it('run: gates the entry, in text and in JSON', () => {
      const r = rvr('run', 'commands.deploy');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(REFUSAL);
      expect(json('run', 'commands.deploy').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(json('run', 'commands.status').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(ran('deploy')).toBe(false);
      expect(ran('status')).toBe(false);
    });

    it('run: gates an entry that reaches it through a reference', () => {
      expect(rvr('set', 'commands.wrapper', '${commands.deploy} && ' + touch('wrapper')).status).toBe(0);
      const r = rvr('run', 'commands.wrapper');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(REFUSAL);
      expect(ran('deploy')).toBe(false);
      expect(ran('wrapper')).toBe(false);
    });

    it('run --yes still runs it: the gate asks, it does not forbid', () => {
      expect(rvr('run', 'commands.deploy', '--yes').status).toBe(0);
      expect(ran('deploy')).toBe(true);
    });

    it('get -v: the listing marks the entry as gated', () => {
      const listing = rvr('get', 'commands', '-v').stdout;
      expect(listing).toMatch(/commands\.deploy \[confirm\]/);
      expect(listing).toMatch(/commands\.status \[confirm\]/);
    });

    it('confirm remove: the user named the key, so the flag goes whichever way it is spelled', () => {
      expect(rvr('confirm', 'remove', 'commands.deploy').status).toBe(0);
      expect(projectFlags()).toEqual(['Commands.Status']);
      expect(rvr('run', 'commands.deploy').status).toBe(0);
      expect(ran('deploy')).toBe(true);
    });

    it('set --no-confirm does the same', () => {
      expect(rvr('set', 'commands.deploy', '--no-confirm').status).toBe(0);
      expect(projectFlags()).toEqual(['Commands.Status']);
    });

    it('rename: the new key is flagged', () => {
      expect(rvr('rename', 'commands.deploy', 'commands.ship').status).toBe(0);
      expect(projectFlags()).toContain('commands.ship');
      expect(rvr('run', 'commands.ship').stderr).toContain(REFUSAL);
      expect(ran('deploy')).toBe(false);
    });
  });

  // ── 2. what a flag can be set on ─────────────────────────────────────

  describe('confirm set', () => {
    it('sets the flag on an entry', () => {
      const r = rvr('confirm', 'set', 'commands.status');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Entry 'commands.status' now requires confirmation to run.");
      expect(projectFlags()).toEqual(['commands.deploy', 'commands.status']);
      expect(json('confirm', 'set', 'commands.status').result).toEqual({ key: 'commands.status', confirm: true });
    });

    it('resolves an alias to the entry it names', () => {
      expect(rvr('alias', 'set', 'st', 'commands.status').status).toBe(0);
      expect(rvr('confirm', 'set', 'st').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.deploy', 'commands.status']);
    });

    it('refuses a key that is not in the store, and lists nothing', () => {
      const r = rvr('confirm', 'set', 'commands.statsu');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Entry 'commands.statsu' not found.");
      expect(r.stdout).not.toContain('now requires confirmation');
      expect(json('confirm', 'set', 'commands.statsu').error?.code).toBe('NOT_FOUND');
      expect(projectFlags()).toEqual(['commands.deploy']);
    });

    it('refuses another spelling of an entry, and names the stored key when only the case differs', () => {
      const r = rvr('confirm', 'set', 'commands.STATUS');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Entry 'commands.STATUS' not found. The stored key is 'commands.status'");
      expect(json('confirm', 'set', 'commands.STATUS').error?.code).toBe('NOT_FOUND');
      expect(json('confirm', 'set', 'commandſ.status').error?.code).toBe('NOT_FOUND');
      expect(projectFlags()).toEqual(['commands.deploy']);
    });

    it('refuses another spelling of a global entry too, when the project has entries in that namespace', () => {
      // The default view replaces the global `gcmds` namespace with the
      // project's, which hid the stored key from this check.
      expect(rvr('set', '-G', 'gcmds.deploy', touch('gdeploy')).status).toBe(0);
      expect(rvr('set', 'gcmds.build', 'true').status).toBe(0);
      const r = rvr('confirm', 'set', 'gcmds.DEPLOY');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("The stored key is 'gcmds.deploy'");
      expect(json('set', 'gcmds.DEPLOY', '--confirm').error?.code).toBe('NOT_FOUND');
      expect(projectFlags()).toEqual(['commands.deploy']);
      expect(globalFlags()).toEqual([]);
    });

    it('refuses a namespace: run never takes one, so the flag would gate nothing', () => {
      const r = rvr('confirm', 'set', 'commands');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("'commands' is a namespace, not an entry.");
      expect(json('confirm', 'set', 'commands').error?.code).toBe('INVALID_INPUT');
      expect(projectFlags()).toEqual(['commands.deploy']);
    });
  });

  describe('set <key> --confirm / --no-confirm with no value', () => {
    it('sets and clears the flag on an entry', () => {
      expect(rvr('set', 'commands.status', '--confirm').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.deploy', 'commands.status']);
      expect(rvr('set', 'commands.status', '--no-confirm').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.deploy']);
    });

    it('--confirm refuses another spelling, a namespace and a missing key', () => {
      const cases: [string, string, string][] = [
        ['commands.STATUS', 'NOT_FOUND', "The stored key is 'commands.status'"],
        ['commands', 'INVALID_INPUT', 'is a namespace, not an entry'],
        ['commands.statsu', 'NOT_FOUND', 'Cannot update confirm on a non-existent entry'],
      ];
      for (const [key, code, text] of cases) {
        const r = rvr('set', key, '--confirm');
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(text);
        expect(json('set', key, '--confirm').error?.code).toBe(code);
      }
      expect(projectFlags()).toEqual(['commands.deploy']);
    });

    it('--no-confirm under another spelling is refused, and the entry stays gated', () => {
      const r = rvr('set', 'commands.DEPLOY', '--no-confirm');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("The stored key is 'commands.deploy'");
      expect(projectFlags()).toEqual(['commands.deploy']);
      expect(rvr('run', 'commands.deploy').stderr).toContain(REFUSAL);
      expect(ran('deploy')).toBe(false);
    });

    it('--no-confirm still clears a flag an older version put on a namespace', () => {
      listFlags('commands');
      const r = rvr('set', 'commands', '--no-confirm');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Entry 'commands' no longer requires confirmation to run.");
      expect(projectFlags()).toEqual([]);
    });
  });

  // ── 3. rename ────────────────────────────────────────────────────────

  describe('rename', () => {
    it('a renamed namespace keeps the flags of the entries under it', () => {
      expect(rvr('set', 'commands.db.wipe', touch('wipe'), '--confirm').status).toBe(0);
      const r = rvr('rename', 'commands', 'jobs');
      expect(r.status).toBe(0);
      expect(projectFlags()).toEqual(['jobs.db.wipe', 'jobs.deploy']);
      for (const key of ['jobs.deploy', 'jobs.db.wipe']) {
        const gated = rvr('run', key);
        expect(gated.status).toBe(1);
        expect(gated.stderr).toContain(REFUSAL);
      }
      expect(ran('deploy')).toBe(false);
      expect(ran('wipe')).toBe(false);
      // The unflagged entry that moved with them is still unflagged.
      expect(rvr('run', 'jobs.status').status).toBe(0);
      expect(ran('status')).toBe(true);
    });

    it('a renamed entry keeps its flag, and a key sharing its prefix is untouched', () => {
      expect(rvr('set', 'commands.deploy2', touch('two'), '--confirm').status).toBe(0);
      expect(rvr('rename', 'commands.deploy', 'commands.ship').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.deploy2', 'commands.ship']);
    });

    it('a renamed entry with no flag gains none', () => {
      expect(rvr('rename', 'commands.status', 'commands.state').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.deploy']);
      expect(rvr('run', 'commands.state').status).toBe(0);
      expect(ran('status')).toBe(true);
    });
  });

  // ── nothing takes a flag off an entry that is still there ────────────

  describe('an entry that was not removed or renamed keeps its flag', () => {
    it('in a namespace spelled in another case: removing or renaming the other namespace', () => {
      // `ops.*` and `OPS.*` are two namespaces, and no two of these keys
      // collide. A cascade that ignored case took OPS.deploy's flag.
      for (const verb of [['remove', 'ops', '--force'], ['rename', 'ops', 'jobs']]) {
        expect(rvr('set', 'ops.build', 'true').status).toBe(0);
        expect(rvr('set', 'OPS.deploy', touch('OPS'), '--confirm').status).toBe(0);
        expect(rvr(...verb).status, verb.join(' ')).toBe(0);
        expect(projectFlags(), verb.join(' ')).toEqual(['OPS.deploy', 'commands.deploy']);
        const r = rvr('run', 'OPS.deploy');
        expect(r.status, verb.join(' ')).toBe(1);
        expect(r.stderr).toContain(REFUSAL);
        expect(ran('OPS')).toBe(false);
        expect(rvr('remove', 'OPS.deploy', '--force').status).toBe(0);
        rvr('remove', 'jobs', '--force');
      }
    }, SLOW_TEST_MS);

    it('a global entry: renaming the project namespace of the same name', () => {
      // The flag for the global entry sits in the project list. The rename
      // moved gops.a and nothing else.
      expect(rvr('set', '-G', 'gops.deploy', touch('gdeploy')).status).toBe(0);
      expect(rvr('set', 'gops.a', 'true').status).toBe(0);
      expect(rvr('confirm', 'set', 'gops.deploy').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.deploy', 'gops.deploy']);
      expect(rvr('rename', 'gops', 'gjobs').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.deploy', 'gops.deploy']);
      const r = rvr('run', 'gops.deploy');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(REFUSAL);
      expect(ran('gdeploy')).toBe(false);
    });

    it('a flag in the global list is not copied to a key that does not exist', () => {
      expect(rvr('set', '-G', 'gops.x', touch('gx'), '--confirm').status).toBe(0);
      expect(globalFlags()).toEqual(['gops.x']);
      expect(rvr('set', 'gops.a', 'true').status).toBe(0);
      expect(rvr('rename', 'gops', 'gjobs').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.deploy']);
      expect(globalFlags()).toEqual(['gops.x']);
    });

    it('a global entry renamed from inside a project: the copy is flagged and the original stays gated', () => {
      // The default scope writes to the project, so this "rename" leaves the
      // global entry where it was. It was gated, and it still reads.
      expect(rvr('set', '-G', 'gcmd.deploy', touch('gdeploy')).status).toBe(0);
      expect(rvr('confirm', 'set', 'gcmd.deploy').status).toBe(0);
      expect(rvr('rename', 'gcmd.deploy', 'moved.deploy').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.deploy', 'gcmd.deploy', 'moved.deploy']);
      for (const key of ['gcmd.deploy', 'moved.deploy']) {
        const r = rvr('run', key);
        expect(r.status, key).toBe(1);
        expect(r.stderr, key).toContain(REFUSAL);
      }
      expect(ran('gdeploy')).toBe(false);
    });

    it('remove: a flag spelled another way than the removed entry stays in the list', () => {
      // It is not this entry's name, and it may be another entry's.
      listFlags('commands.DEPLOY');
      expect(rvr('remove', 'commands.deploy', '--force').status).toBe(0);
      expect(projectFlags()).toEqual(['commands.DEPLOY']);
      // Clearing it is one command, under either spelling.
      expect(rvr('confirm', 'remove', 'commands.deploy').status).toBe(0);
      expect(projectFlags()).toEqual([]);
    });
  });
});
