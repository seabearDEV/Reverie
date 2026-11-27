import fs from 'fs';
import path from 'path';
import os from 'os';
import { createAutoBackup } from '../utils/autoBackup';
import { ProjectResolutionError } from '../projectResolution';

let tmpDir: string;
let projectStoreDir: string | null;

vi.mock('../utils/paths', () => ({
  getDataDirectory: () => tmpDir,
  findProjectStoreDir: () => projectStoreDir,
}));

vi.mock('../config', () => ({
  getConfigSetting: vi.fn((key: string) => {
    if (key === 'max_backups') return 3;
    return null;
  }),
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-backup-'));
  projectStoreDir = null;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createAutoBackup — global scope', () => {
  it('creates a backup directory with data.json copy', () => {
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"entries":{}}');

    const result = createAutoBackup('test', 'global');

    expect(result).toBeTruthy();
    expect(fs.existsSync(result!)).toBe(true);
    expect(fs.existsSync(path.join(result!, 'data.json'))).toBe(true);
  });

  it('returns null when no files to back up', () => {
    const result = createAutoBackup('test', 'global');
    expect(result).toBeNull();
  });

  it('rotates old backups based on max_backups config', () => {
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');
    const backupDir = path.join(tmpDir, '.backups');

    fs.mkdirSync(backupDir, { recursive: true });
    const old: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Both stamp formats this module has written.
      const name = i % 2 === 0 ? `pre-reset-2020-01-0${i + 1}T00-00-00` : `pre-import-2020-01-0${i + 1}T00-00-00-123`;
      old.push(name);
      const dir = path.join(backupDir, name);
      fs.mkdirSync(path.join(dir, 'store'), { recursive: true });
      const time = new Date(2020, 0, 1 + i);
      fs.utimesSync(dir, time, time);
    }

    const created = createAutoBackup('pre-import', 'global');

    // Five old plus the new one, three kept: the three oldest went.
    expect(fs.readdirSync(backupDir).sort()).toEqual([...old.slice(3), path.basename(created!)].sort());
  });

  // #282: rotation deleted every directory in the backups dir. It deletes
  // only the backups it made now.
  it('rotation leaves alone what is not a backup it made', () => {
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');
    const backupDir = path.join(tmpDir, '.backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-backup-outside-'));
    try {
      fs.mkdirSync(path.join(outside, 'store'));
      fs.writeFileSync(path.join(outside, 'store', 'precious.json'), 'x');
      const ancient = new Date(2001, 0, 1);
      const keep = {
        notABackupName: 'notes',
        noStoreInside: 'pre-reset-2019-01-01T00-00-00',
        aFile: 'pre-reset-2019-01-02T00-00-00',
        aLink: 'pre-reset-2019-01-03T00-00-00',
      };
      fs.mkdirSync(path.join(backupDir, keep.notABackupName, 'store'), { recursive: true });
      fs.mkdirSync(path.join(backupDir, keep.noStoreInside));
      fs.writeFileSync(path.join(backupDir, keep.aFile), '');
      fs.symlinkSync(outside, path.join(backupDir, keep.aLink));
      for (const name of [keep.notABackupName, keep.noStoreInside, keep.aFile]) fs.utimesSync(path.join(backupDir, name), ancient, ancient);
      for (let i = 0; i < 5; i++) {
        const dir = path.join(backupDir, `pre-reset-2020-01-0${i + 1}T00-00-00`);
        fs.mkdirSync(path.join(dir, 'store'), { recursive: true });
        fs.utimesSync(dir, new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i));
      }

      createAutoBackup('pre-reset', 'global');

      const remaining = fs.readdirSync(backupDir);
      for (const name of Object.values(keep)) expect(remaining).toContain(name);
      expect(remaining.filter(n => n.startsWith('pre-reset-2020'))).toHaveLength(2);
      expect(fs.readFileSync(path.join(outside, 'store', 'precious.json'), 'utf8')).toBe('x');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked .backups dir (#282)', () => {
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-backup-outside-'));
    try {
      fs.symlinkSync(outside, path.join(tmpDir, '.backups'));
      expect(() => createAutoBackup('pre-reset', 'global')).toThrow(/\.backups is a symbolic link/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('backs up legacy files when they exist', () => {
    fs.writeFileSync(path.join(tmpDir, 'entries.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'aliases.json'), '{}');

    const result = createAutoBackup('legacy', 'global');

    expect(result).toBeTruthy();
    expect(fs.existsSync(path.join(result!, 'entries.json'))).toBe(true);
    expect(fs.existsSync(path.join(result!, 'aliases.json'))).toBe(true);
  });

  it('labels backup directory with the provided label', () => {
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');

    const result = createAutoBackup('pre-import', 'global');

    expect(result).toBeTruthy();
    expect(path.basename(result!)).toMatch(/^pre-import-/);
  });
});

describe('createAutoBackup — project scope', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-'));
    projectStoreDir = path.join(projectRoot, '.reverie');
    fs.mkdirSync(projectStoreDir, { mode: 0o700 });
    fs.writeFileSync(path.join(projectStoreDir, 'foo.json'), '{"value":"bar"}');
    fs.writeFileSync(path.join(projectStoreDir, '_aliases.json'), '{"a":"foo"}');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('copies the project .codexcli/ dir into <projectRoot>/.reverie.backups/', () => {
    const result = createAutoBackup('pre-reset', 'project');

    expect(result).toBeTruthy();
    expect(result!.startsWith(path.join(projectRoot, '.reverie.backups'))).toBe(true);
    expect(fs.existsSync(path.join(result!, '.reverie', 'foo.json'))).toBe(true);
    expect(fs.existsSync(path.join(result!, '.reverie', '_aliases.json'))).toBe(true);
  });

  it('does not touch the global .backups/ dir', () => {
    createAutoBackup('pre-reset', 'project');
    expect(fs.existsSync(path.join(tmpDir, '.backups'))).toBe(false);
  });

  // #296: it returned null ("nothing to back up") and the caller went on to
  // reset or replace the global store, with no backup of it anywhere.
  it('refuses project scope when there is no project store, and backs up nothing', () => {
    projectStoreDir = null;
    let thrown: unknown;
    try { createAutoBackup('pre-reset', 'project'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(ProjectResolutionError);
    expect((thrown as ProjectResolutionError).code).toBe('PROJECT_UNRESOLVED');
    expect((thrown as ProjectResolutionError).requested).toBe('project');
    expect(fs.existsSync(path.join(tmpDir, '.backups'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.reverie.backups'))).toBe(false);
  });

  it('auto-resolves to project when scope is omitted and project store exists', () => {
    const result = createAutoBackup('pre-import');
    expect(result).toBeTruthy();
    expect(result!.startsWith(path.join(projectRoot, '.reverie.backups'))).toBe(true);
  });

  describe('a .reverie.backups the repository shipped (#282)', () => {
    let victim: string;
    let siblings: string[];

    // What `.reverie.backups -> ..` reached: the directory holding the
    // user's other checkouts. A dir of this test's own, with old siblings.
    beforeEach(() => {
      victim = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-victim-'));
      siblings = [];
      for (let i = 1; i <= 14; i++) {
        const name = `proj${String(i).padStart(2, '0')}`;
        siblings.push(name);
        fs.mkdirSync(path.join(victim, name));
        fs.writeFileSync(path.join(victim, name, 'work.txt'), name);
        fs.utimesSync(path.join(victim, name), new Date(2020, 0, i), new Date(2020, 0, i));
      }
    });
    afterEach(() => { fs.rmSync(victim, { recursive: true, force: true }); });

    it('a symlink: refused before anything is written or deleted through it', () => {
      fs.symlinkSync(victim, path.join(projectRoot, '.reverie.backups'));

      expect(() => createAutoBackup('pre-reset', 'project')).toThrow(/\.reverie\.backups is a symbolic link/);

      expect(fs.readdirSync(victim).sort()).toEqual(siblings);
      for (const name of siblings) expect(fs.readFileSync(path.join(victim, name, 'work.txt'), 'utf8')).toBe(name);
      expect(fs.lstatSync(path.join(projectRoot, '.reverie.backups')).isSymbolicLink()).toBe(true);
    });

    it('a dangling symlink: refused, not created through', () => {
      const nowhere = path.join(victim, 'not-yet');
      fs.symlinkSync(nowhere, path.join(projectRoot, '.reverie.backups'));

      expect(() => createAutoBackup('pre-reset', 'project')).toThrow(/symbolic link/);
      expect(fs.existsSync(nowhere)).toBe(false);
    });

    it('a regular file: refused', () => {
      fs.writeFileSync(path.join(projectRoot, '.reverie.backups'), '');
      expect(() => createAutoBackup('pre-import', 'project')).toThrow(/\.reverie\.backups is not a directory/);
    });

    it('a real directory: rotation deletes only its own backups, codexCLI-era ones included', () => {
      const backupDir = path.join(projectRoot, '.reverie.backups');
      fs.mkdirSync(backupDir);
      const ownOld = ['pre-reset-2020-01-01T00-00-00', 'pre-import-2020-01-02T00-00-00-5'];
      fs.mkdirSync(path.join(backupDir, ownOld[0], '.reverie'), { recursive: true });
      fs.mkdirSync(path.join(backupDir, ownOld[1], '.codexcli'), { recursive: true });
      fs.symlinkSync(victim, path.join(backupDir, 'pre-reset-2019-01-01T00-00-00'));
      fs.mkdirSync(path.join(backupDir, 'pre-reset-2019-01-02T00-00-00'));   // holds no store
      for (const name of [...ownOld, 'pre-reset-2019-01-02T00-00-00']) {
        fs.utimesSync(path.join(backupDir, name), new Date(2019, 0, 1), new Date(2019, 0, 1));
      }
      // Two recent backups of its own, then a new one: five, and max_backups is 3.
      for (const name of ['pre-reset-2030-01-01T00-00-00', 'pre-reset-2030-01-02T00-00-00']) {
        fs.mkdirSync(path.join(backupDir, name, '.reverie'), { recursive: true });
      }
      createAutoBackup('pre-reset', 'project');

      const remaining = fs.readdirSync(backupDir);
      for (const name of ownOld) expect(remaining).not.toContain(name);
      expect(remaining).toContain('pre-reset-2019-01-01T00-00-00');
      expect(remaining).toContain('pre-reset-2019-01-02T00-00-00');
      expect(fs.readdirSync(victim).sort()).toEqual(siblings);
    });

    it('a real directory shipped with backup-named dirs whose store is a link out: never deleted, nor what it links to', () => {
      // The repository ships more backup-named dirs than max_backups, each
      // "holding" a store that is a symlink to the victim's directory.
      const backupDir = path.join(projectRoot, '.reverie.backups');
      fs.mkdirSync(backupDir);
      const planted: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const name = `pre-reset-2019-01-0${i}T00-00-00`;
        planted.push(name);
        fs.mkdirSync(path.join(backupDir, name));
        fs.symlinkSync(victim, path.join(backupDir, name, '.reverie'));
        fs.utimesSync(path.join(backupDir, name), new Date(2019, 0, i), new Date(2019, 0, i));
      }

      createAutoBackup('pre-reset', 'project');

      const remaining = fs.readdirSync(backupDir);
      for (const name of planted) expect(remaining).toContain(name);
      expect(fs.readdirSync(victim).sort()).toEqual(siblings);
      for (const name of siblings) expect(fs.readFileSync(path.join(victim, name, 'work.txt'), 'utf8')).toBe(name);
    });
  });

  it('throws when the backup write fails', () => {
    // Make the project root read-only so mkdir of .reverie.backups/ fails.
    // fs.cpSync/mkdirSync will throw EACCES or EPERM.
    fs.chmodSync(projectRoot, 0o500);
    try {
      expect(() => createAutoBackup('pre-reset', 'project')).toThrow();
    } finally {
      fs.chmodSync(projectRoot, 0o700);
    }
  });
});
