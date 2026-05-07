import fs from 'fs';
import path from 'path';
import { getDataDirectory, findProjectStoreDir } from './paths';
import { debug } from './debug';
import { getConfigSetting } from '../config';
import type { Scope } from '../store';

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
 */
export function createAutoBackup(label: string, scope?: Scope): string | null {
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

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  }

  const backupSubDir = path.join(backupDir, `${label}-${timestamp()}`);
  fs.mkdirSync(backupSubDir, { mode: 0o700 });

  fs.cpSync(projectStoreDir, path.join(backupSubDir, '.reverie'), { recursive: true });

  debug(`Auto-backup created: ${backupSubDir} (project store)`);
  rotateBackups(backupDir);
  return backupSubDir;
}

function backupGlobalStore(label: string): string | null {
  const dataDir = getDataDirectory();
  const backupDir = path.join(dataDir, '.backups');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  }

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
  rotateBackups(backupDir);
  return backupSubDir;
}

function timestamp(): string {
  // Include milliseconds — callers can spin two backups inside the same
  // second (e.g. integration tests doing back-to-back resets), and a
  // second-precision stamp collided on mkdirSync EEXIST.
  return new Date().toISOString().replace(/:/g, '-').replace(/\.(\d+)Z$/, '-$1');
}

function rotateBackups(backupDir: string): void {
  try {
    const configuredMaxBackups = Number(getConfigSetting('max_backups'));
    const maxBackups = Number.isNaN(configuredMaxBackups) ? 10 : configuredMaxBackups;
    if (maxBackups <= 0) return;

    const allBackups = fs.readdirSync(backupDir)
      .map(name => {
        const fullPath = path.join(backupDir, name);
        const stats = fs.statSync(fullPath);
        return { name, stats };
      })
      .filter(entry => entry.stats.isDirectory())
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
