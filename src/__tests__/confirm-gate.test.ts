// The confirmation gate follows the entry.
//
// A confirm flag is a tripwire in front of `run`. Three ways it used to come
// loose from the entry it was set on, each one reporting success:
//
//   1. Case. Keys compare without case (#216), and on a case-insensitive
//      filesystem (default macOS, Windows) `commands.Deploy` reads the file of
//      `commands.deploy`. The list matched the exact spelling only, so the
//      flagged command ran unconfirmed under any other spelling — as the key
//      given to `run`, as a ${reference} in another entry, or behind an alias.
//      The same in reverse: a flag listed in another case than the entry gated
//      nothing.
//   2. `confirm set` did not look the key up. A typo, a namespace or another
//      spelling reported "now requires confirmation" and gated nothing.
//   3. Renaming a namespace moved the entries and left their flags behind.
//
// Spawns the built dist/index.js (assumes `bun run build` has run) against a
// project store in a temp directory. Nothing here depends on the filesystem's
// case sensitivity: where a spelling cannot be read at all, the assertion is
// that the command did not run.

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
  let dataDir: string;
  let projectDir: string;

  // stdin is an empty pipe: not a TTY, so a gated run refuses instead of
  // prompting, and a run that gets past the gate shows as output.
  const rvr = (...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir };
    delete e.RVR_SESSION;
    delete e.RVR_NO_PROJECT;
    delete e.RVR_PROJECT;
    const r = spawnSync('bun', [cli, ...args], { cwd: projectDir, env: e as NodeJS.ProcessEnv, input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const json = (...args: string[]): Envelope => JSON.parse(rvr('--json', ...args).stdout) as Envelope;
  // Each command leaves a file behind when it runs. A refusal prints the
  // command it refused, so the command's own text on stdout proves nothing.
  const marker = (name: string) => path.join(projectDir, `ran-${name}`);
  const touch = (name: string) => `touch ${marker(name)}`;
  const ran = (name: string) => fs.existsSync(marker(name));
  const confirmList = () => Object.keys(readDirectoryStore(path.join(projectDir, '.reverie')).confirm).sort();
  /** Put flags in the list exactly as spelled — the state a store written by 1.3.0 or earlier can be in. */
  const listFlags = (...keys: string[]) => {
    const file = path.join(dataDir, 'flags.json');
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(keys.map(k => [k, true]))));
    expect(rvr('data', 'import', 'confirm', file, '--force').status).toBe(0);
  };

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-gate-data-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-gate-proj-'));
    expect(rvr('init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    expect(rvr('set', 'commands.deploy', touch('deploy'), '--confirm').status).toBe(0);
    expect(rvr('set', 'commands.status', touch('status')).status).toBe(0);
    expect(confirmList()).toEqual(['commands.deploy']);
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

  // ── 1. case ──────────────────────────────────────────────────────────

  describe('a key spelled in another case', () => {
    it('run: never executes the flagged command', () => {
      // Case-insensitive filesystem: the spelling reads the entry, and the
      // gate must hold. Case-sensitive: the spelling names nothing. Either
      // way the command does not run.
      for (const key of ['commands.DEPLOY', 'Commands.Deploy']) {
        expect(rvr('run', key).status).toBe(1);
        const env = json('run', key);
        expect(env.ok).toBe(false);
        expect(['REQUIRES_CONFIRMATION', 'NOT_FOUND']).toContain(env.error?.code);
        expect(ran('deploy')).toBe(false);
      }
    });

    it('run: a reference to it from an unflagged entry does not carry the command past the gate', () => {
      expect(rvr('set', 'commands.wrapper', '${commands.DEPLOY} && ' + touch('wrapper')).status).toBe(0);
      expect(rvr('run', 'commands.wrapper').status).toBe(1);
      expect(ran('deploy')).toBe(false);
      expect(ran('wrapper')).toBe(false);
    });

    it('run: an alias pointing at it does not either', () => {
      expect(rvr('alias', 'set', 'dp', 'commands.DEPLOY').status).toBe(0);
      expect(rvr('run', 'dp').status).toBe(1);
      expect(ran('deploy')).toBe(false);
    });
  });

  describe('a flag listed in another case than the entry', () => {
    beforeEach(() => {
      listFlags('commands.DEPLOY', 'Commands.Status');
      expect(confirmList()).toEqual(['Commands.Status', 'commands.DEPLOY']);
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

    it('confirm remove: clears the flag whichever way the key is spelled', () => {
      expect(rvr('confirm', 'remove', 'commands.deploy').status).toBe(0);
      expect(confirmList()).toEqual(['Commands.Status']);
      expect(rvr('run', 'commands.deploy').status).toBe(0);
      expect(ran('deploy')).toBe(true);
    });

    it('confirm set: lists the entry once, under its own spelling', () => {
      expect(rvr('confirm', 'set', 'commands.deploy').status).toBe(0);
      expect(confirmList()).toEqual(['Commands.Status', 'commands.deploy']);
    });

    it('remove: takes the flag with the entry', () => {
      expect(rvr('remove', 'commands.deploy', '--force').status).toBe(0);
      expect(confirmList()).toEqual(['Commands.Status']);
    });

    it('rename: carries the flag to the new key', () => {
      expect(rvr('rename', 'commands.deploy', 'commands.ship').status).toBe(0);
      expect(confirmList()).toEqual(['Commands.Status', 'commands.ship']);
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
      expect(confirmList()).toEqual(['commands.deploy', 'commands.status']);
      expect(json('confirm', 'set', 'commands.status').result).toEqual({ key: 'commands.status', confirm: true });
    });

    it('resolves an alias to the entry it names', () => {
      expect(rvr('alias', 'set', 'st', 'commands.status').status).toBe(0);
      expect(rvr('confirm', 'set', 'st').status).toBe(0);
      expect(confirmList()).toEqual(['commands.deploy', 'commands.status']);
    });

    it('refuses a key that is not in the store, and lists nothing', () => {
      const r = rvr('confirm', 'set', 'commands.statsu');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Entry 'commands.statsu' not found.");
      expect(r.stdout).not.toContain('now requires confirmation');
      expect(json('confirm', 'set', 'commands.statsu').error?.code).toBe('NOT_FOUND');
      expect(confirmList()).toEqual(['commands.deploy']);
    });

    it('refuses another spelling of an entry, and names the stored key', () => {
      const r = rvr('confirm', 'set', 'commands.STATUS');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Entry 'commands.STATUS' not found. The stored key is 'commands.status'");
      expect(json('confirm', 'set', 'commands.STATUS').error?.code).toBe('NOT_FOUND');
      expect(confirmList()).toEqual(['commands.deploy']);
    });

    it('refuses a namespace: run never takes one, so the flag would gate nothing', () => {
      const r = rvr('confirm', 'set', 'commands');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("'commands' is a namespace, not an entry.");
      expect(json('confirm', 'set', 'commands').error?.code).toBe('INVALID_INPUT');
      expect(confirmList()).toEqual(['commands.deploy']);
    });
  });

  describe('set <key> --confirm / --no-confirm with no value', () => {
    it('sets and clears the flag on an entry', () => {
      expect(rvr('set', 'commands.status', '--confirm').status).toBe(0);
      expect(confirmList()).toEqual(['commands.deploy', 'commands.status']);
      expect(rvr('set', 'commands.status', '--no-confirm').status).toBe(0);
      expect(confirmList()).toEqual(['commands.deploy']);
    });

    it('refuses another spelling, a namespace and a missing key', () => {
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
      expect(confirmList()).toEqual(['commands.deploy']);
    });

    it('--no-confirm under another spelling is refused, and the entry stays gated', () => {
      const r = rvr('set', 'commands.DEPLOY', '--no-confirm');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("The stored key is 'commands.deploy'");
      expect(confirmList()).toEqual(['commands.deploy']);
      expect(rvr('run', 'commands.deploy').stderr).toContain(REFUSAL);
      expect(ran('deploy')).toBe(false);
    });
  });

  // ── 3. rename ────────────────────────────────────────────────────────

  describe('rename', () => {
    it('a renamed namespace keeps the flags of the entries under it', () => {
      expect(rvr('set', 'commands.db.wipe', touch('wipe'), '--confirm').status).toBe(0);
      const r = rvr('rename', 'commands', 'jobs');
      expect(r.status).toBe(0);
      expect(confirmList()).toEqual(['jobs.db.wipe', 'jobs.deploy']);
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

    it('a renamed entry keeps its flag, and a namespace sharing its prefix is untouched', () => {
      expect(rvr('set', 'commands.deploy2', touch('two'), '--confirm').status).toBe(0);
      expect(rvr('rename', 'commands.deploy', 'commands.ship').status).toBe(0);
      expect(confirmList()).toEqual(['commands.deploy2', 'commands.ship']);
    });

    it('a renamed entry with no flag gains none', () => {
      expect(rvr('rename', 'commands.status', 'commands.state').status).toBe(0);
      expect(confirmList()).toEqual(['commands.deploy']);
      expect(rvr('run', 'commands.state').status).toBe(0);
      expect(ran('status')).toBe(true);
    });
  });
});
