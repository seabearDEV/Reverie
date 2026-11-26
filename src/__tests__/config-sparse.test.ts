/**
 * #213: config.json holds only what the user set.
 *
 * First run writes nothing, a save writes only settings that differ from the
 * current default, and a one-time migration drops the defaults that shipped
 * versions persisted as explicit values. Real files in a temp RVR_DATA_DIR.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearDataDirectoryCache } from '../utils/paths';
import {
  loadConfig, saveConfig, getConfigSetting, setConfigSetting, unsetConfigSetting,
  clearConfigCache, SHIPPED_DEFAULTS, VALID_CONFIG_KEYS, CONFIG_FORMAT_KEY,
} from '../config';

let dir = '';
let configPath = '';
const saved = process.env.RVR_DATA_DIR;
const originalError = console.error;

const DEFAULTS = {
  colors: true,
  theme: 'default',
  max_backups: 10,
  import_max_bytes: 52428800,
  bootstrap_max_response_bytes: 28672,
  bootstrap_gist_chars: 160,
};

const writeFile = (obj: unknown) => fs.writeFileSync(configPath, JSON.stringify(obj, null, 2));
const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
/** What a fresh process reads. */
const fresh = () => { clearConfigCache(); return loadConfig(); };

/** Count atomic writes that land on config.json. */
function countConfigWrites(): { readonly count: number } {
  const real = fs.renameSync.bind(fs);
  const counter = { count: 0 };
  vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === configPath) counter.count++;
    real(from, to);
  }) as typeof fs.renameSync);
  return counter;
}

/**
 * Another process writes config.json just before this one takes the config
 * lock (the lock is free then, as it would be for a real second process).
 */
function otherProcessWritesBeforeLock(write: () => void): void {
  const lockPath = configPath + '.lock';
  const realOpen = fs.openSync.bind(fs);
  let done = false;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (!done && String(p) === lockPath) {
      done = true;
      write();
    }
    return (realOpen as (...args: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-213-'));
  configPath = path.join(dir, 'config.json');
  process.env.RVR_DATA_DIR = dir;
  clearDataDirectoryCache();
  clearConfigCache();
  console.error = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  console.error = originalError;
  if (saved === undefined) delete process.env.RVR_DATA_DIR; else process.env.RVR_DATA_DIR = saved;
  clearDataDirectoryCache();
  clearConfigCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('#213: first run writes nothing', () => {
  it('loadConfig and getConfigSetting return the defaults and leave no config.json', () => {
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(getConfigSetting('bootstrap_max_response_bytes')).toBe(28672);
    expect(getConfigSetting('bootstrap_gist_chars')).toBe(160);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('creates a missing data directory, as before, but no config.json in it', () => {
    const nested = path.join(dir, 'not-yet');
    process.env.RVR_DATA_DIR = nested;
    clearDataDirectoryCache();
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(fs.statSync(nested).isDirectory()).toBe(true);
    expect(fs.readdirSync(nested)).toEqual([]);
  });

  it('setting a value equal to the default on a fresh install creates no file', () => {
    setConfigSetting('colors', 'true');
    setConfigSetting('bootstrap_max_response_bytes', '28672');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(loadConfig()).toEqual(DEFAULTS);
  });
});

describe('#213: a save stores only what differs from the default', () => {
  it('config set writes the changed key and the format marker, nothing else', () => {
    setConfigSetting('theme', 'dark');
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, theme: 'dark' });
  });

  it('setting a key back to its default removes it from the file', () => {
    setConfigSetting('theme', 'dark');
    setConfigSetting('max_backups', '3');
    setConfigSetting('theme', 'default');
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, max_backups: 3 });
  });

  it('saveConfig given the whole config writes only the non-defaults', () => {
    saveConfig({ ...DEFAULTS, bootstrap_gist_chars: 120 });
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, bootstrap_gist_chars: 120 });
  });
});

describe('#213: config get returns effective values', () => {
  it('fills every setting the file leaves out with its default', () => {
    writeFile({ [CONFIG_FORMAT_KEY]: 2, theme: 'dark', bootstrap_max_response_bytes: 40000 });
    expect(loadConfig()).toEqual({ ...DEFAULTS, theme: 'dark', bootstrap_max_response_bytes: 40000 });
    expect(getConfigSetting('max_backups')).toBe(10);
    expect(getConfigSetting('theme')).toBe('dark');
  });

  it('never returns the format marker as a setting', () => {
    writeFile({ [CONFIG_FORMAT_KEY]: 2 });
    expect(Object.keys(loadConfig()).sort()).toEqual([...VALID_CONFIG_KEYS].sort());
    expect(getConfigSetting(CONFIG_FORMAT_KEY)).toBeNull();
  });
});

describe('#213: the one-time migration', () => {
  it('knows every default a version before #213 wrote', () => {
    // git log -G over src/config.ts and src/utils/contextBudget.ts. 28672 and
    // 160 are today's defaults, written by unreleased builds before #213;
    // backend only by the initial codexCLI commit.
    expect(SHIPPED_DEFAULTS).toEqual({
      colors: [true],
      theme: ['default'],
      max_backups: [10],
      import_max_bytes: [52428800],
      bootstrap_max_response_bytes: [51200, 38912, 28672],
      bootstrap_gist_chars: [160],
      backend: ['json'],
    });
  });

  it('a full file written by 1.2.0–1.3.0 reduces to the marker and reports current defaults', () => {
    writeFile({ colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800, bootstrap_max_response_bytes: 38912 });
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2 });
  });

  it('a 1.0/1.1 file keeps what the user chose and drops the 50KB default', () => {
    writeFile({ colors: true, theme: 'dark', max_backups: 3, import_max_bytes: 52428800, bootstrap_max_response_bytes: 51200 });
    expect(loadConfig()).toEqual({ ...DEFAULTS, theme: 'dark', max_backups: 3 });
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, theme: 'dark', max_backups: 3 });
  });

  it('drops the 28KB and 160-character defaults unreleased builds persisted', () => {
    writeFile({ ...DEFAULTS, colors: false });
    expect(loadConfig()).toEqual({ ...DEFAULTS, colors: false });
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, colors: false });
  });

  it('drops the backend key the first codexCLI release wrote', () => {
    writeFile({ colors: true, theme: 'default', backend: 'json' });
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2 });
  });

  it('runs once: a migrated file is not rewritten on later loads', () => {
    writeFile({ colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800, bootstrap_max_response_bytes: 38912 });
    loadConfig();
    const writes = countConfigWrites();
    fresh();
    fresh();
    expect(writes.count).toBe(0);
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2 });
  });

  it('a value set after the migration that equals an old default survives', () => {
    writeFile({ colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800, bootstrap_max_response_bytes: 38912 });
    loadConfig();
    setConfigSetting('bootstrap_max_response_bytes', '38912');
    expect(fresh().bootstrap_max_response_bytes).toBe(38912);
    expect(fresh().bootstrap_max_response_bytes).toBe(38912);
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 38912 });
  });

  it('a value equal to an old default set on a fresh install survives', () => {
    setConfigSetting('bootstrap_max_response_bytes', '51200');
    expect(fresh().bootstrap_max_response_bytes).toBe(51200);
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 51200 });
  });

  it('config set on a legacy file migrates it in the same write, keeping the new value', () => {
    writeFile({ colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800, bootstrap_max_response_bytes: 38912 });
    setConfigSetting('bootstrap_max_response_bytes', '38912');
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 38912 });
    expect(fresh().bootstrap_max_response_bytes).toBe(38912);
  });

  it('leaves a legacy file alone when it holds no shipped default', () => {
    const custom = { colors: false, theme: 'dark', max_backups: 3, import_max_bytes: 1000, bootstrap_max_response_bytes: 40000, bootstrap_gist_chars: 100 };
    writeFile(custom);
    const before = fs.readFileSync(configPath, 'utf8');
    const writes = countConfigWrites();
    expect(loadConfig()).toEqual(custom);
    expect(writes.count).toBe(0);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('re-checks under the lock: a value another process set meanwhile is not dropped', () => {
    writeFile({ colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800, bootstrap_max_response_bytes: 51200 });
    // Between this load's read and its lock, another process migrates the
    // file and the user pins 38912, a former default.
    otherProcessWritesBeforeLock(() => writeFile({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 38912 }));
    loadConfig();
    vi.restoreAllMocks();
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 38912 });
    expect(fresh().bootstrap_max_response_bytes).toBe(38912);
  });

  it('a migration that cannot get the lock still reports the migrated values', () => {
    writeFile({ colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800, bootstrap_max_response_bytes: 38912 });
    fs.writeFileSync(configPath + '.lock', String(process.pid));
    try {
      expect(loadConfig()).toEqual(DEFAULTS);
      expect(onDisk().bootstrap_max_response_bytes).toBe(38912);
    } finally {
      fs.unlinkSync(configPath + '.lock');
    }
    // The next process migrates it.
    expect(fresh()).toEqual(DEFAULTS);
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2 });
  });
});

describe('#213: config unset', () => {
  it('removes the key from the file; the setting reads as its default', () => {
    setConfigSetting('theme', 'dark');
    setConfigSetting('max_backups', '3');
    expect(unsetConfigSetting('theme')).toBe(true);
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, max_backups: 3 });
    expect(getConfigSetting('theme')).toBe('default');
    expect(fresh().theme).toBe('default');
  });

  it('refuses an unknown key and writes nothing', () => {
    expect(unsetConfigSetting('no_such_key')).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('unsetting a key that is not stored creates no file and rewrites none', () => {
    expect(unsetConfigSetting('theme')).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false);
    setConfigSetting('max_backups', '3');
    const writes = countConfigWrites();
    expect(unsetConfigSetting('theme')).toBe(true);
    expect(writes.count).toBe(0);
  });
});

describe('#213: config writes are one transaction under the config lock', () => {
  it('config set keeps a key another process set after this one read the config', () => {
    loadConfig(); // this process's snapshot: no file yet
    otherProcessWritesBeforeLock(() => writeFile({ [CONFIG_FORMAT_KEY]: 2, colors: false }));
    setConfigSetting('theme', 'dark');
    vi.restoreAllMocks();
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, colors: false, theme: 'dark' });
  });

  it('config unset keeps a key another process set after this one read the config', () => {
    setConfigSetting('theme', 'dark');
    loadConfig();
    otherProcessWritesBeforeLock(() => writeFile({ [CONFIG_FORMAT_KEY]: 2, theme: 'dark', max_backups: 4 }));
    unsetConfigSetting('theme');
    vi.restoreAllMocks();
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, max_backups: 4 });
  });
});
