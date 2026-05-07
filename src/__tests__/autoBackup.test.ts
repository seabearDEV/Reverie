import fs from 'fs';
import path from 'path';
import os from 'os';
import { createAutoBackup } from '../utils/autoBackup';

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
    for (let i = 0; i < 5; i++) {
      const dir = path.join(backupDir, `old-${String(i).padStart(3, '0')}`);
      fs.mkdirSync(dir);
      const time = new Date(2020, 0, 1 + i);
      fs.utimesSync(dir, time, time);
    }

    createAutoBackup('new', 'global');

    const remaining = fs.readdirSync(backupDir);
    expect(remaining.length).toBe(3);
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

  it('returns null when project scope requested but no project store exists', () => {
    projectStoreDir = null;
    const result = createAutoBackup('pre-reset', 'project');
    expect(result).toBeNull();
  });

  it('auto-resolves to project when scope is omitted and project store exists', () => {
    const result = createAutoBackup('pre-import');
    expect(result).toBeTruthy();
    expect(result!.startsWith(path.join(projectRoot, '.reverie.backups'))).toBe(true);
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
