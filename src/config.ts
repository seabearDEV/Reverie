import fs from 'fs';
import { getConfigFilePath, ensureDataDirectoryExists } from './utils/paths';
import { atomicWriteFileSync } from './utils/atomicWrite';
import { withFileLock, STORE_LOCK_WAIT_MS } from './utils/fileLock';
import { debug } from './utils/debug';
import { DEFAULT_BOOTSTRAP_GIST_CHARS } from './utils/contextBudget';

// Define the type for configuration
interface Config {
  colors: boolean;
  theme: string;
  max_backups: number;
  import_max_bytes: number;
  bootstrap_max_response_bytes: number;
  bootstrap_gist_chars: number;
}

const VALID_THEMES = ['default', 'dark', 'light'] as const;
export const VALID_CONFIG_KEYS = ['colors', 'theme', 'max_backups', 'import_max_bytes', 'bootstrap_max_response_bytes', 'bootstrap_gist_chars'] as const;

// 50 MB — a generous ceiling for any realistic Reverie store. Real stores
// are KB-scale; this catches pathological inputs (misplaced heap dump,
// adversarial payload) before they OOM the process.
const DEFAULT_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

// 28 KB — reverie_context payload cap before demotion/shedding kicks in
// (#100, #212). Sized to the delivery channel, not the model: Claude Code's
// Bash tool inlines at most 30,000 characters of output (bashOutputMaxChars
// default) and saves anything larger to a file the model sees as a 2 KB
// preview — a bootstrap over that limit is persisted, not read. Bytes ≥
// chars, so 28 KB stays under the limit with headroom for the overhead
// estimate's slack. Token cost depends on content density: ~2.35 chars per
// token measured on an identifier-heavy store, ~4 on prose, so 28 KB ≈
// 7–12k tokens. The MCP persistence threshold is bracketed (19–50 KB), not
// measured; lower again if it lands under this. tier:"full" bypasses the
// cap; users opted in.
export const DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES = 28 * 1024;

// Index-line gist length (#188): characters of an entry's first line shown
// on the bootstrap front page before the "… [+N]" marker. The default lives
// in contextBudget.ts next to the gist function; re-exported for config
// consumers.
export { DEFAULT_BOOTSTRAP_GIST_CHARS };

// Default configuration
const defaultConfig: Config = {
  colors: true,
  theme: 'default',
  max_backups: 10,
  import_max_bytes: DEFAULT_IMPORT_MAX_BYTES,
  bootstrap_max_response_bytes: DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES,
  bootstrap_gist_chars: DEFAULT_BOOTSTRAP_GIST_CHARS,
};

// config.json holds only the settings the user changed (#213); every other
// setting is its current default, so a changed default reaches every install.
// CONFIG_FORMAT_KEY marks a file written that way; every write carries it. It
// is not a setting: loadConfig() never returns it.
export const CONFIG_FORMAT_KEY = '_format';
const SPARSE_FORMAT = 2;

// Every default a version before #213 wrote to config.json. Until #213 first
// run wrote the whole default config and every `config set` wrote the whole
// object back, so a file without the marker cannot tell a value the user
// chose from a default that was current when it was written. The one-time
// migration drops a stored value listed here. The list is closed: from #213
// on every write carries the marker and stores no default, so a later
// default change needs no entry. Literals, so that change cannot alter it.
export const SHIPPED_DEFAULTS: Readonly<Record<string, readonly unknown[]>> = {
  colors: [true],
  theme: ['default'],
  max_backups: [10],
  import_max_bytes: [50 * 1024 * 1024],
  bootstrap_max_response_bytes: [50 * 1024, 38 * 1024, 28 * 1024],
  bootstrap_gist_chars: [160],
  // Written only by the initial codexCLI commit (90394ed); 0.1.0 lists the
  // SQLite backend as removed. Not a setting any more, so dropping it is free.
  backend: ['json'],
};

type RawConfig = Record<string, unknown>;

/** config.json parses, but not to an object. (Invalid JSON throws SyntaxError.) */
class MalformedConfigError extends Error {}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';
}

/** The file's mtime, or null when it does not exist. */
function configMtime(configPath: string): number | null {
  try {
    return fs.statSync(configPath).mtimeMs;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** config.json as stored, or null when there is none. Throws when it does not hold a JSON object. */
function readRawConfig(configPath: string): RawConfig | null {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedConfigError(`${configPath} does not hold a JSON object`);
  }
  return parsed as RawConfig;
}

/** Written before #213: may hold defaults as explicit values. */
function isLegacyFile(raw: RawConfig): boolean {
  const format = raw[CONFIG_FORMAT_KEY];
  return typeof format !== 'number' || format < SPARSE_FORMAT;
}

/** Drop every stored value a shipped version wrote as its default. Returns how many it dropped. */
function dropShippedDefaults(raw: RawConfig): number {
  let dropped = 0;
  for (const [key, values] of Object.entries(SHIPPED_DEFAULTS)) {
    if (Object.hasOwn(raw, key) && values.includes(raw[key])) {
      delete raw[key];
      dropped++;
    }
  }
  return dropped;
}

/** Effective settings: each stored value that is valid, the default for the rest. */
function resolveConfig(raw: RawConfig): Config {
  const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
  return {
    colors: typeof raw.colors === 'boolean' ? raw.colors : defaultConfig.colors,
    theme: typeof raw.theme === 'string' ? raw.theme : defaultConfig.theme,
    max_backups: typeof raw.max_backups === 'number' ? raw.max_backups : defaultConfig.max_backups,
    import_max_bytes: typeof raw.import_max_bytes === 'number' && raw.import_max_bytes > 0
      ? raw.import_max_bytes
      : defaultConfig.import_max_bytes,
    bootstrap_max_response_bytes: typeof raw.bootstrap_max_response_bytes === 'number' && raw.bootstrap_max_response_bytes > 0
      ? raw.bootstrap_max_response_bytes
      : defaultConfig.bootstrap_max_response_bytes,
    bootstrap_gist_chars: positiveInt(raw.bootstrap_gist_chars) ? raw.bootstrap_gist_chars : defaultConfig.bootstrap_gist_chars,
  };
}

/** What config.json stores for these settings: the format marker and each setting that differs from its default. */
function toSparse(config: Config): RawConfig {
  const out: RawConfig = { [CONFIG_FORMAT_KEY]: SPARSE_FORMAT };
  for (const key of VALID_CONFIG_KEYS) {
    if (config[key] !== defaultConfig[key]) out[key] = config[key];
  }
  return out;
}

// Mtime-based cache for config
let configCache: Config | null = null;
let configCacheMtime: number | null = null;

export function clearConfigCache(): void {
  configCache = null;
  configCacheMtime = null;
}

/** Write the sparse form of `config`. Call under the config lock. */
function writeConfigFile(configPath: string, config: Config): void {
  atomicWriteFileSync(configPath, JSON.stringify(toSparse(config), null, 2));
  configCache = { ...config };
  configCacheMtime = fs.statSync(configPath).mtimeMs;
}

/**
 * The one-time migration's write: under the lock, re-read the file and, if it
 * is still a legacy file with a shipped default in it, rewrite it sparse.
 * Another process may have migrated it, or set a value, since our read.
 * Best effort: a busy lock or a read-only directory leaves the file for the
 * next load, and the caller uses the settings it migrated in memory.
 */
function migrateConfigFile(configPath: string): Config | null {
  try {
    // Default lock wait: a read never stalls on a busy lock.
    return withFileLock(configPath, () => {
      const raw = readRawConfig(configPath);
      if (raw === null || !isLegacyFile(raw) || dropShippedDefaults(raw) === 0) return null;
      const config = resolveConfig(raw);
      writeConfigFile(configPath, config);
      return config;
    });
  } catch (err) {
    debug(`config.json migration skipped: ${String(err)}`);
    return null;
  }
}

// Load configuration
export function loadConfig(): Config {
  try {
    const configPath = getConfigFilePath();

    // Fast path: check cache via mtime before hitting the filesystem
    if (configCache !== null && configCacheMtime !== null) {
      try {
        if (fs.statSync(configPath).mtimeMs === configCacheMtime) {
          // Defensive shallow copy: callers may mutate the returned object.
          // Returning the cached object directly would let those mutations
          // leak into the cache and contaminate other in-process readers
          // until the next mtime-triggered re-read. Same hazard PR #58 fixed
          // for sidecar caches in directoryStore.ts.
          return { ...configCache };
        }
      } catch {
        // File was removed; invalidate cache and fall through
        configCache = null;
        configCacheMtime = null;
      }
    }

    let currentMtime = configMtime(configPath);
    if (currentMtime === null) {
      // First run. Create the data directory, as the first-run save did: the
      // audit and telemetry logs need it, and creating it moves a legacy
      // ~/.codexcli into place, config.json with it. But write no config.json
      // (#213) — a stored default would stop a later default change reaching
      // this install. Every setting is its default.
      try {
        ensureDataDirectoryExists();
      } catch (err) {
        debug(`data directory not created: ${String(err)}`);
      }
      currentMtime = configMtime(configPath);
      if (currentMtime === null) return { ...defaultConfig };
    }
    const raw = readRawConfig(configPath);
    if (raw === null) return { ...defaultConfig };

    if (isLegacyFile(raw) && dropShippedDefaults(raw) > 0) {
      const migrated = migrateConfigFile(configPath);
      if (migrated) return { ...migrated };
    }

    const result = resolveConfig(raw);
    configCache = result;
    configCacheMtime = currentMtime;

    // Defensive shallow copy on the freshly-built result for the same
    // reason as the cached path above.
    return { ...result };
  } catch (error) {
    console.error('Error loading configuration:', error);
    return { ...defaultConfig };
  }
}

/**
 * Change settings as one transaction under the config lock: read the file
 * as it stands, apply `change` to the effective settings, write the sparse
 * result. A concurrent `config set` of another key is never lost, and an
 * earlier loadConfig() snapshot is never written back. A legacy file is
 * migrated in the same write. Nothing is written when the stored form does
 * not change, and no file is created to hold nothing.
 */
function updateConfig(change: (config: Config) => void): void {
  ensureDataDirectoryExists();
  const configPath = getConfigFilePath();
  withFileLock(configPath, () => {
    let raw: RawConfig | null;
    try {
      raw = readRawConfig(configPath);
    } catch (err) {
      if (!(err instanceof SyntaxError) && !(err instanceof MalformedConfigError)) throw err;
      // As before #213: a file that does not parse is replaced.
      console.error('Error loading configuration:', err);
      raw = {};
    }
    const existed = raw !== null;
    const stored = raw ?? {};
    const before = JSON.stringify(stored);
    if (isLegacyFile(stored)) dropShippedDefaults(stored);
    const config = resolveConfig(stored);
    change(config);
    const sparse = toSparse(config);
    if (!existed && Object.keys(sparse).length === 1) return;
    if (existed && JSON.stringify(sparse) === before) return;
    writeConfigFile(configPath, config);
  }, STORE_LOCK_WAIT_MS);
}

// Save configuration: the sparse form of `config`, under the config lock.
// Failures propagate — a write that did not happen must not report success.
export function saveConfig(config: Config): void {
  ensureDataDirectoryExists();
  const configPath = getConfigFilePath();
  withFileLock(configPath, () => { writeConfigFile(configPath, config); }, STORE_LOCK_WAIT_MS);
}

function isConfigKey(key: string): key is keyof Config {
  return (VALID_CONFIG_KEYS as readonly string[]).includes(key);
}

// Get a specific configuration setting (its effective value)
export function getConfigSetting(key: string): string | boolean | number | null {
  const config = loadConfig();
  if (isConfigKey(key)) {
    return config[key];
  }
  console.error(`Unknown configuration key: ${key}`);
  return null;
}

// Set a specific configuration setting. A value equal to the default is not
// stored (#213): the setting follows the default, as after `config unset`.
export function setConfigSetting(key: string, value: string | boolean): void {
  let next: Partial<Config>;
  if (key === 'colors') {
    next = { colors: typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true' || value === '1' };
  } else if (key === 'theme') {
    const val = String(value);
    if (!(VALID_THEMES as readonly string[]).includes(val)) {
      console.error(`Invalid theme: '${val}'. Must be one of: ${VALID_THEMES.join(', ')}`);
      return;
    }
    next = { theme: val };
  } else if (key === 'max_backups') {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
      console.error(`Invalid max_backups: '${value}'. Must be a non-negative integer (0 to disable rotation).`);
      return;
    }
    next = { max_backups: num };
  } else if (key === 'import_max_bytes') {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      console.error(`Invalid import_max_bytes: '${value}'. Must be a positive integer (bytes).`);
      return;
    }
    next = { import_max_bytes: num };
  } else if (key === 'bootstrap_max_response_bytes') {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      console.error(`Invalid bootstrap_max_response_bytes: '${value}'. Must be a positive integer (bytes).`);
      return;
    }
    next = { bootstrap_max_response_bytes: num };
  } else if (key === 'bootstrap_gist_chars') {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      console.error(`Invalid bootstrap_gist_chars: '${value}'. Must be a positive integer (characters).`);
      return;
    }
    next = { bootstrap_gist_chars: num };
  } else {
    console.error(`Unknown configuration key: ${key}`);
    return;
  }
  updateConfig((config) => { Object.assign(config, next); });
}

/**
 * Return a setting to its default by removing it from config.json (#213):
 * it then follows the default, including later changes to it. Returns false
 * for an unknown key.
 */
export function unsetConfigSetting(key: string): boolean {
  if (!isConfigKey(key)) {
    console.error(`Unknown configuration key: ${key}`);
    return false;
  }
  updateConfig((config) => { Object.assign(config, { [key]: defaultConfig[key] }); });
  return true;
}
