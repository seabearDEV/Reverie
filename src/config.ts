import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfigFilePath, ensureDataDirectoryExists } from './utils/paths';
import { atomicWriteFileSync } from './utils/atomicWrite';
import { withFileLock, STORE_LOCK_WAIT_MS } from './utils/fileLock';
import { debug } from './utils/debug';
import { getBinaryName } from './utils/binaryName';
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
// is not a setting: loadConfig() never returns it. Whether this install has
// migrated is recorded beside the file (MIGRATION_RECORD_FILE, below).
export const CONFIG_FORMAT_KEY = '_format';
const SPARSE_FORMAT = 2;

// Every default a version before #213 wrote to config.json. Until #213 first
// run wrote the whole default config and every `config set` wrote the whole
// object back, so a file without the marker cannot tell a value the user
// chose from a default that was current when it was written. Until this
// install's first write with #213, a read drops a stored value listed here in
// memory and that write persists it. The list is closed: from #213
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

function isUnparseable(err: unknown): boolean {
  return err instanceof SyntaxError || err instanceof MalformedConfigError;
}

function describeUnparseable(err: unknown): string {
  return err instanceof MalformedConfigError ? 'does not hold a JSON object' : 'is not valid JSON';
}

/**
 * config.json does not parse. A write would replace every setting it holds,
 * so set and unset refuse (#213) and leave the file as it is.
 */
class ConfigUnreadableError extends Error {
  constructor(configPath: string, cause: unknown) {
    super(`${configPath} ${describeUnparseable(cause)}, so nothing was written. Fix or remove the file, then retry.`, { cause });
    this.name = 'ConfigUnreadableError';
  }
}

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

interface StoredConfig { raw: RawConfig; text: string }

/** config.json as stored, or null when there is none. Throws when it does not hold a JSON object. */
function readStoredConfig(configPath: string): StoredConfig | null {
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
  return { raw: parsed as RawConfig, text };
}

/** No marker: written before #213, or rewritten since by a version before it. */
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

// The migration record (#213): a file beside config.json that versions before
// #213 never touch. They rewrite config.json whole and drop keys they do not
// know, the marker included, so the marker alone cannot say whether this
// install has migrated. The first write by a version with #213 creates it.
// From then on no value is dropped again: a file without the marker was
// rewritten by an older Reverie still running (an MCP server started before
// the upgrade, say), and its values — the user's choices among them — are kept
// as set. A stale default kept is the price; a deliberate choice is never lost.
export const MIGRATION_RECORD_FILE = 'config.format';

interface MigrationRecord { format: number; olderRewriteSeen?: string }

function migrationRecordPath(configPath: string): string {
  return path.join(path.dirname(configPath), MIGRATION_RECORD_FILE);
}

function hasMigrationRecord(configPath: string): boolean {
  return fs.existsSync(migrationRecordPath(configPath));
}

function readMigrationRecord(configPath: string): MigrationRecord {
  const record: MigrationRecord = { format: SPARSE_FORMAT };
  try {
    const parsed = JSON.parse(fs.readFileSync(migrationRecordPath(configPath), 'utf8')) as unknown;
    const seen = parsed && typeof parsed === 'object' ? (parsed as { olderRewriteSeen?: unknown }).olderRewriteSeen : undefined;
    if (typeof seen === 'string') record.olderRewriteSeen = seen;
  } catch { /* present but unreadable: still a record */ }
  return record;
}

function writeMigrationRecord(configPath: string, record: MigrationRecord): void {
  atomicWriteFileSync(migrationRecordPath(configPath), JSON.stringify(record, null, 2));
}

/**
 * An older Reverie rewrote config.json after this install migrated. Its
 * values are kept as set; say so once per rewrite, remembered in the record.
 */
function noteOlderRewrite(configPath: string, text: string): void {
  const seen = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  const record = readMigrationRecord(configPath);
  if (record.olderRewriteSeen === seen) return;
  console.error(`Note: ${configPath} was rewritten by an older Reverie; values equal to an old default are kept as set. \`${getBinaryName()} config unset <key>\` returns one to its default.`);
  try {
    writeMigrationRecord(configPath, { ...record, olderRewriteSeen: seen });
  } catch (err) {
    debug(`migration record not updated: ${String(err)}`);
  }
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
// The last read warning printed, so a broken file is reported once per
// process, not on each of the several reads a command makes.
let lastReadWarning: string | null = null;

export function clearConfigCache(): void {
  configCache = null;
  configCacheMtime = null;
  lastReadWarning = null;
}

/** Write the sparse form of `config`. Call under the config lock. */
function writeConfigFile(configPath: string, config: Config): void {
  atomicWriteFileSync(configPath, JSON.stringify(toSparse(config), null, 2));
  configCache = { ...config };
  configCacheMtime = fs.statSync(configPath).mtimeMs;
}

/**
 * Load configuration: the effective value of every setting. A read never
 * writes config.json (#213) — a legacy file's shipped defaults are dropped in
 * memory, and the next write persists that.
 */
export function loadConfig(): Config {
  let configPath = 'config.json';
  try {
    configPath = getConfigFilePath();

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
    const stored = readStoredConfig(configPath);
    if (stored === null) return { ...defaultConfig };

    const raw = stored.raw;
    if (isLegacyFile(raw)) {
      if (hasMigrationRecord(configPath)) noteOlderRewrite(configPath, stored.text);
      else dropShippedDefaults(raw);
    }

    const result = resolveConfig(raw);
    configCache = result;
    configCacheMtime = currentMtime;

    // Defensive shallow copy on the freshly-built result for the same
    // reason as the cached path above.
    return { ...result };
  } catch (error) {
    // One line, once: every command reads the config, and the defaults serve.
    const why = isUnparseable(error) ? describeUnparseable(error) : `could not be read (${error instanceof Error ? error.message : String(error)})`;
    const warning = `Warning: ${configPath} ${why}; using the default settings.`;
    if (warning !== lastReadWarning) {
      lastReadWarning = warning;
      console.error(warning);
    }
    return { ...defaultConfig };
  }
}

/**
 * Change settings as one transaction under the config lock: read the file
 * as it stands, apply `change` to the effective settings, write the sparse
 * result. A concurrent `config set` of another key is never lost, and an
 * earlier loadConfig() snapshot is never written back. Before this install's
 * first write the file's shipped defaults are dropped in the same write, and
 * the migration record is created after it. Nothing is written when the
 * stored form does not change, and no file is created to hold nothing. A
 * file that does not parse is refused, not replaced.
 */
function updateConfig(change: (config: Config) => void): void {
  ensureDataDirectoryExists();
  const configPath = getConfigFilePath();
  withFileLock(configPath, () => {
    let stored: StoredConfig | null;
    try {
      stored = readStoredConfig(configPath);
    } catch (err) {
      if (isUnparseable(err)) throw new ConfigUnreadableError(configPath, err);
      throw err;
    }
    const recorded = hasMigrationRecord(configPath);
    const raw = stored?.raw ?? {};
    const before = JSON.stringify(raw);
    if (isLegacyFile(raw) && !recorded) dropShippedDefaults(raw);
    const config = resolveConfig(raw);
    change(config);
    const sparse = toSparse(config);
    const unchanged = stored === null ? Object.keys(sparse).length === 1 : JSON.stringify(sparse) === before;
    if (!unchanged) writeConfigFile(configPath, config);
    // After config.json: a crash between the two leaves a marked file, which
    // no read or write drops values from.
    if (!recorded && (stored !== null || !unchanged)) writeMigrationRecord(configPath, { format: SPARSE_FORMAT });
  }, STORE_LOCK_WAIT_MS);
}

// Save configuration: the sparse form of `config`, under the config lock.
// Failures propagate — a write that did not happen must not report success.
export function saveConfig(config: Config): void {
  ensureDataDirectoryExists();
  const configPath = getConfigFilePath();
  withFileLock(configPath, () => {
    writeConfigFile(configPath, config);
    if (!hasMigrationRecord(configPath)) writeMigrationRecord(configPath, { format: SPARSE_FORMAT });
  }, STORE_LOCK_WAIT_MS);
}

function isConfigKey(key: string): key is keyof Config {
  return (VALID_CONFIG_KEYS as readonly string[]).includes(key);
}

/** A refused change: nothing was written. `code` is the envelope error code. */
export type ConfigChangeResult = { ok: true } | { ok: false; code: 'INVALID_INPUT' | 'NOT_FOUND'; message: string };

const unknownKey = (key: string): ConfigChangeResult =>
  ({ ok: false, code: 'NOT_FOUND', message: `Unknown configuration key: ${key}` });
const invalid = (message: string): ConfigChangeResult => ({ ok: false, code: 'INVALID_INPUT', message });

// Get a specific configuration setting (its effective value)
export function getConfigSetting(key: string): string | boolean | number | null {
  const config = loadConfig();
  if (isConfigKey(key)) {
    return config[key];
  }
  console.error(`Unknown configuration key: ${key}`);
  return null;
}

/**
 * Set a configuration setting. A value equal to the default is not stored
 * (#213): the setting follows the default, as after `config unset`. A
 * rejected key or value writes nothing and says why (#273); the caller
 * reports it. Write failures throw.
 */
export function setConfigSetting(key: string, value: string | boolean): ConfigChangeResult {
  let next: Partial<Config>;
  if (key === 'colors') {
    next = { colors: typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true' || value === '1' };
  } else if (key === 'theme') {
    const val = String(value);
    if (!(VALID_THEMES as readonly string[]).includes(val)) {
      return invalid(`Invalid theme: '${val}'. Must be one of: ${VALID_THEMES.join(', ')}`);
    }
    next = { theme: val };
  } else if (key === 'max_backups') {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
      return invalid(`Invalid max_backups: '${value}'. Must be a non-negative integer (0 to disable rotation).`);
    }
    next = { max_backups: num };
  } else if (key === 'import_max_bytes') {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      return invalid(`Invalid import_max_bytes: '${value}'. Must be a positive integer (bytes).`);
    }
    next = { import_max_bytes: num };
  } else if (key === 'bootstrap_max_response_bytes') {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      return invalid(`Invalid bootstrap_max_response_bytes: '${value}'. Must be a positive integer (bytes).`);
    }
    next = { bootstrap_max_response_bytes: num };
  } else if (key === 'bootstrap_gist_chars') {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      return invalid(`Invalid bootstrap_gist_chars: '${value}'. Must be a positive integer (characters).`);
    }
    next = { bootstrap_gist_chars: num };
  } else {
    return unknownKey(key);
  }
  updateConfig((config) => { Object.assign(config, next); });
  return { ok: true };
}

/**
 * Return a setting to its default by removing it from config.json (#213):
 * it then follows the default, including later changes to it. An unknown
 * key writes nothing. Write failures throw.
 */
export function unsetConfigSetting(key: string): ConfigChangeResult {
  if (!isConfigKey(key)) return unknownKey(key);
  updateConfig((config) => { Object.assign(config, { [key]: defaultConfig[key] }); });
  return { ok: true };
}
