import path from 'path';
import os from 'os';
import * as fs from 'fs';
import { getBinaryName } from './binaryName';

/**
 * Determines if the application is running in development mode
 */
function isDev(): boolean {
  return process.env.NODE_ENV === 'development' ||
         getBinaryName() === 'rvr-dev' ||
         Boolean(process.argv[1]?.includes('ts-node')) ||
         Boolean(process.env.npm_lifecycle_script?.includes('ts-node'));
}

// Legacy directory name from the codexCLI era. Detected during walk-up
// resolution and atomic-renamed to `.reverie/` on first access. See
// migrateLegacyDir() below.
const LEGACY_PROJECT_DIR_NAME = '.codexcli';
const LEGACY_PROJECT_FILE_NAME = '.codexcli.json';
const LEGACY_GLOBAL_DIR_NAME = '.codexcli';
const LEGACY_BACKUPS_DIR_NAME = '.codexcli.backups';

const PROJECT_DIR_NAME = '.reverie';
const BACKUPS_DIR_NAME = '.reverie.backups';

// Add caching for path resolution
let dataDirectoryCache: string | null = null;
let dataDirEnsured = false;
let dataDirWritabilityWarned = false;

/**
 * Get the directory where data files should be stored.
 *
 * Resolution order:
 *   1. `RVR_DATA_DIR` env var (must be a non-empty absolute path)
 *   2. Dev mode: `<repo>/data`
 *   3. Production: `~/.reverie`
 *
 * Validation: when `RVR_DATA_DIR` is set, it must be an absolute path.
 * Relative values are rejected with a hard error rather than silently
 * resolved against `process.cwd()` — the resolved location of a relative
 * path depends on which directory the process happened to be in at the
 * moment of the first call, which is surprising (especially for
 * long-running MCP servers whose cwd may differ from the user's shell).
 * Empty strings are treated as unset.
 *
 * If the resolved directory exists but isn't writable, a one-time warning
 * is emitted to stderr. Non-existent directories are not warned about
 * here — `ensureDataDirectoryExists()` creates them later, and warning
 * about a path we're about to create would be noise.
 */
export function getDataDirectory(): string {
  if (dataDirectoryCache !== null) return dataDirectoryCache;

  const fromEnv = process.env.RVR_DATA_DIR;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!path.isAbsolute(fromEnv)) {
      throw new Error(
        `RVR_DATA_DIR must be an absolute path. Got: ${JSON.stringify(fromEnv)}. ` +
        `Relative paths are rejected because the resolved location would depend on ` +
        `process.cwd() at first call.`
      );
    }
    dataDirectoryCache = fromEnv;
  } else if (isDev()) {
    dataDirectoryCache = path.join(path.resolve(__dirname, '..', '..'), 'data');
  } else {
    dataDirectoryCache = path.join(os.homedir(), PROJECT_DIR_NAME);
  }

  // One-time writability check. We only warn when the directory exists
  // already; non-existent paths are normal on first run and get created
  // by ensureDataDirectoryExists().
  if (!dataDirWritabilityWarned) {
    try {
      if (fs.existsSync(dataDirectoryCache)) {
        fs.accessSync(dataDirectoryCache, fs.constants.W_OK | fs.constants.X_OK);
      }
    } catch {
      process.stderr.write(
        `Warning: data directory ${dataDirectoryCache} is not writable. ` +
        `Reverie may fail to save changes.\n`
      );
    }
    dataDirWritabilityWarned = true;
  }

  return dataDirectoryCache;
}

/**
 * True if `RVR_DATA_DIR` is set to a non-empty value. Used by `rvr info`
 * (and tests) to label the data path with its source.
 */
export function isDataDirectoryFromEnv(): boolean {
  const fromEnv = process.env.RVR_DATA_DIR;
  return fromEnv !== undefined && fromEnv !== '';
}

/**
 * Reset the cached data directory and related one-shot flags. After this
 * call, the next `getDataDirectory()` re-reads `RVR_DATA_DIR` and may
 * re-emit the writability warning. Mirrors `clearProjectFileCache()`.
 * Primarily used by tests; production code has no reason to call this.
 */
export function clearDataDirectoryCache(): void {
  dataDirectoryCache = null;
  dataDirEnsured = false;
  dataDirWritabilityWarned = false;
}

/**
 * Ensures the data directory exists. On first access, also performs the
 * codexcli→reverie global-store migration: if the canonical `~/.reverie`
 * directory doesn't exist but the legacy `~/.codexcli` directory does,
 * atomically rename it. Migration runs only for the default production
 * path (`~/.reverie`). Custom `RVR_DATA_DIR` values are user-controlled
 * and bypass migration.
 */
export function ensureDataDirectoryExists(): string {
  const dataDir = getDataDirectory();

  if (!dataDirEnsured) {
    if (!fs.existsSync(dataDir)) {
      const defaultProductionPath = path.join(os.homedir(), PROJECT_DIR_NAME);
      const legacyGlobalPath = path.join(os.homedir(), LEGACY_GLOBAL_DIR_NAME);
      const isDefaultProductionPath = dataDir === defaultProductionPath;

      if (isDefaultProductionPath && fs.existsSync(legacyGlobalPath)) {
        try {
          fs.renameSync(legacyGlobalPath, dataDir);
        } catch (err) {
          throw new Error(
            `Failed to migrate legacy global store ${legacyGlobalPath} → ${dataDir}: ${String(err)}. ` +
            `Move or remove one of these paths and retry.`
          );
        }
      } else {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      }
    }
    dataDirEnsured = true;
  }

  return dataDir;
}

/**
 * Get the path to the aliases file
 *
 * @returns {string} Path to the aliases.json file
 */
export function getAliasFilePath(): string {
  return path.join(getDataDirectory(), 'aliases.json');
}

/**
 * Gets the full path to the configuration file
 *
 * @returns {string} Absolute path to the JSON config file
 */
export function getConfigFilePath(): string {
  return path.join(getDataDirectory(), 'config.json');
}

/**
 * Get the path to the confirm metadata file
 *
 * @returns {string} Path to the confirm.json file
 */
export function getConfirmFilePath(): string {
  return path.join(getDataDirectory(), 'confirm.json');
}

/**
 * Get the path to the unified data file (data.json)
 */
export function getUnifiedDataFilePath(): string {
  return path.join(getDataDirectory(), 'data.json');
}

// Cached project file path (null = not searched yet, string = found, '' = not found)
let projectFileCache: string | null = null;

// Programmatic override for the directory where the search begins.
// Set by the MCP server after capturing client roots.
let projectRootOverride: string | null = null;

/**
 * Set the directory used as the starting point for project file discovery,
 * overriding process.cwd(). Pass null to clear. Clears the cached result.
 *
 * Relative input is absolutized via `path.resolve()` so the walk-up always
 * starts from an absolute directory. Without this, a `RVR_PROJECT_DIR=.` /
 * `--cwd .` launcher hint would yield a relative `.reverie` from the
 * resolver, which downstream `path.dirname()` reduced to `"."` in audit
 * rows (issue #102).
 */
export function setProjectRootOverride(dir: string | null): void {
  projectRootOverride = dir === null ? null : path.resolve(dir);
  projectFileCache = null;
  projectStoreDirCache = null;
}

/**
 * Read-only accessor for the programmatic root override. Used by the
 * project-resolution diagnostic so error messages can report whether MCP
 * client roots / launcher hints were in effect.
 */
export function getProjectRootOverride(): string | null {
  return projectRootOverride;
}

/**
 * Diagnostic record describing which resolver branches fired during project
 * file discovery. Captured alongside the resolved path by
 * `findProjectFileWithDiagnostic()` and consumed by `ProjectResolutionError`
 * to render a recovery-actionable error message.
 *
 * Field semantics:
 *  - `rvrNoProject`: RVR_NO_PROJECT env var was set (resolution short-circuits).
 *  - `rvrProject`: value of RVR_PROJECT if set, else undefined.
 *  - `rvrProjectFailed`: RVR_PROJECT was set but did not resolve to a
 *    `.reverie/` directory or `.codexcli.json` legacy file.
 *  - `rootOverride`: programmatic override value if set, else undefined.
 *  - `startedFrom`: directory the walk-up started from (override or cwd).
 *    Empty string when the walk did not run (e.g. RVR_NO_PROJECT short-circuit
 *    or RVR_PROJECT failure).
 *  - `walkReachedRoot`: walk-up exhausted the filesystem without finding a
 *    project store (stopped at the true filesystem root `/`).
 *  - `walkStoppedAtGlobalDir`: walk-up was stopped early because it reached
 *    the Reverie global data directory before finding a project store.
 */
export interface ResolverDiagnostic {
  rvrNoProject: boolean;
  rvrProject: string | undefined;
  rvrProjectFailed: boolean;
  rootOverride: string | undefined;
  startedFrom: string;
  walkReachedRoot: boolean;
  walkStoppedAtGlobalDir: boolean;
}

/**
 * Atomic-rename the legacy `.codexcli/` project dir to `.reverie/`, plus the
 * sibling `.codexcli.backups/` directory if present. Throws if the new path
 * already exists alongside the legacy one — refuses to silently merge or
 * overwrite. Same-filesystem rename is atomic.
 */
function migrateLegacyProjectDir(legacyPath: string, newPath: string, parentDir: string): void {
  if (fs.existsSync(newPath)) {
    throw new Error(
      `Both ${legacyPath} and ${newPath} exist. ` +
      `Move or remove one before continuing.`
    );
  }
  fs.renameSync(legacyPath, newPath);

  // Rename sibling auto-backup dir if present.
  const legacyBackups = path.join(parentDir, LEGACY_BACKUPS_DIR_NAME);
  const newBackups = path.join(parentDir, BACKUPS_DIR_NAME);
  if (fs.existsSync(legacyBackups) && !fs.existsSync(newBackups)) {
    try {
      fs.renameSync(legacyBackups, newBackups);
    } catch {
      // Best-effort. Backup dir rename failure shouldn't block the primary
      // migration — backups stay readable at the legacy name.
    }
  }
}

/**
 * Internal: shared resolver body for `findProjectFile()` and
 * `findProjectFileWithDiagnostic()`. Always returns both the resolved path
 * (or null) and a diagnostic record describing which branches fired. Does
 * not consult or populate the cache — callers handle caching.
 *
 * Walks up looking for `.reverie/` (canonical) or `.codexcli/` (legacy,
 * triggers in-place migration). Also detects the pre-v1.10 single-file
 * `.codexcli.json` for the legacy file→directory migration in store.ts.
 */
function resolveProjectFile(): { path: string | null; diagnostic: ResolverDiagnostic } {
  const rvrNoProject = Boolean(process.env.RVR_NO_PROJECT);
  const envPath = process.env.RVR_PROJECT;
  const rvrProject = envPath !== undefined && envPath !== '' ? envPath : undefined;
  const rootOverride = projectRootOverride ?? undefined;

  const diagnostic: ResolverDiagnostic = {
    rvrNoProject,
    rvrProject,
    rvrProjectFailed: false,
    rootOverride,
    startedFrom: '',
    walkReachedRoot: false,
    walkStoppedAtGlobalDir: false,
  };

  // 1. RVR_NO_PROJECT short-circuit
  if (rvrNoProject) {
    return { path: null, diagnostic };
  }

  // 2. RVR_PROJECT explicit path
  if (rvrProject !== undefined) {
    const resolved = path.resolve(rvrProject);
    // Direct hit: resolved IS a .reverie directory
    try {
      if (
        fs.existsSync(resolved) &&
        fs.statSync(resolved).isDirectory() &&
        path.basename(resolved) === PROJECT_DIR_NAME
      ) {
        return { path: resolved, diagnostic };
      }
    } catch { /* fall through */ }

    // Direct hit: resolved IS a legacy .codexcli directory — migrate then return
    try {
      if (
        fs.existsSync(resolved) &&
        fs.statSync(resolved).isDirectory() &&
        path.basename(resolved) === LEGACY_PROJECT_DIR_NAME
      ) {
        const parentDir = path.dirname(resolved);
        const newPath = path.join(parentDir, PROJECT_DIR_NAME);
        migrateLegacyProjectDir(resolved, newPath, parentDir);
        return { path: newPath, diagnostic };
      }
    } catch { /* fall through */ }

    // Direct hit: resolved IS a .codexcli.json legacy file
    if (fs.existsSync(resolved) && !isDirectorySafe(resolved)) {
      return { path: resolved, diagnostic };
    }

    // Containing directory: look for .reverie/, .codexcli/ (migrate), or .codexcli.json inside it
    if (fs.existsSync(resolved) && isDirectorySafe(resolved)) {
      const reverieCandidate = path.join(resolved, PROJECT_DIR_NAME);
      if (fs.existsSync(reverieCandidate) && isDirectorySafe(reverieCandidate)) {
        return { path: reverieCandidate, diagnostic };
      }
      const legacyCandidate = path.join(resolved, LEGACY_PROJECT_DIR_NAME);
      if (fs.existsSync(legacyCandidate) && isDirectorySafe(legacyCandidate)) {
        migrateLegacyProjectDir(legacyCandidate, reverieCandidate, resolved);
        return { path: reverieCandidate, diagnostic };
      }
      const fileCandidate = path.join(resolved, LEGACY_PROJECT_FILE_NAME);
      if (fs.existsSync(fileCandidate)) {
        return { path: fileCandidate, diagnostic };
      }
    }

    // Env var was set but didn't resolve — treat as "no project" rather than
    // silently falling back to a different directory the user didn't ask for.
    diagnostic.rvrProjectFailed = true;
    return { path: null, diagnostic };
  }

  // 3. & 4. Walk up from override or cwd
  const globalDir = getDataDirectory();
  const startedFrom = projectRootOverride ?? process.cwd();
  diagnostic.startedFrom = startedFrom;
  let dir = startedFrom;
  const root = path.parse(dir).root;

  while (true) {
    // Don't match files inside the global data directory
    if (path.resolve(dir) === path.resolve(globalDir)) {
      diagnostic.walkStoppedAtGlobalDir = true;
      return { path: null, diagnostic };
    }

    // Prefer canonical `.reverie/` over legacy `.codexcli/` (with migration)
    // over legacy `.codexcli.json` (single-file format, migrated by store.ts).
    const reverieCandidate = path.join(dir, PROJECT_DIR_NAME);
    if (fs.existsSync(reverieCandidate) && isDirectorySafe(reverieCandidate)) {
      return { path: reverieCandidate, diagnostic };
    }

    const legacyCandidate = path.join(dir, LEGACY_PROJECT_DIR_NAME);
    if (fs.existsSync(legacyCandidate) && isDirectorySafe(legacyCandidate)) {
      migrateLegacyProjectDir(legacyCandidate, reverieCandidate, dir);
      return { path: reverieCandidate, diagnostic };
    }

    const fileCandidate = path.join(dir, LEGACY_PROJECT_FILE_NAME);
    if (fs.existsSync(fileCandidate)) {
      return { path: fileCandidate, diagnostic };
    }

    const parent = path.dirname(dir);
    if (parent === dir || dir === root) {
      diagnostic.walkReachedRoot = true;
      return { path: null, diagnostic };
    }
    dir = parent;
  }
}

/**
 * Walk up from cwd to find the project store. Prefers a canonical
 * `.reverie/` directory; legacy `.codexcli/` directories trigger an
 * in-place atomic-rename migration; legacy `.codexcli.json` single-files
 * (pre-v1.10) are returned as-is and migrated in store.ts. Returns the
 * absolute path if found, null otherwise.
 *
 * Resolution order:
 *   1. RVR_NO_PROJECT env var → disabled (returns null)
 *   2. RVR_PROJECT env var → explicit path to a `.reverie` directory,
 *      `.codexcli.json` file, or a containing directory
 *   3. setProjectRootOverride() value (e.g. MCP client roots) → walk up from there
 *   4. process.cwd() → walk up from there
 *
 * Callers that need a directory specifically (store internals) should use
 * `findProjectStoreDir()` instead. Callers that need to *remove* the project
 * should use `fs.rmSync(path, { recursive: true, force: true })` which handles
 * both file and directory returns uniformly.
 *
 * Callers that need diagnostic information about which resolver branch fired
 * (e.g. write paths producing actionable refusal errors) should use
 * `findProjectFileWithDiagnostic()`.
 */
export function findProjectFile(): string | null {
  if (projectFileCache !== null) {
    return projectFileCache === '' ? null : projectFileCache;
  }
  const { path: resolved } = resolveProjectFile();
  projectFileCache = resolved ?? '';
  return resolved;
}

/**
 * Same resolution as `findProjectFile()` but additionally returns a
 * diagnostic record naming which resolver branches ran. Used by write paths
 * to render PROJECT_UNRESOLVED refusal errors that tell the user what was
 * tried and how to recover. Always re-runs the resolver — does not consult
 * or populate the path cache, since the diagnostic is uncached and callers
 * need it fresh.
 */
export function findProjectFileWithDiagnostic(): {
  path: string | null;
  diagnostic: ResolverDiagnostic;
} {
  return resolveProjectFile();
}

/** Safe wrapper around fs.statSync(...).isDirectory() that returns false on error. */
function isDirectorySafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Clear the cached project file path (for tests and after create/remove)
 */
export function clearProjectFileCache(): void {
  projectFileCache = null;
  projectStoreDirCache = null;
}

// ── v1.10.0 directory store paths ─────────────────────────────────────
// These are added ahead of the file-per-entry rollout (issue #54) so the
// migration function has somewhere to write. They do not replace the legacy
// file getters yet — the transition happens in the store.ts integration
// commit, after which the legacy getters are kept only for migration.

/**
 * Get the path to the global file-per-entry store directory (v1.10.0 layout).
 * Sits alongside the legacy `data.json` inside `getDataDirectory()` so the
 * existing sibling files (`config.json`, `audit.jsonl`, `telemetry.jsonl`,
 * `miss-paths.jsonl`, `.backups/`) stay where they are.
 */
export function getGlobalStoreDirPath(): string {
  return path.join(getDataDirectory(), 'store');
}

// Cached project store directory path (null = not searched yet, '' = not found)
let projectStoreDirCache: string | null = null;

/**
 * Walk up from cwd (or the programmatic override) to find a `.reverie/`
 * directory, which is the v1.10.0 project store. Legacy `.codexcli/`
 * directories trigger inline atomic-rename migration. Returns the absolute
 * path if found, null otherwise.
 *
 * Resolution order mirrors `findProjectFile()`:
 *   1. RVR_NO_PROJECT env var → disabled
 *   2. RVR_PROJECT env var → explicit path, fails closed if missing
 *   3. setProjectRootOverride() value (MCP client roots, launcher hints)
 *   4. process.cwd() walk-up
 *
 * Unlike `findProjectFile()`, this function *only* matches a directory —
 * it will not fall back to the legacy `.codexcli.json` single-file. Callers
 * that need to handle both old and new formats should check
 * `findProjectStoreDir()` first and fall back to `findProjectFile()`.
 */
export function findProjectStoreDir(): string | null {
  if (projectStoreDirCache !== null) {
    return projectStoreDirCache === '' ? null : projectStoreDirCache;
  }

  if (process.env.RVR_NO_PROJECT) {
    projectStoreDirCache = '';
    return null;
  }

  // Explicit env var override — path to a `.reverie` directory or its parent.
  const envPath = process.env.RVR_PROJECT;
  if (envPath) {
    const resolved = path.resolve(envPath);

    // Direct hit: resolved IS a `.reverie` directory
    if (fs.existsSync(resolved) && isDirectorySafe(resolved) && path.basename(resolved) === PROJECT_DIR_NAME) {
      projectStoreDirCache = resolved;
      return resolved;
    }

    // Direct hit: resolved IS a legacy `.codexcli` directory — migrate
    if (fs.existsSync(resolved) && isDirectorySafe(resolved) && path.basename(resolved) === LEGACY_PROJECT_DIR_NAME) {
      const parentDir = path.dirname(resolved);
      const newPath = path.join(parentDir, PROJECT_DIR_NAME);
      migrateLegacyProjectDir(resolved, newPath, parentDir);
      projectStoreDirCache = newPath;
      return newPath;
    }

    // Containing directory: look for `.reverie/` first, then legacy `.codexcli/`
    if (fs.existsSync(resolved) && isDirectorySafe(resolved)) {
      const reverieCandidate = path.join(resolved, PROJECT_DIR_NAME);
      if (fs.existsSync(reverieCandidate) && isDirectorySafe(reverieCandidate)) {
        projectStoreDirCache = reverieCandidate;
        return reverieCandidate;
      }
      const legacyCandidate = path.join(resolved, LEGACY_PROJECT_DIR_NAME);
      if (fs.existsSync(legacyCandidate) && isDirectorySafe(legacyCandidate)) {
        migrateLegacyProjectDir(legacyCandidate, reverieCandidate, resolved);
        projectStoreDirCache = reverieCandidate;
        return reverieCandidate;
      }
    }

    // RVR_PROJECT set but didn't resolve to a directory — fail closed,
    // matching findProjectFile()'s behavior.
    projectStoreDirCache = '';
    return null;
  }

  const globalDir = getDataDirectory();
  let dir = projectRootOverride ?? process.cwd();
  const root = path.parse(dir).root;

  while (true) {
    // Don't match anything inside the global data directory.
    if (path.resolve(dir) === path.resolve(globalDir)) {
      projectStoreDirCache = '';
      return null;
    }

    const reverieCandidate = path.join(dir, PROJECT_DIR_NAME);
    try {
      if (fs.existsSync(reverieCandidate) && fs.statSync(reverieCandidate).isDirectory()) {
        projectStoreDirCache = reverieCandidate;
        return reverieCandidate;
      }
    } catch {
      // stat failed — ignore and keep walking
    }

    const legacyCandidate = path.join(dir, LEGACY_PROJECT_DIR_NAME);
    try {
      if (fs.existsSync(legacyCandidate) && fs.statSync(legacyCandidate).isDirectory()) {
        migrateLegacyProjectDir(legacyCandidate, reverieCandidate, dir);
        projectStoreDirCache = reverieCandidate;
        return reverieCandidate;
      }
    } catch {
      // stat failed — ignore and keep walking
    }

    const parent = path.dirname(dir);
    if (parent === dir || dir === root) {
      projectStoreDirCache = '';
      return null;
    }
    dir = parent;
  }
}
