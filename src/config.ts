import fs from 'fs';
import { getConfigFilePath, ensureDataDirectoryExists } from './utils/paths';
import { atomicWriteFileSync } from './utils/atomicWrite';
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

// Budget defaults that loadConfig itself persisted on first run — 50KB
// through v1.1.x, 38KB through v1.3.0. Every install from before #212
// carries one of them as an explicit value in config.json, so a changed
// default would never reach it (the 1.2.0 50KB→38KB change didn't: stores
// created under 1.0/1.1 kept running at 51200). Treat them as unset and
// apply the current default. Side effect: these two exact values can't be
// chosen explicitly — setConfigSetting warns; pick a neighbouring value.
const LEGACY_PERSISTED_BUDGET_DEFAULTS: ReadonlySet<number> = new Set([50 * 1024, 38 * 1024]);

function resolveBudgetSetting(raw: unknown): number {
  if (typeof raw !== 'number' || raw <= 0) return DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES;
  if (LEGACY_PERSISTED_BUDGET_DEFAULTS.has(raw)) return DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES;
  return raw;
}

// Default configuration
const defaultConfig: Config = {
  colors: true,
  theme: 'default',
  max_backups: 10,
  import_max_bytes: DEFAULT_IMPORT_MAX_BYTES,
  bootstrap_max_response_bytes: DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES,
  bootstrap_gist_chars: DEFAULT_BOOTSTRAP_GIST_CHARS,
};

// Mtime-based cache for config
let configCache: Config | null = null;
let configCacheMtime: number | null = null;

export function clearConfigCache(): void {
  configCache = null;
  configCacheMtime = null;
}

// Load configuration
export function loadConfig(): Config {
  try {
    const configPath = getConfigFilePath();

    // Fast path: check cache via mtime before hitting the filesystem
    if (configCache !== null && configCacheMtime !== null) {
      try {
        if (fs.statSync(configPath).mtimeMs === configCacheMtime) {
          // Defensive shallow copy: setConfigSetting() and friends call
          // loadConfig(), mutate the returned object in place, then call
          // saveConfig() with the mutated reference. Returning the cached
          // object directly would let those mutations leak into the cache
          // and contaminate other in-process readers between the mutation
          // and the next mtime-triggered re-read. Same hazard PR #58 fixed
          // for sidecar caches in directoryStore.ts.
          return { ...configCache };
        }
      } catch {
        // File was removed; invalidate cache and fall through
        configCache = null;
        configCacheMtime = null;
      }
    }

    const currentMtime = fs.statSync(configPath).mtimeMs;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;

    // Ensure all required fields exist (handles migrating from old config)
    const result: Config = {
      colors: typeof config.colors === 'boolean' ? config.colors : defaultConfig.colors,
      theme: typeof config.theme === 'string' ? config.theme : defaultConfig.theme,
      max_backups: typeof config.max_backups === 'number' ? config.max_backups : defaultConfig.max_backups,
      import_max_bytes: typeof config.import_max_bytes === 'number' && config.import_max_bytes > 0
        ? config.import_max_bytes
        : defaultConfig.import_max_bytes,
      bootstrap_max_response_bytes: resolveBudgetSetting(config.bootstrap_max_response_bytes),
      bootstrap_gist_chars: typeof config.bootstrap_gist_chars === 'number' && Number.isInteger(config.bootstrap_gist_chars) && config.bootstrap_gist_chars > 0
        ? config.bootstrap_gist_chars
        : defaultConfig.bootstrap_gist_chars,
    };

    configCache = result;
    configCacheMtime = currentMtime;

    // Defensive shallow copy on the freshly-built result for the same
    // reason as the cached path above.
    return { ...result };
  } catch (error) {
    // File doesn't exist — create with defaults
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT') {
      saveConfig(defaultConfig);
      return { ...defaultConfig };
    }
    console.error('Error loading configuration:', error);
    return { ...defaultConfig };
  }
}

// Save configuration
export function saveConfig(config: Config): void {
  try {
    ensureDataDirectoryExists();
    const configPath = getConfigFilePath();
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));
    const mtime = fs.statSync(configPath).mtimeMs;
    configCache = { ...config };
    configCacheMtime = mtime;
  } catch (error) {
    console.error('Error saving configuration:', error);
  }
}

// Get a specific configuration setting
export function getConfigSetting(key: string): string | boolean | number | null {
  const config = loadConfig();
  if ((VALID_CONFIG_KEYS as readonly string[]).includes(key)) {
    return config[key as keyof Config];
  }
  console.error(`Unknown configuration key: ${key}`);
  return null;
}

// Set a specific configuration setting
export function setConfigSetting(key: string, value: string | boolean): void {
  const config = loadConfig();
  if (key === 'colors') {
    config.colors = typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true' || value === '1';
    saveConfig(config);
  } else if (key === 'theme') {
    const val = String(value);
    if (!(VALID_THEMES as readonly string[]).includes(val)) {
      console.error(`Invalid theme: '${val}'. Must be one of: ${VALID_THEMES.join(', ')}`);
      return;
    }
    config.theme = val;
    saveConfig(config);
  } else if (key === 'max_backups') {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
      console.error(`Invalid max_backups: '${value}'. Must be a non-negative integer (0 to disable rotation).`);
      return;
    }
    config.max_backups = num;
    saveConfig(config);
  } else if (key === 'import_max_bytes') {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      console.error(`Invalid import_max_bytes: '${value}'. Must be a positive integer (bytes).`);
      return;
    }
    config.import_max_bytes = num;
    saveConfig(config);
  } else if (key === 'bootstrap_max_response_bytes') {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      console.error(`Invalid bootstrap_max_response_bytes: '${value}'. Must be a positive integer (bytes).`);
      return;
    }
    if (LEGACY_PERSISTED_BUDGET_DEFAULTS.has(num)) {
      console.error(`Note: ${num} is a former default that older versions wrote to config.json; it is treated as unset (effective: ${DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES}). Pick a neighbouring value to pin it.`);
    }
    config.bootstrap_max_response_bytes = num;
    saveConfig(config);
  } else if (key === 'bootstrap_gist_chars') {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      console.error(`Invalid bootstrap_gist_chars: '${value}'. Must be a positive integer (characters).`);
      return;
    }
    config.bootstrap_gist_chars = num;
    saveConfig(config);
  } else {
    console.error(`Unknown configuration key: ${key}`);
  }
}
