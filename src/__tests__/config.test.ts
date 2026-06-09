import * as fs from 'fs';
import { loadConfig, saveConfig, getConfigSetting, setConfigSetting, clearConfigCache } from '../config';

vi.mock('fs', () => {
  const mock = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn()
  };
  return { default: mock, ...mock };
});

vi.mock('../utils/paths', () => ({
  getConfigFilePath: vi.fn(() => '/mock/config.json'),
  ensureDataDirectoryExists: vi.fn()
}));

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
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(
        JSON.stringify({ colors: false, theme: 'dark' })
      );

      const config = loadConfig();
      expect(config.colors).toBe(false);
      expect(config.theme).toBe('dark');
    });

    it('creates default config when file does not exist', () => {
      (fs.statSync as Mock).mockImplementation(() => {
        const err = new Error('ENOENT') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      });

      const config = loadConfig();

      expect(config.colors).toBe(true);
      expect(config.theme).toBe('default');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('returns defaults and logs error for malformed JSON', () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue('not valid json');

      const config = loadConfig();

      expect(config.colors).toBe(true);
      expect(config.theme).toBe('default');
      expect(console.error).toHaveBeenCalledWith(
        'Error loading configuration:',
        expect.any(SyntaxError)
      );
    });

    it('fills missing fields with defaults', () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(
        JSON.stringify({ colors: false })
      );

      const config = loadConfig();

      expect(config.colors).toBe(false);
      expect(config.theme).toBe('default');
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
    it('writes formatted JSON to config path via atomic write', () => {
      saveConfig({ colors: true, theme: 'dark', max_backups: 10 });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/mock/config.json.tmp',
        JSON.stringify({ colors: true, theme: 'dark', max_backups: 10 }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        '/mock/config.json.tmp',
        '/mock/config.json'
      );
    });

    it('logs error when writeFileSync throws', () => {
      (fs.writeFileSync as Mock).mockImplementationOnce(() => {
        throw new Error('write failed');
      });

      saveConfig({ colors: true, theme: 'default', max_backups: 10 });

      expect(console.error).toHaveBeenCalledWith(
        'Error saving configuration:',
        expect.any(Error)
      );
    });
  });

  describe('getConfigSetting', () => {
    beforeEach(() => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(
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
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(
        JSON.stringify({ colors: true, theme: 'default' })
      );
    });

    it('sets theme string value', () => {
      setConfigSetting('theme', 'dark');

      const savedCall = (fs.writeFileSync as Mock).mock.calls[0];
      const savedConfig = JSON.parse(savedCall[1]);
      expect(savedConfig.theme).toBe('dark');
    });

    it('converts "true" string to boolean for colors', () => {
      setConfigSetting('colors', 'true');

      const savedCall = (fs.writeFileSync as Mock).mock.calls[0];
      const savedConfig = JSON.parse(savedCall[1]);
      expect(savedConfig.colors).toBe(true);
    });

    it('converts "false" string to false for colors', () => {
      setConfigSetting('colors', 'false');

      const savedCall = (fs.writeFileSync as Mock).mock.calls[0];
      const savedConfig = JSON.parse(savedCall[1]);
      expect(savedConfig.colors).toBe(false);
    });

    it('rejects backend as unknown key', () => {
      setConfigSetting('backend', 'sqlite');

      expect(console.error).toHaveBeenCalledWith('Unknown configuration key: backend');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects invalid theme value', () => {
      setConfigSetting('theme', 'neon');

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid theme: 'neon'")
      );
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('accepts all valid theme values', () => {
      for (const theme of ['default', 'dark', 'light']) {
        clearConfigCache();
        vi.clearAllMocks();
        (fs.existsSync as Mock).mockReturnValue(true);
        (fs.readFileSync as Mock).mockReturnValue(
          JSON.stringify({ colors: true, theme: 'default' })
        );
        (fs.statSync as Mock).mockReturnValue({ mtimeMs: Date.now() });

        setConfigSetting('theme', theme);

        const savedCall = (fs.writeFileSync as Mock).mock.calls[0];
        const savedConfig = JSON.parse(savedCall[1]);
        expect(savedConfig.theme).toBe(theme);
      }
    });

    it('logs error for unknown key and does not save', () => {
      setConfigSetting('unknown', 'value');

      expect(console.error).toHaveBeenCalledWith('Unknown configuration key: unknown');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('returns cached config on second call with same mtime', () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(
        JSON.stringify({ colors: false, theme: 'dark' })
      );
      (fs.statSync as Mock).mockReturnValue({ mtimeMs: 1000 });

      const first = loadConfig();
      const second = loadConfig();

      expect(first).toEqual({ colors: false, theme: 'dark', max_backups: 10, import_max_bytes: 50 * 1024 * 1024, bootstrap_max_response_bytes: 38 * 1024 });
      expect(second).toEqual({ colors: false, theme: 'dark', max_backups: 10, import_max_bytes: 50 * 1024 * 1024, bootstrap_max_response_bytes: 38 * 1024 });
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('re-reads when mtime changes', () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock)
        .mockReturnValueOnce(JSON.stringify({ colors: true, theme: 'default' }))
        .mockReturnValueOnce(JSON.stringify({ colors: false, theme: 'dark' }));
      (fs.statSync as Mock)
        .mockReturnValueOnce({ mtimeMs: 1000 })
        .mockReturnValueOnce({ mtimeMs: 2000 });

      const first = loadConfig();
      const second = loadConfig();

      expect(first.colors).toBe(true);
      expect(second.colors).toBe(false);
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
    });

    it('updates cache on saveConfig (write-through)', () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.statSync as Mock).mockReturnValue({ mtimeMs: 2000 });

      saveConfig({ colors: false, theme: 'dark', max_backups: 10 });
      const loaded = loadConfig();

      expect(loaded).toEqual({ colors: false, theme: 'dark', max_backups: 10 });
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });
});
