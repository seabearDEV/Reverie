import fs from 'fs';
import path from 'path';
import { getDataDirectory, findProjectStoreDir } from './paths';
import { debug } from './debug';
import { assertNotTestCheckout } from './directoryStore';
import { getConfigSetting } from '../config';
import { assertProjectScope, type Scope } from '../store';

/**
 * Create automatic backups of data files before destructive operations.
 *
 * Global scope: copies the global store dir + legacy sidecars into
 * `<dataDir>/.backups/<label>-<ts>/`.
 *
 * Project scope: copies the project `.reverie/` dir into
 * `<projectRoot>/.reverie.backups/<label>-<ts>/`. The backup lives outside
 * the managed `.reverie/` dir so it doesn't pollute the store or trip the
 * hand-edit warning contract (conventions.editSurface).
 *
 * Returns the backup subdir path on success, or null if there was nothing to
 * back up (fresh/empty store). Throws on any filesystem failure — callers
 * must abort the destructive op when this throws.
 *
 * Project scope asked for with no project throws ProjectResolutionError
 * (#296): it used to return null — "nothing to back up" — and the caller
 * went on to reset or replace the global store, unbacked.
 */
export function createAutoBackup(label: string, scope?: Scope): string | null {
  assertProjectScope(scope);
  const effectiveScope = resolveBackupScope(scope);
  return effectiveScope === 'project'
    ? backupProjectStore(label)
    : backupGlobalStore(label);
}

function resolveBackupScope(scope?: Scope): 'project' | 'global' {
  if (scope === 'project') return 'project';
  if (scope === 'global') return 'global';
  return findProjectStoreDir() ? 'project' : 'global';
}

function backupProjectStore(label: string): string | null {
  const projectStoreDir = findProjectStoreDir();
  if (!projectStoreDir || !fs.existsSync(projectStoreDir)) {
    return null;
  }

  const projectRoot = path.dirname(projectStoreDir);
  const backupDir = path.join(projectRoot, '.reverie.backups');
  assertNotTestCheckout(backupDir);   // #274: before the store, which refuses too, is reached

  ensureBackupDir(backupDir);

  const backupSubDir = path.join(backupDir, `${label}-${timestamp()}`);
  fs.mkdirSync(backupSubDir, { mode: 0o700 });

  fs.cpSync(projectStoreDir, path.join(backupSubDir, '.reverie'), { recursive: true });

  debug(`Auto-backup created: ${backupSubDir} (project store)`);
  rotateBackups(backupDir, PROJECT_BACKUP_CHILDREN);
  return backupSubDir;
}

function backupGlobalStore(label: string): string | null {
  const dataDir = getDataDirectory();
  const backupDir = path.join(dataDir, '.backups');
  assertNotTestCheckout(backupDir);   // #274

  ensureBackupDir(backupDir);

  const backupSubDir = path.join(backupDir, `${label}-${timestamp()}`);
  fs.mkdirSync(backupSubDir, { mode: 0o700 });

  let backedUp = 0;

  const storeDir = path.join(dataDir, 'store');
  if (fs.existsSync(storeDir) && fs.statSync(storeDir).isDirectory()) {
    fs.cpSync(storeDir, path.join(backupSubDir, 'store'), { recursive: true });
    backedUp++;
  }

  const legacyFiles = ['data.json', 'entries.json', 'aliases.json', 'confirm.json'];
  for (const file of legacyFiles) {
    const src = path.join(dataDir, file);
    if (fs.existsSync(src)) {
      const dest = path.join(backupSubDir, file);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o600);
      backedUp++;
    }
  }

  if (backedUp === 0) {
    try { fs.rmSync(backupSubDir); } catch { /* ignore */ }
    return null;
  }

  debug(`Auto-backup created: ${backupSubDir} (${backedUp} files)`);
  rotateBackups(backupDir, GLOBAL_BACKUP_CHILDREN);
  return backupSubDir;
}

/**
 * #282: the backups directory sits beside a project's `.reverie/`, inside a
 * repository someone else may have written. Shipped as a symlink
 * (`.reverie.backups -> ..`), every backup was written into its target and
 * rotation deleted all but the newest directories there — the user's other
 * checkouts, or their home. Like the store leaf (#159), it must be a real
 * directory: absent (then created), or one, by lstat. Checked again after
 * creating it. Anything else throws, and the destructive command that asked
 * for the backup aborts. The global one gets the same rule.
 */
function ensureBackupDir(backupDir: string): void {
  if (!pathEntryExists(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(backupDir);
  if (st.isSymbolicLink()) {
    throw new Error(`${backupDir} is a symbolic link; backups are written only to a real directory, so remove the link and retry`);
  }
  if (!st.isDirectory()) {
    throw new Error(`${backupDir} is not a directory; move it aside and retry`);
  }
}

function pathEntryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function timestamp(): string {
  // Include milliseconds — callers can spin two backups inside the same
  // second (e.g. integration tests doing back-to-back resets), and a
  // second-precision stamp collided on mkdirSync EEXIST.
  return new Date().toISOString().replace(/:/g, '-').replace(/\.(\d+)Z$/, '-$1');
}

/**
 * A backup's name: its label and the moment it was taken, in either stamp
 * format this module has written (`…T12-34-56`, and since the milliseconds
 * were added `…T12-34-56-789`).
 */
const BACKUP_NAME = /^(?:pre-import|pre-reset)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{1,9})?$/;

/** A name a backup holds, and whether it is a directory or a file there. */
type BackupChild = [name: string, kind: 'dir' | 'file'];

/** What a project backup holds: the store, under its current or its codexCLI-era name. */
const PROJECT_BACKUP_CHILDREN: BackupChild[] = [['.reverie', 'dir'], ['.codexcli', 'dir']];
/** What a global backup holds: the store directory, or the legacy single files. */
const GLOBAL_BACKUP_CHILDREN: BackupChild[] = [
  ['store', 'dir'], ['data.json', 'file'], ['entries.json', 'file'], ['aliases.json', 'file'], ['confirm.json', 'file'],
];

/**
 * Is `dir` a backup this module made? A real directory (lstat: a symlink is
 * never one), named as a backup, holding what a backup holds — itself real,
 * not a link to somewhere else. Rotation deletes nothing else (#282): it used
 * to delete every directory it found.
 */
function isOwnBackup(backupDir: string, name: string, children: BackupChild[]): fs.Stats | undefined {
  if (!BACKUP_NAME.test(name)) return undefined;
  const fullPath = path.join(backupDir, name);
  const holds = ([child, kind]: BackupChild): boolean => {
    try {
      const st = fs.lstatSync(path.join(fullPath, child));
      return kind === 'dir' ? st.isDirectory() : st.isFile();
    } catch {
      return false;
    }
  };
  try {
    const stats = fs.lstatSync(fullPath);
    if (!stats.isDirectory()) return undefined;
    return children.some(holds) ? stats : undefined;
  } catch {
    return undefined;
  }
}

function rotateBackups(backupDir: string, children: BackupChild[]): void {
  try {
    const configuredMaxBackups = Number(getConfigSetting('max_backups'));
    const maxBackups = Number.isNaN(configuredMaxBackups) ? 10 : configuredMaxBackups;
    if (maxBackups <= 0) return;

    const allBackups = fs.readdirSync(backupDir)
      .map(name => ({ name, stats: isOwnBackup(backupDir, name, children) }))
      .filter((entry): entry is { name: string; stats: fs.Stats } => entry.stats !== undefined)
      .sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs)
      .map(entry => entry.name);

    if (allBackups.length > maxBackups) {
      const toRemove = allBackups.slice(0, allBackups.length - maxBackups);
      for (const old of toRemove) {
        fs.rmSync(path.join(backupDir, old), { recursive: true, force: true });
      }
      debug(`Removed ${toRemove.length} old backup(s), keeping ${maxBackups}`);
    }
  } catch (cleanupErr) {
    debug(`Backup cleanup failed: ${String(cleanupErr)}`);
  }
}
