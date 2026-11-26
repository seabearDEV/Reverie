/**
 * #282, end to end: a cloned repository ships `.reverie.backups` as a symlink
 * out of the repo (`.reverie.backups -> ..`). A project `data reset --force`
 * or `data import --force` wrote its backup into the link's target, and
 * rotation then deleted all but the newest 10 directories there: the user's
 * other checkouts, or their home. The legacy name `.codexcli.backups` got
 * there too, renamed to `.reverie.backups` by the codexCLI migration.
 *
 * Every link here points at a directory this test made, the repository
 * nested inside it; rotation is told to keep 3 so a regression would show.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

describe('a symlinked backups directory in a cloned repository (#282)', () => {
  const cli = path.resolve('dist/index.js');
  let root: string;
  let victim: string;
  let repo: string;
  let siblings: string[];

  const rvr = (...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home') };
    delete e.RVR_SESSION;
    delete e.RVR_NO_PROJECT;
    delete e.RVR_PROJECT;
    delete e.RVR_OUTPUT;
    const r = spawnSync('bun', [cli, ...args], { cwd: repo, env: e as NodeJS.ProcessEnv, input: '', timeout: 15000 });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const victimIntact = () => {
    expect(fs.readdirSync(victim).sort()).toEqual([...siblings, 'repo'].sort());
    for (const name of siblings) expect(fs.readFileSync(path.join(victim, name, 'work.txt'), 'utf8')).toBe(name);
  };

  beforeAll(() => { assertDistHonorsDataDir(); });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-backup-link-'));
    for (const d of ['data', 'home']) fs.mkdirSync(path.join(root, d));
    // The directory holding the user's checkouts: old siblings, and the clone.
    victim = path.join(root, 'checkouts');
    fs.mkdirSync(victim);
    siblings = [];
    for (let i = 1; i <= 8; i++) {
      const name = `proj${String(i).padStart(2, '0')}`;
      siblings.push(name);
      fs.mkdirSync(path.join(victim, name));
      fs.writeFileSync(path.join(victim, name, 'work.txt'), name);
      fs.utimesSync(path.join(victim, name), new Date(2020, 0, i), new Date(2020, 0, i));
    }
    repo = path.join(victim, 'repo');
    fs.mkdirSync(repo);
    expect(rvr('config', 'set', 'max_backups', '3').status).toBe(0);
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const shipStore = (dirName: '.reverie' | '.codexcli') => {
    const store = path.join(repo, dirName);
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(store, 'arch.notes.json'), JSON.stringify({ value: 'kept' }));
  };

  it('`data reset entries --force`: aborts before writing or deleting anything through the link', () => {
    shipStore('.reverie');
    fs.symlinkSync(victim, path.join(repo, '.reverie.backups'));

    const r = rvr('data', 'reset', 'entries', '--force');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Aborting: auto-backup failed');
    expect(r.stderr).toContain('.reverie.backups is a symbolic link');
    expect(r.stderr).toContain('No changes were made.');
    victimIntact();
    // The reset did not run either.
    expect(fs.existsSync(path.join(repo, '.reverie', 'arch.notes.json'))).toBe(true);
  }, 30000);

  it('`data import --force` (replace): aborts the same way', () => {
    shipStore('.reverie');
    fs.symlinkSync(victim, path.join(repo, '.reverie.backups'));
    const file = path.join(root, 'import.json');
    fs.writeFileSync(file, JSON.stringify({ entries: { other: 'x' } }));

    const r = rvr('data', 'import', 'all', file, '--force');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Aborting: auto-backup failed');
    victimIntact();
    expect(fs.existsSync(path.join(repo, '.reverie', 'arch.notes.json'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.reverie', 'other.json'))).toBe(false);
  }, 30000);

  it('a symlinked `.codexcli.backups` is not carried over by the legacy migration', () => {
    shipStore('.codexcli');
    fs.symlinkSync(victim, path.join(repo, '.codexcli.backups'));

    const r = rvr('data', 'reset', 'entries', '--force');

    // The store moved to .reverie/; the link stayed where it was, and the
    // backup went into a real .reverie.backups/ of its own.
    expect(r.status).toBe(0);
    expect(fs.lstatSync(path.join(repo, '.codexcli.backups')).isSymbolicLink()).toBe(true);
    const backups = path.join(repo, '.reverie.backups');
    expect(fs.lstatSync(backups).isDirectory()).toBe(true);
    const made = fs.readdirSync(backups);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(/^pre-reset-/);
    expect(fs.existsSync(path.join(backups, made[0], '.reverie', 'arch.notes.json'))).toBe(true);
    victimIntact();
  }, 30000);

  it('a real `.reverie.backups` still works: the reset runs and the backup is kept', () => {
    shipStore('.reverie');

    const r = rvr('data', 'reset', 'entries', '--force');

    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(repo, '.reverie', 'arch.notes.json'))).toBe(false);
    const made = fs.readdirSync(path.join(repo, '.reverie.backups'));
    expect(made).toHaveLength(1);
    expect(fs.existsSync(path.join(repo, '.reverie.backups', made[0], '.reverie', 'arch.notes.json'))).toBe(true);
    victimIntact();
  }, 30000);
});
