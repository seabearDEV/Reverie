import path from 'path';
import os from 'os';
import * as fs from 'fs';
import { getBinaryName } from './binaryName';

/**
 * Determines if the application is running in development mode
 */
function isDev(): boolean {
  return process.env.NODE_ENV === 'development' ||
         getBinaryName() === 'cclid' ||
         Boolean(process.argv[1]?.includes('ts-node')) ||
         Boolean(process.env.npm_lifecycle_script?.includes('ts-node'));
}

// Add caching for path resolution
let dataDirectoryCache: string | null = null;
let dataDirEnsured = false;
let dataDirWritabilityWarned = false;

/**
 * Get the directory where data files should be stored.
 *
 * Resolution order:
 *   1. `CODEX_DATA_DIR` env var (must be a non-empty absolute path)
 *   2. Dev mode: `<repo>/data`
 *   3. Production: `~/.codexcli`
 *
 * Validation: when `CODEX_DATA_DIR` is set, it must be an absolute path.
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

  const fromEnv = process.env.CODEX_DATA_DIR;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!path.isAbsolute(fromEnv)) {
      throw new Error(
        `CODEX_DATA_DIR must be an absolute path. Got: ${JSON.stringify(fromEnv)}. ` +
        `Relative paths are rejected because the resolved location would depend on ` +
        `process.cwd() at first call.`
      );
    }
    dataDirectoryCache = fromEnv;
  } else if (isDev()) {
    dataDirectoryCache = path.join(path.resolve(__dirname, '..', '..'), 'data');
  } else {
    dataDirectoryCache = path.join(os.homedir(), '.codexcli');
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
        `codexCLI may fail to save changes.\n`
      );
    }
    dataDirWritabilityWarned = true;
  }

  return dataDirectoryCache;
}

/**
 * True if `CODEX_DATA_DIR` is set to a non-empty value. Used by `ccli info`
 * (and tests) to label the data path with its source.
 */
export function isDataDirectoryFromEnv(): boolean {
  const fromEnv = process.env.CODEX_DATA_DIR;
  return fromEnv !== undefined && fromEnv !== '';
}

/**
 * Reset the cached data directory and related one-shot flags. After this
 * call, the next `getDataDirectory()` re-reads `CODEX_DATA_DIR` and may
 * re-emit the writability warning. Mirrors `clearProjectFileCache()`.
 * Primarily used by tests; production code has no reason to call this.
 */
export function clearDataDirectoryCache(): void {
  dataDirectoryCache = null;
  dataDirEnsured = false;
  dataDirWritabilityWarned = false;
}

/**
 * Ensures data directory exists
 * Creates it if it doesn't exist
 *
 * @returns {string} Path to the data directory
 */
export function ensureDataDirectoryExists(): string {
  const dataDir = getDataDirectory();

  if (!dataDirEnsured) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
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
 * starts from an absolute directory. Without this, a `CODEX_PROJECT_DIR=.` /
 * `--cwd .` launcher hint would yield a relative `.codexcli` from the
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
 *  - `codexNoProject`: CODEX_NO_PROJECT env var was set (resolution short-circuits).
 *  - `codexProject`: value of CODEX_PROJECT if set, else undefined.
 *  - `codexProjectFailed`: CODEX_PROJECT was set but did not resolve to a
 *    `.codexcli/` directory or `.codexcli.json` file.
 *  - `rootOverride`: programmatic override value if set, else undefined.
 *  - `startedFrom`: directory the walk-up started from (override or cwd).
 *    Empty string when the walk did not run (e.g. CODEX_NO_PROJECT short-circuit
 *    or CODEX_PROJECT failure).
 *  - `walkReachedRoot`: walk-up exhausted the filesystem without finding a
 *    project store (stopped at the true filesystem root `/`).
 *  - `walkStoppedAtGlobalDir`: walk-up was stopped early because it reached
 *    the codex global data directory before finding a project store.
 */
export interface ResolverDiagnostic {
  codexNoProject: boolean;
  codexProject: string | undefined;
  codexProjectFailed: boolean;
  rootOverride: string | undefined;
  startedFrom: string;
  walkReachedRoot: boolean;
  walkStoppedAtGlobalDir: boolean;
}

/**
 * Internal: shared resolver body for `findProjectFile()` and
 * `findProjectFileWithDiagnostic()`. Always returns both the resolved path
 * (or null) and a diagnostic record describing which branches fired. Does
 * not consult or populate the cache — callers handle caching.
 */
function resolveProjectFile(): { path: string | null; diagnostic: ResolverDiagnostic } {
  const codexNoProject = Boolean(process.env.CODEX_NO_PROJECT);
  const envPath = process.env.CODEX_PROJECT;
  const codexProject = envPath !== undefined && envPath !== '' ? envPath : undefined;
  const rootOverride = projectRootOverride ?? undefined;

  const diagnostic: ResolverDiagnostic = {
    codexNoProject,
    codexProject,
    codexProjectFailed: false,
    rootOverride,
    startedFrom: '',
    walkReachedRoot: false,
    walkStoppedAtGlobalDir: false,
  };

  // 1. CODEX_NO_PROJECT short-circuit
  if (codexNoProject) {
    return { path: null, diagnostic };
  }

  // 2. CODEX_PROJECT explicit path
  if (codexProject !== undefined) {
    const resolved = path.resolve(codexProject);
    // Direct hit: resolved IS a .codexcli directory
    try {
      if (
        fs.existsSync(resolved) &&
        fs.statSync(resolved).isDirectory() &&
        path.basename(resolved) === '.codexcli'
      ) {
        return { path: resolved, diagnostic };
      }
    } catch { /* fall through */ }

    // Direct hit: resolved IS a .codexcli.json file
    if (fs.existsSync(resolved) && !isDirectorySafe(resolved)) {
      return { path: resolved, diagnostic };
    }

    // Containing directory: look for .codexcli/ or .codexcli.json inside it
    if (fs.existsSync(resolved) && isDirectorySafe(resolved)) {
      const dirCandidate = path.join(resolved, '.codexcli');
      if (fs.existsSync(dirCandidate) && isDirectorySafe(dirCandidate)) {
        return { path: dirCandidate, diagnostic };
      }
      const fileCandidate = path.join(resolved, '.codexcli.json');
      if (fs.existsSync(fileCandidate)) {
        return { path: fileCandidate, diagnostic };
      }
    }

    // Env var was set but didn't resolve — treat as "no project" rather than
    // silently falling back to a different directory the user didn't ask for.
    diagnostic.codexProjectFailed = true;
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

    // Prefer the new `.codexcli/` directory over the legacy `.codexcli.json` file.
    const dirCandidate = path.join(dir, '.codexcli');
    if (fs.existsSync(dirCandidate) && isDirectorySafe(dirCandidate)) {
      return { path: dirCandidate, diagnostic };
    }

    const fileCandidate = path.join(dir, '.codexcli.json');
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
 * Walk up from cwd to find the project store. As of v1.10.0, this prefers
 * a `.codexcli/` directory (new format) over a `.codexcli.json` file
 * (legacy format). Returns the absolute path if either is found, null
 * otherwise.
 *
 * Resolution order:
 *   1. CODEX_NO_PROJECT env var → disabled (returns null)
 *   2. CODEX_PROJECT env var → explicit path to a `.codexcli` directory,
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
 * Walk up from cwd (or the programmatic override) to find a `.codexcli/`
 * directory, which is the v1.10.0 project store. Returns the absolute path
 * if found, null otherwise.
 *
 * Resolution order mirrors `findProjectFile()`:
 *   1. CODEX_NO_PROJECT env var → disabled
 *   2. CODEX_PROJECT env var → explicit path, fails closed if missing
 *   3. setProjectRootOverride() value (MCP client roots, launcher hints)
 *   4. process.cwd() walk-up
 *
 * Unlike `findProjectFile()`, this function *only* matches a directory
 * named `.codexcli` — it will not fall back to the legacy `.codexcli.json`
 * file. Callers that need to handle both old and new formats should check
 * `findProjectStoreDir()` first and fall back to `findProjectFile()`.
 */
export function findProjectStoreDir(): string | null {
  if (projectStoreDirCache !== null) {
    return projectStoreDirCache === '' ? null : projectStoreDirCache;
  }

  if (process.env.CODEX_NO_PROJECT) {
    projectStoreDirCache = '';
    return null;
  }

  // Explicit env var override — path to a `.codexcli` directory or its parent.
  const envPath = process.env.CODEX_PROJECT;
  if (envPath) {
    const resolved = path.resolve(envPath);
    let candidate = resolved;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        // If the resolved path IS `.codexcli`, use it directly; otherwise
        // look for `.codexcli` inside it.
        if (path.basename(resolved) !== '.codexcli') {
          candidate = path.join(resolved, '.codexcli');
        }
      }
    } catch {
      // fall through; isDirectory check below will handle it
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      projectStoreDirCache = candidate;
      return candidate;
    }
    // CODEX_PROJECT set but didn't resolve to a directory — fail closed,
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

    const candidate = path.join(dir, '.codexcli');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        projectStoreDirCache = candidate;
        return candidate;
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