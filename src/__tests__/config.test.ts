import * as fs from 'fs';
import { loadConfig, saveConfig, getConfigSetting, setConfigSetting, clearConfigCache } from '../config';

vi.mock('fs', () => {
  const mock = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    // The config lock (withFileLock): a .lock file opened O_CREAT|O_EXCL.
    openSync: vi.fn(() => 3),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    constants: { O_CREAT: 0x40, O_EXCL: 0x80, O_WRONLY: 0x01 },
  };
  return { default: mock, ...mock };
});

vi.mock('../utils/paths', () => ({
  getConfigFilePath: vi.fn(() => '/mock/config.json'),
  ensureDataDirectoryExists: vi.fn()
}));

const isRecord = (p: unknown) => String(p).endsWith('config.format');

/** config.json reads as `texts` in turn (the last one repeats); no #213 migration record exists. */
function configFile(...texts: string[]): void {
  let i = 0;
  (fs.readFileSync as Mock).mockImplementation((p: unknown) => {
    if (isRecord(p)) {
      const err = new Error('ENOENT') as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return texts[Math.min(i++, texts.length - 1)];
  });
}
const configReads = () => (fs.readFileSync as Mock).mock.calls.filter(c => !isRecord(c[0])).length;
/** The write that landed on config.json (the record is written first, #213). */
const configWrite = () => (fs.writeFileSync as Mock).mock.calls.find(c => /config\.json\.[0-9a-f]+\.tmp$/.test(String(c[0])));

describe('Config', () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    vi.clearAllMocks();
    clearConfigCache();
    console.error = vi.fn();
    (fs.statSync as Mock).mockReturnValue({ mtimeMs: 1000 });
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  describe('loadConfig', () => {
    it('returns config from valid JSON file', () => {
      configFile(
        JSON.stringify({ colors: false, theme: 'dark' })
      );

      const config = loadConfig();
      expect(config.colors).toBe(false);
      expect(config.theme).toBe('dark');
    });

    it('returns defaults without writing a file when none exists (#213)', () => {
      (fs.statSync as Mock).mockImplementation(() => {
        const err = new Error('ENOENT') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      });

      const config = loadConfig();

      expect(config.colors).toBe(true);
      expect(config.theme).toBe('default');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('returns defaults and warns in one line for malformed JSON', () => {
      configFile('not valid json');

      const config = loadConfig();

      expect(config.colors).toBe(true);
      expect(config.theme).toBe('default');
      expect(console.error).toHaveBeenCalledWith(
        'Warning: /mock/config.json is not valid JSON; using the default settings.'
      );
    });

    it('fills missing fields with defaults', () => {
      configFile(
        JSON.stringify({ colors: false })
      );

      const config = loadConfig();

      expect(config.colors).toBe(false);
      expect(config.theme).toBe('default');
    });

    it('a legacy file holding a former budget default (50KB, 38KB) gets the current default (#212, migrated by #213)', () => {
      for (const legacy of [50 * 1024, 38 * 1024]) {
        clearConfigCache();
        configFile(JSON.stringify({ bootstrap_max_response_bytes: legacy }));
        expect(loadConfig().bootstrap_max_response_bytes).toBe(28 * 1024);
      }
    });

    it('honors any other explicit budget', () => {
      configFile(JSON.stringify({ bootstrap_max_response_bytes: 40000 }));
      expect(loadConfig().bootstrap_max_response_bytes).toBe(40000);
    });

    it('does not let caller mutation pollute defaultConfig on a fresh-install ENOENT path', () => {
      // Regression test for the bug Copilot caught in PR #66 review:
      // loadConfig() was returning `defaultConfig` BY REFERENCE in the
      // ENOENT branch, so a caller doing the loadConfig→mutate→saveConfig
      // pattern (e.g. setConfigSetting on a fresh install) would mutate
      // the module-level `defaultConfig` constant and pollute every
      // subsequent caller in the process.
      (fs.statSync as Mock).mockImplementation(() => {
        const err = new Error('ENOENT') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      });

      // First call: simulates first-run reading defaults.
      const first = loadConfig();
      expect(first.colors).toBe(true);

      // Mutate the returned object as setConfigSetting would.
      first.colors = false;

      // Second call: still ENOENT (file still doesn't exist in this test).
      // Must return fresh defaults, NOT a polluted reference.
      const second = loadConfig();
      expect(second.colors).toBe(true);
      expect(second).not.toBe(first);
    });
  });

  describe('saveConfig', () => {
    it('writes the sparse form to the config path via atomic write (#213)', () => {
      saveConfig({ colors: true, theme: 'dark', max_backups: 10, import_max_bytes: 50 * 1024 * 1024, bootstrap_max_response_bytes: 28 * 1024, bootstrap_gist_chars: 160 });

      // #159 write-side: tmp path carries a random suffix and the write uses
      // the no-follow exclusive flag ('wx'). Match the shape, not the exact
      // random tmp name.
      const tmpRe = /^\/mock\/config\.json\.[0-9a-f]+\.tmp$/;
      const writeCall = configWrite()!;
      expect(writeCall[0]).toMatch(tmpRe);
      expect(writeCall[1]).toBe(JSON.stringify({ _format: 2, theme: 'dark' }, null, 2));
      expect(writeCall[2]).toEqual({ encoding: 'utf8', mode: 0o600, flag: 'wx' });

      const renameCall = (fs.renameSync as Mock).mock.calls.find(c => c[1] === '/mock/config.json')!;
      expect(renameCall[0]).toMatch(tmpRe);
      expect(renameCall[1]).toBe('/mock/config.json');
    });

    it('lets a failed write propagate instead of reporting success', () => {
      (fs.writeFileSync as Mock).mockImplementationOnce(() => {
        throw new Error('write failed');
      });

      expect(() => saveConfig({ colors: true, theme: 'dark', max_backups: 10 } as Parameters<typeof saveConfig>[0])).toThrow('write failed');
    });
  });

  describe('getConfigSetting', () => {
    beforeEach(() => {
      configFile(
        JSON.stringify({ colors: false, theme: 'dark' })
      );
    });

    it('returns colors value', () => {
      expect(getConfigSetting('colors')).toBe(false);
    });

    it('returns theme value', () => {
      expect(getConfigSetting('theme')).toBe('dark');
    });

    it('returns null and logs error for unknown key', () => {
      const result = getConfigSetting('unknown');

      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith('Unknown configuration key: unknown');
    });

    it('returns null for backend (no longer a valid key)', () => {
      const result = getConfigSetting('backend');

      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith('Unknown configuration key: backend');
    });
  });

  describe('setConfigSetting', () => {
    beforeEach(() => {
      configFile(
        JSON.stringify({ colors: true, theme: 'default' })
      );
    });

    it('sets theme string value', () => {
      setConfigSetting('theme', 'dark');

      const savedCall = configWrite()!;
      const savedConfig = JSON.parse(savedCall[1]);
      expect(savedConfig.theme).toBe('dark');
    });

    it('converts "true" string to boolean for colors (the default, so not stored)', () => {
      setConfigSetting('colors', 'true');

      const savedCall = configWrite()!;
      const savedConfig = JSON.parse(savedCall[1]);
      expect(savedConfig).toEqual({ _format: 2 });
      expect(loadConfig().colors).toBe(true);
    });

    it('converts "false" string to false for colors', () => {
      setConfigSetting('colors', 'false');

      const savedCall = configWrite()!;
      const savedConfig = JSON.parse(savedCall[1]);
      expect(savedConfig.colors).toBe(false);
    });

    it('rejects backend as unknown key', () => {
      expect(setConfigSetting('backend', 'sqlite')).toEqual({ ok: false, code: 'NOT_FOUND', message: 'Unknown configuration key: backend' });
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects invalid theme value (#273)', () => {
      expect(setConfigSetting('theme', 'neon')).toMatchObject({
        ok: false, code: 'INVALID_INPUT', message: expect.stringContaining("Invalid theme: 'neon'"),
      });
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('accepts all valid theme values', () => {
      for (const theme of ['default', 'dark', 'light']) {
        clearConfigCache();
        vi.clearAllMocks();
        configFile(
          JSON.stringify({ colors: true, theme: 'default' })
        );
        (fs.statSync as Mock).mockReturnValue({ mtimeMs: Date.now() });

        setConfigSetting('theme', theme);

        const savedCall = configWrite()!;
        const savedConfig = JSON.parse(savedCall[1]);
        // 'default' is the default: not stored (#213).
        expect(savedConfig.theme).toBe(theme === 'default' ? undefined : theme);
      }
    });

    it('refuses an unknown key and does not save', () => {
      expect(setConfigSetting('unknown', 'value')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('returns cached config on second call with same mtime', () => {
      configFile(
        JSON.stringify({ colors: false, theme: 'dark' })
      );
      (fs.statSync as Mock).mockReturnValue({ mtimeMs: 1000 });

      const first = loadConfig();
      const second = loadConfig();

      expect(first).toEqual({ colors: false, theme: 'dark', max_backups: 10, import_max_bytes: 50 * 1024 * 1024, bootstrap_max_response_bytes: 28 * 1024, bootstrap_gist_chars: 160 });
      expect(second).toEqual({ colors: false, theme: 'dark', max_backups: 10, import_max_bytes: 50 * 1024 * 1024, bootstrap_max_response_bytes: 28 * 1024, bootstrap_gist_chars: 160 });
      expect(configReads()).toBe(1);
    });

    it('re-reads when mtime changes', () => {
      configFile(JSON.stringify({ _format: 2 }), JSON.stringify({ _format: 2, colors: false, theme: 'dark' }));
      (fs.statSync as Mock)
        .mockReturnValueOnce({ mtimeMs: 1000 })
        .mockReturnValueOnce({ mtimeMs: 2000 });

      const first = loadConfig();
      const second = loadConfig();

      expect(first.colors).toBe(true);
      expect(second.colors).toBe(false);
      expect(configReads()).toBe(2);
    });

    it('updates cache on saveConfig (write-through)', () => {
      (fs.statSync as Mock).mockReturnValue({ mtimeMs: 2000 });

      saveConfig({ colors: false, theme: 'dark', max_backups: 10 } as Parameters<typeof saveConfig>[0]);
      const loaded = loadConfig();

      expect(loaded).toEqual({ colors: false, theme: 'dark', max_backups: 10 });
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });
});
