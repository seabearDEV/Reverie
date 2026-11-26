/**
 * #213: config.json holds only what the user set.
 *
 * First run writes nothing, a save writes only settings that differ from the
 * current default, and the defaults that versions before #213 persisted count
 * as unset until the install's first write, which persists the cleaned file
 * and records the migration beside it. A read never writes config.json.
 * Real files in a temp RVR_DATA_DIR.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearDataDirectoryCache } from '../utils/paths';
import {
  loadConfig, saveConfig, getConfigSetting, setConfigSetting, unsetConfigSetting,
  clearConfigCache, SHIPPED_DEFAULTS, VALID_CONFIG_KEYS, CONFIG_FORMAT_KEY, MIGRATION_RECORD_FILE,
} from '../config';

let dir = '';
let configPath = '';
let recordPath = '';
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
/** What v1.2.0–v1.3.0 wrote on first run: every default of the day. */
const V130_FILE = { colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800, bootstrap_max_response_bytes: 38912 };

const writeFile = (obj: unknown) => fs.writeFileSync(configPath, JSON.stringify(obj, null, 2));
const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
/** What a fresh process reads. */
const fresh = () => { clearConfigCache(); return loadConfig(); };
const errorLines = (): string[] => (console.error as Mock).mock.calls.map(c => c.map(String).join(' '));
const notes = (): string[] => errorLines().filter(l => l.includes('rewritten by an older Reverie'));

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
  recordPath = path.join(dir, MIGRATION_RECORD_FILE);
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
    expect(setConfigSetting('colors', 'true')).toEqual({ ok: true });
    expect(setConfigSetting('bootstrap_max_response_bytes', '28672')).toEqual({ ok: true });
    expect(fs.readdirSync(dir)).toEqual([]);
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
    expect(fs.existsSync(recordPath)).toBe(true);
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

describe('#213: a read never writes config.json', () => {
  it('a symlinked, read-only legacy file with an unknown key stays exactly as it is', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-213-dotfiles-'));
    try {
      const target = path.join(elsewhere, 'config.json');
      fs.writeFileSync(target, JSON.stringify({ ...V130_FILE, theme: 'dark', future_key: 1 }, null, 2));
      fs.chmodSync(target, 0o444);
      fs.symlinkSync(target, configPath);
      const before = fs.readFileSync(target, 'utf8');

      expect(loadConfig()).toEqual({ ...DEFAULTS, theme: 'dark' });
      expect(fresh()).toEqual({ ...DEFAULTS, theme: 'dark' });

      expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
      expect(fs.statSync(target).mode & 0o777).toBe(0o444);
      expect(fs.readFileSync(target, 'utf8')).toBe(before);
      expect(fs.existsSync(recordPath)).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('a 644 legacy file keeps its mode and bytes across reads', () => {
    writeFile(V130_FILE);
    fs.chmodSync(configPath, 0o644);
    const before = fs.readFileSync(configPath, 'utf8');
    const writes = countConfigWrites();
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(fresh()).toEqual(DEFAULTS);
    expect(writes.count).toBe(0);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });
});

describe('#213: the migration', () => {
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

  it('a 1.2.0–1.3.0 file reads as the current defaults; the first write stores the cleaned form and the record', () => {
    writeFile(V130_FILE);
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(onDisk()).toEqual(V130_FILE);
    setConfigSetting('theme', 'dark');
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, theme: 'dark' });
    expect(fs.existsSync(recordPath)).toBe(true);
  });

  it('a 1.0/1.1 file keeps what the user chose and drops the 50KB default', () => {
    writeFile({ colors: true, theme: 'dark', max_backups: 3, import_max_bytes: 52428800, bootstrap_max_response_bytes: 51200 });
    expect(loadConfig()).toEqual({ ...DEFAULTS, theme: 'dark', max_backups: 3 });
    unsetConfigSetting('bootstrap_gist_chars');
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, theme: 'dark', max_backups: 3 });
  });

  it('drops the 28KB and 160-character defaults unreleased builds persisted', () => {
    writeFile({ ...DEFAULTS, colors: false });
    expect(loadConfig()).toEqual({ ...DEFAULTS, colors: false });
    unsetConfigSetting('theme');
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, colors: false });
  });

  it('drops the backend key the first codexCLI release wrote', () => {
    writeFile({ colors: true, theme: 'default', backend: 'json' });
    expect(loadConfig()).toEqual(DEFAULTS);
    unsetConfigSetting('theme');
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2 });
  });

  it('runs once: after the migrating write, later loads write nothing', () => {
    writeFile(V130_FILE);
    unsetConfigSetting('theme');
    const writes = countConfigWrites();
    fresh();
    fresh();
    expect(writes.count).toBe(0);
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2 });
  });

  it('a value set after the migration that equals an old default survives', () => {
    writeFile(V130_FILE);
    unsetConfigSetting('theme');
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
    writeFile(V130_FILE);
    setConfigSetting('bootstrap_max_response_bytes', '38912');
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 38912 });
    expect(fresh().bootstrap_max_response_bytes).toBe(38912);
  });

  it('decides under the lock: a value another process set after this one read is not dropped', () => {
    writeFile({ ...V130_FILE, bootstrap_max_response_bytes: 51200 });
    expect(loadConfig().bootstrap_max_response_bytes).toBe(28672);
    // Before this write takes the lock, another process migrates the file
    // and the user pins 38912, a former default.
    otherProcessWritesBeforeLock(() => {
      writeFile({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 38912 });
      fs.writeFileSync(recordPath, '{"format":2}');
    });
    setConfigSetting('theme', 'dark');
    vi.restoreAllMocks();
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 38912, theme: 'dark' });
  });

  it('a marked file with no record (written before the record existed) is not cleaned, and the next write records it', () => {
    writeFile({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 51200 });
    expect(loadConfig().bootstrap_max_response_bytes).toBe(51200);
    setConfigSetting('bootstrap_max_response_bytes', '51200');
    expect(fs.existsSync(recordPath)).toBe(true);
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, bootstrap_max_response_bytes: 51200 });
  });
});

describe('#213: an older Reverie rewrites config.json after the migration', () => {
  /**
   * What v1.3.0's `config set` leaves: it reads the settings it knows (its own
   * defaults for the rest: 38912 for the budget) and writes the whole object
   * back, with no marker and no key it does not know.
   */
  const oldWriter = (change: Record<string, unknown> = {}) => {
    const current: Record<string, unknown> = fs.existsSync(configPath) ? onDisk() : {};
    const known = Object.fromEntries(Object.entries(current).filter(([k]) => Object.hasOwn(V130_FILE, k)));
    writeFile({ ...V130_FILE, ...known, ...change });
  };
  const record = (): { stored: string[] } => JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { stored: string[] };

  it("keeps the user's 51200 when an old writer drops the marker (F1b)", () => {
    setConfigSetting('bootstrap_max_response_bytes', '51200');
    oldWriter({ theme: 'dark' });
    expect(onDisk().bootstrap_max_response_bytes).toBe(51200);
    expect(fresh()).toEqual({ ...DEFAULTS, theme: 'dark', bootstrap_max_response_bytes: 51200 });
  });

  it("does not lock in the old writer's default for a key the user unset (N1)", () => {
    setConfigSetting('bootstrap_max_response_bytes', '40000');
    unsetConfigSetting('bootstrap_max_response_bytes');
    oldWriter({ theme: 'dark' });
    expect(onDisk().bootstrap_max_response_bytes).toBe(38912);
    expect(fresh().bootstrap_max_response_bytes).toBe(28672);
    expect(getConfigSetting('theme')).toBe('dark');
  });

  it("does not lock in the old writer's defaults for keys never set here", () => {
    setConfigSetting('theme', 'dark');
    oldWriter({ max_backups: 3 });
    expect(fresh()).toEqual({ ...DEFAULTS, theme: 'dark', max_backups: 3 });
  });

  it('the record lists the keys the last write stored; unset takes one out', () => {
    setConfigSetting('theme', 'dark');
    setConfigSetting('bootstrap_max_response_bytes', '51200');
    expect(record().stored).toEqual(['bootstrap_max_response_bytes', 'theme']);
    unsetConfigSetting('theme');
    expect(record().stored).toEqual(['bootstrap_max_response_bytes']);
    unsetConfigSetting('bootstrap_max_response_bytes');
    expect(record().stored).toEqual([]);
  });

  it('says so once per rewrite', () => {
    setConfigSetting('theme', 'dark');
    oldWriter();
    fresh();
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain('config unset <key>');
    fresh();
    fresh();
    expect(notes()).toHaveLength(1);
    oldWriter({ theme: 'light' }); // another rewrite
    expect(fresh().theme).toBe('light');
    expect(notes()).toHaveLength(2);
  });

  it('remembering the note keeps the key list a write recorded', () => {
    setConfigSetting('bootstrap_max_response_bytes', '51200');
    oldWriter({ theme: 'dark' });
    fresh();
    expect(record().stored).toEqual(['bootstrap_max_response_bytes']);
    expect(fresh().bootstrap_max_response_bytes).toBe(51200);
  });

  it('a read-only data directory: the read still works and the note prints once per process', () => {
    if (process.getuid?.() === 0) return; // root writes anyway
    setConfigSetting('bootstrap_max_response_bytes', '51200');
    oldWriter({ theme: 'dark' });
    fs.chmodSync(dir, 0o555);
    try {
      expect(fresh().bootstrap_max_response_bytes).toBe(51200);
      expect(fresh().bootstrap_max_response_bytes).toBe(51200);
      expect(notes()).toHaveLength(1);
      expect(errorLines().filter(l => !l.includes('rewritten by an older Reverie'))).toEqual([]);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('a later write keeps the values the old writer left for keys set here and values off every old default', () => {
    setConfigSetting('bootstrap_max_response_bytes', '51200');
    oldWriter({ max_backups: 3 });
    setConfigSetting('colors', 'false');
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, colors: false, max_backups: 3, bootstrap_max_response_bytes: 51200 });
  });

  it('a crash after the record, before config.json: the old file keeps its values for the listed keys (N2)', () => {
    // The state a crash leaves: the record of a write that listed the budget,
    // and the file as an older writer left it.
    fs.writeFileSync(recordPath, JSON.stringify({ format: 2, stored: ['bootstrap_max_response_bytes'] }));
    writeFile({ ...V130_FILE, bootstrap_max_response_bytes: 51200, theme: 'dark' });
    expect(loadConfig()).toEqual({ ...DEFAULTS, theme: 'dark', bootstrap_max_response_bytes: 51200 });
  });

  it('the record is written before config.json: a crash between them never drops a value the file holds (N2)', () => {
    setConfigSetting('theme', 'dark');
    // The second of the two renames fails, as a crash between them would.
    const real = fs.renameSync.bind(fs);
    let renames = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if ((String(to) === configPath || String(to) === recordPath) && ++renames === 2) throw new Error('crash');
      real(from, to);
    }) as typeof fs.renameSync);
    expect(() => setConfigSetting('bootstrap_max_response_bytes', '51200')).toThrow('crash');
    vi.restoreAllMocks();
    // An older Reverie then writes the whole object from whatever it finds.
    oldWriter({ max_backups: 3 });
    expect(fresh().bootstrap_max_response_bytes).toBe(onDisk().bootstrap_max_response_bytes);
  });
});

describe('#213: a write refuses a config.json that does not parse', () => {
  const unparseable = ['{"colors":false,"theme":"dark","max_backups":3,}', '[]', '5', '"x"', 'null'];

  for (const text of unparseable) {
    it(`set and unset leave ${text} as it is`, () => {
      fs.writeFileSync(configPath, text);
      expect(() => setConfigSetting('theme', 'light')).toThrow(/nothing was written/);
      expect(() => unsetConfigSetting('theme')).toThrow(/nothing was written/);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(text);
      expect(fs.existsSync(recordPath)).toBe(false);
    });
  }

  it('a read falls back to the defaults with one plain line, once', () => {
    fs.writeFileSync(configPath, '[]');
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(getConfigSetting('theme')).toBe('default');
    const calls = (console.error as Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(typeof calls[0][0]).toBe('string');
    expect(calls[0][0]).toBe(`Warning: ${configPath} does not hold a JSON object; using the default settings.`);
  });
});

describe('#273: a rejected setting writes nothing and says why', () => {
  it('an invalid value is INVALID_INPUT, an unknown key NOT_FOUND', () => {
    expect(setConfigSetting('theme', 'neon')).toMatchObject({ ok: false, code: 'INVALID_INPUT', message: expect.stringContaining("Invalid theme: 'neon'") });
    expect(setConfigSetting('max_backups', '-1')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(setConfigSetting('bootstrap_gist_chars', '1.5')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(setConfigSetting('nosuch', '1')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('#213: config unset', () => {
  it('removes the key from the file; the setting reads as its default', () => {
    setConfigSetting('theme', 'dark');
    setConfigSetting('max_backups', '3');
    expect(unsetConfigSetting('theme')).toEqual({ ok: true });
    expect(onDisk()).toEqual({ [CONFIG_FORMAT_KEY]: 2, max_backups: 3 });
    expect(getConfigSetting('theme')).toBe('default');
    expect(fresh().theme).toBe('default');
  });

  it('refuses an unknown key and writes nothing', () => {
    expect(unsetConfigSetting('no_such_key')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('unsetting a key that is not stored creates no file and rewrites none', () => {
    expect(unsetConfigSetting('theme')).toEqual({ ok: true });
    expect(fs.existsSync(configPath)).toBe(false);
    setConfigSetting('max_backups', '3');
    const writes = countConfigWrites();
    expect(unsetConfigSetting('theme')).toEqual({ ok: true });
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
