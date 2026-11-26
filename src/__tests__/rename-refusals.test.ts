// Two refusals a rename gained with #259, both writing nothing.
//
// #247 — the source spelled another way than the stored key. A key maps to
// its filename, and a filesystem that folds names opens the entry's file for
// another case, or (APFS) for `ſ` in place of `s`. The removal is by name, so
// such a rename copied the entry, left the original, and reported it renamed.
// Which spellings fold is the filesystem's rule: each case asks the temp
// dir's filesystem first. Where the spelling opens the stored file the rename
// is refused, naming the stored key; where it does not, it is not found.
//
// #245 — a confirmation list that cannot be read. A rename flags the new key
// of every gated entry it moves, from either store's list. With the other
// store's list broken it went ahead without its flags, and once the list was
// repaired the renamed command ran unconfirmed.
//
// Spawns the built dist/index.js against temp stores.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

const LONG_S = String.fromCodePoint(0x17f);

describe('rename refusals that write nothing (#247, #245)', () => {
  const cli = path.resolve('dist/index.js');
  let dataDir: string;
  let projectDir: string;
  const globalStore = () => path.join(dataDir, 'store');
  const projectStore = () => path.join(projectDir, '.reverie');

  const rvrIn = (cwd: string, ...args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir };
    delete env.RVR_SESSION;
    delete env.RVR_NO_PROJECT;
    delete env.RVR_PROJECT;
    delete env.RVR_OUTPUT;
    const r = spawnSync('bun', [cli, ...args], { cwd, env: env as NodeJS.ProcessEnv, input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const rvr = (...args: string[]) => rvrIn(projectDir, ...args);
  const json = (...args: string[]): Envelope => JSON.parse(rvr('--json', ...args).stdout) as Envelope;
  /** Entry files and the confirmation list of a store directory, as one comparable string. */
  const snapshot = (dir: string): string => fs.readdirSync(dir).sort()
    .filter(f => f.endsWith('.json') && f !== '_epoch.json')
    .map(f => `${f}=${fs.readFileSync(path.join(dir, f), 'utf8')}`).join('\n');
  /** Does the store's filesystem open `stored`'s entry file for `asked`? */
  const folds = (dir: string, asked: string, stored: string) => {
    const a = path.join(dir, `${asked}.json`);
    const s = path.join(dir, `${stored}.json`);
    return fs.existsSync(a) && fs.existsSync(s) && fs.statSync(a).ino === fs.statSync(s).ino;
  };

  beforeAll(() => { assertDistHonorsDataDir(); });
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-rename-data-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-rename-proj-'));
    expect(rvr('init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe('#247: the source spelled another way', () => {
    const spellings = ['Commands.Deploy', 'commands.DEPLOY', `command${LONG_S}.deploy`, `COMMAND${LONG_S}.DEPLOY`];

    it('is refused, naming the stored key, where the spelling opens the entry; not found where it does not', () => {
      expect(rvr('set', '-G', 'commands.deploy', 'true', '--confirm').status).toBe(0);
      const before = snapshot(globalStore());
      for (const asked of spellings) {
        const text = rvr('rename', '-G', asked, 'ops.deploy');
        const env = json('rename', '-G', asked, 'ops.deploy');
        expect(text.status, asked).toBe(1);
        expect(env.ok, asked).toBe(false);
        if (folds(globalStore(), asked, 'commands.deploy')) {
          expect(text.stderr, asked).toContain(`Cannot rename '${asked}': the entry it opens is stored as 'commands.deploy'`);
          expect(text.stderr, asked).toContain("did you mean 'commands.deploy'?");
          expect(env.error?.code, asked).toBe('INVALID_INPUT');
          expect(env.error?.message, asked).toContain("did you mean 'commands.deploy'?");
        } else {
          expect(env.error?.code, asked).toBe('NOT_FOUND');
        }
        expect(snapshot(globalStore()), asked).toBe(before);
      }
      // The stored spelling renames, and carries the flag.
      expect(rvr('rename', '-G', 'commands.deploy', 'ops.deploy').status).toBe(0);
      expect(fs.existsSync(path.join(globalStore(), 'commands.deploy.json'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(globalStore(), '_confirm.json'), 'utf8'))).toEqual({ 'commands.deploy': true, 'ops.deploy': true });
    });

    it('the same in the default scope: a project entry, and a global one read through from the project', () => {
      expect(rvr('set', 'commands.deploy', 'true').status).toBe(0);
      expect(rvr('set', '-G', 'jobs.deploy', 'true').status).toBe(0);
      const before = [snapshot(projectStore()), snapshot(globalStore())].join('\n--\n');
      for (const [asked, stored, dir] of [['Commands.Deploy', 'commands.deploy', projectStore()], ['JOBS.deploy', 'jobs.deploy', globalStore()]] as const) {
        const env = json('rename', asked, 'ops.moved');
        expect(env.ok, asked).toBe(false);
        expect(env.error?.code, asked).toBe(folds(dir, asked, stored) ? 'INVALID_INPUT' : 'NOT_FOUND');
        if (folds(dir, asked, stored)) expect(env.error?.message).toContain(`did you mean '${stored}'?`);
      }
      expect([snapshot(projectStore()), snapshot(globalStore())].join('\n--\n')).toBe(before);
    });

    it('a namespace spelled another way opens no file of its own: not found, on any filesystem', () => {
      expect(rvr('set', '-G', 'commands.deploy', 'true').status).toBe(0);
      const before = snapshot(globalStore());
      expect(json('rename', '-G', 'Commands', 'ops').error?.code).toBe('NOT_FOUND');
      expect(snapshot(globalStore())).toBe(before);
    });
  });

  // A -G rename and a -G flag take the project store's lock too (#259), to
  // read its list and its entries consistently. A project this process
  // cannot write has no lock to take; the store is read as it is, as before.
  it('-G from inside a project this process cannot write: still works', () => {
    expect(rvr('set', '-G', 'g.x', 'true').status).toBe(0);
    fs.chmodSync(projectDir, 0o555);
    try {
      expect(rvr('confirm', 'set', '-G', 'g.x').status).toBe(0);
      expect(rvr('set', 'g.x', '--confirm', '-G').status).toBe(0);
      expect(rvr('rename', '-G', 'g.x', 'h.x').status).toBe(0);
    } finally {
      fs.chmodSync(projectDir, 0o755);
    }
    expect(JSON.parse(fs.readFileSync(path.join(globalStore(), '_confirm.json'), 'utf8'))).toEqual({ 'g.x': true, 'h.x': true });
    expect(fs.existsSync(path.join(globalStore(), 'h.x.json'))).toBe(true);
  });

  describe('#245: a confirmation list that cannot be read', () => {
    const BROKEN = '{\n<<<<<<< ours\n  "a": true\n=======\n  "b": true\n>>>>>>> theirs\n}\n';

    it('a project rename while the GLOBAL list is unreadable: refused, nothing written; the flag still gates after the repair', () => {
      expect(rvr('set', 'commands.deploy', `touch ${path.join(dataDir, 'ran')}`).status).toBe(0);
      expect(rvr('confirm', 'set', '-G', 'commands.deploy').status).toBe(0);
      const list = path.join(globalStore(), '_confirm.json');
      const good = fs.readFileSync(list, 'utf8');
      fs.writeFileSync(list, BROKEN);
      const before = snapshot(projectStore());

      const text = rvr('rename', 'commands.deploy', 'ops.deploy');
      expect(text.status).toBe(1);
      expect(text.stderr).toContain("Refusing to rename 'commands.deploy' while the global store's confirmation list cannot be read");
      expect(text.stderr).toContain('Nothing was written.');
      const env = json('rename', 'commands.deploy', 'ops.deploy');
      expect(env.error?.code).toBe('STORE_UNREADABLE');
      expect(snapshot(projectStore())).toBe(before);
      expect(fs.readFileSync(list, 'utf8')).toBe(BROKEN);

      // Repaired: the entry is where it was, and still gated.
      fs.writeFileSync(list, good);
      expect(json('run', 'commands.deploy').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(json('run', 'ops.deploy').error?.code).toBe('NOT_FOUND');
      expect(fs.existsSync(path.join(dataDir, 'ran'))).toBe(false);
    });

    it('rename -G while the PROJECT list is unreadable: refused, nothing written', () => {
      expect(rvr('set', '-G', 'commands.deploy', `touch ${path.join(dataDir, 'ran')}`).status).toBe(0);
      expect(rvr('confirm', 'set', 'commands.deploy').status).toBe(0);
      const list = path.join(projectStore(), '_confirm.json');
      const good = fs.readFileSync(list, 'utf8');
      fs.writeFileSync(list, BROKEN);
      const before = snapshot(globalStore());

      const text = rvr('rename', '-G', 'commands.deploy', 'ops.deploy');
      expect(text.status).toBe(1);
      expect(text.stderr).toContain("Refusing to rename 'commands.deploy' while the project store's confirmation list cannot be read");
      expect(json('rename', '-G', 'commands.deploy', 'ops.deploy').error?.code).toBe('STORE_UNREADABLE');
      expect(snapshot(globalStore())).toBe(before);

      fs.writeFileSync(list, good);
      expect(json('run', '-G', 'commands.deploy').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(fs.existsSync(path.join(dataDir, 'ran'))).toBe(false);
    });

    it('the written store\'s own list keeps the refusal any write to it gets', () => {
      expect(rvr('set', 'commands.deploy', 'true').status).toBe(0);
      fs.writeFileSync(path.join(projectStore(), '_confirm.json'), BROKEN);
      const r = rvr('rename', 'commands.deploy', 'ops.deploy');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Refusing to write the confirmation list');
      expect(fs.existsSync(path.join(projectStore(), 'ops.deploy.json'))).toBe(false);
    });
  });
});
