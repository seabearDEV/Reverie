import fs from 'fs';
import path from 'path';
import os from 'os';

// We need to test paths module in isolation — import dynamically after setting env
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paths-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('paths utilities', () => {
  // Since paths.ts uses module-level caching, we need fresh imports per test.
  // Use vi.resetModules() and dynamic import.

  describe('getDataDirectory', () => {
    it('returns CODEX_DATA_DIR when set', async () => {
      // CODEX_DATA_DIR is set by vitest.config.ts, so it should be respected
      expect(process.env.CODEX_DATA_DIR).toBeDefined();
      vi.resetModules();
      const { getDataDirectory } = await import('../utils/paths');
      expect(getDataDirectory()).toBe(process.env.CODEX_DATA_DIR);
    });

    it('throws when CODEX_DATA_DIR is a relative path', async () => {
      vi.resetModules();
      const original = process.env.CODEX_DATA_DIR;
      process.env.CODEX_DATA_DIR = './relative/path';
      try {
        const { getDataDirectory } = await import('../utils/paths');
        expect(() => getDataDirectory()).toThrow(/absolute path/i);
      } finally {
        if (original !== undefined) process.env.CODEX_DATA_DIR = original;
        else delete process.env.CODEX_DATA_DIR;
      }
    });

    it('treats an empty CODEX_DATA_DIR as unset (does not produce a relative path)', async () => {
      vi.resetModules();
      const original = process.env.CODEX_DATA_DIR;
      process.env.CODEX_DATA_DIR = '';
      try {
        const { getDataDirectory } = await import('../utils/paths');
        const result = getDataDirectory();
        expect(result).not.toBe('');
        expect(path.isAbsolute(result)).toBe(true);
      } finally {
        if (original !== undefined) process.env.CODEX_DATA_DIR = original;
        else delete process.env.CODEX_DATA_DIR;
      }
    });
  });

  describe('clearDataDirectoryCache', () => {
    it('resets the cache so a new CODEX_DATA_DIR is picked up on the next call', async () => {
      vi.resetModules();
      const original = process.env.CODEX_DATA_DIR;
      const firstDir = path.join(tmpDir, 'first');
      const secondDir = path.join(tmpDir, 'second');
      try {
        process.env.CODEX_DATA_DIR = firstDir;
        const { getDataDirectory, clearDataDirectoryCache } = await import('../utils/paths');
        expect(getDataDirectory()).toBe(firstDir);

        // Without clearing, the cache wins even when the env changes.
        process.env.CODEX_DATA_DIR = secondDir;
        expect(getDataDirectory()).toBe(firstDir);

        // After clearing, the next call re-reads the env.
        clearDataDirectoryCache();
        expect(getDataDirectory()).toBe(secondDir);
      } finally {
        if (original !== undefined) process.env.CODEX_DATA_DIR = original;
        else delete process.env.CODEX_DATA_DIR;
      }
    });
  });

  describe('isDataDirectoryFromEnv', () => {
    it('returns true when CODEX_DATA_DIR is set to a non-empty value', async () => {
      vi.resetModules();
      const original = process.env.CODEX_DATA_DIR;
      process.env.CODEX_DATA_DIR = path.join(tmpDir, 'somewhere');
      try {
        const { isDataDirectoryFromEnv } = await import('../utils/paths');
        expect(isDataDirectoryFromEnv()).toBe(true);
      } finally {
        if (original !== undefined) process.env.CODEX_DATA_DIR = original;
        else delete process.env.CODEX_DATA_DIR;
      }
    });

    it('returns false when CODEX_DATA_DIR is unset', async () => {
      vi.resetModules();
      const original = process.env.CODEX_DATA_DIR;
      delete process.env.CODEX_DATA_DIR;
      try {
        const { isDataDirectoryFromEnv } = await import('../utils/paths');
        expect(isDataDirectoryFromEnv()).toBe(false);
      } finally {
        if (original !== undefined) process.env.CODEX_DATA_DIR = original;
      }
    });

    it('returns false when CODEX_DATA_DIR is an empty string', async () => {
      vi.resetModules();
      const original = process.env.CODEX_DATA_DIR;
      process.env.CODEX_DATA_DIR = '';
      try {
        const { isDataDirectoryFromEnv } = await import('../utils/paths');
        expect(isDataDirectoryFromEnv()).toBe(false);
      } finally {
        if (original !== undefined) process.env.CODEX_DATA_DIR = original;
        else delete process.env.CODEX_DATA_DIR;
      }
    });
  });

  describe('ensureDataDirectoryExists', () => {
    it('creates directory if it does not exist', async () => {
      const newDir = path.join(tmpDir, 'new-data-dir');
      vi.resetModules();
      const originalEnv = process.env.CODEX_DATA_DIR;
      process.env.CODEX_DATA_DIR = newDir;

      try {
        const { ensureDataDirectoryExists } = await import('../utils/paths');
        ensureDataDirectoryExists();
        expect(fs.existsSync(newDir)).toBe(true);
      } finally {
        process.env.CODEX_DATA_DIR = originalEnv;
      }
    });
  });

  describe('findProjectFile', () => {
    it('returns null when CODEX_NO_PROJECT is set', async () => {
      vi.resetModules();
      const originalNoProject = process.env.CODEX_NO_PROJECT;
      process.env.CODEX_NO_PROJECT = '1';

      try {
        const { findProjectFile, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        expect(findProjectFile()).toBeNull();
      } finally {
        if (originalNoProject !== undefined) {
          process.env.CODEX_NO_PROJECT = originalNoProject;
        } else {
          delete process.env.CODEX_NO_PROJECT;
        }
      }
    });

    it('caches result after first call', async () => {
      vi.resetModules();
      const originalNoProject = process.env.CODEX_NO_PROJECT;
      process.env.CODEX_NO_PROJECT = '1';

      try {
        const { findProjectFile, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        const first = findProjectFile();
        const second = findProjectFile();
        expect(first).toBe(second);
      } finally {
        if (originalNoProject !== undefined) {
          process.env.CODEX_NO_PROJECT = originalNoProject;
        } else {
          delete process.env.CODEX_NO_PROJECT;
        }
      }
    });

    it('honors CODEX_PROJECT pointing at a .codexcli.json file', async () => {
      const projectFile = path.join(tmpDir, '.codexcli.json');
      fs.writeFileSync(projectFile, '{}');
      vi.resetModules();
      const original = process.env.CODEX_PROJECT;
      process.env.CODEX_PROJECT = projectFile;
      try {
        const { findProjectFile, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        expect(findProjectFile()).toBe(projectFile);
      } finally {
        if (original !== undefined) process.env.CODEX_PROJECT = original;
        else delete process.env.CODEX_PROJECT;
      }
    });

    it('honors CODEX_PROJECT pointing at a directory', async () => {
      const projectFile = path.join(tmpDir, '.codexcli.json');
      fs.writeFileSync(projectFile, '{}');
      vi.resetModules();
      const original = process.env.CODEX_PROJECT;
      process.env.CODEX_PROJECT = tmpDir;
      try {
        const { findProjectFile, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        expect(findProjectFile()).toBe(projectFile);
      } finally {
        if (original !== undefined) process.env.CODEX_PROJECT = original;
        else delete process.env.CODEX_PROJECT;
      }
    });

    it('CODEX_PROJECT pointing at a missing path returns null (no cwd fallback)', async () => {
      vi.resetModules();
      const original = process.env.CODEX_PROJECT;
      process.env.CODEX_PROJECT = path.join(tmpDir, 'nope');
      try {
        const { findProjectFile, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        expect(findProjectFile()).toBeNull();
      } finally {
        if (original !== undefined) process.env.CODEX_PROJECT = original;
        else delete process.env.CODEX_PROJECT;
      }
    });

    it('setProjectRootOverride changes the search start directory', async () => {
      const projectFile = path.join(tmpDir, '.codexcli.json');
      fs.writeFileSync(projectFile, '{}');
      vi.resetModules();
      try {
        const { findProjectFile, setProjectRootOverride } = await import('../utils/paths');
        setProjectRootOverride(tmpDir);
        expect(findProjectFile()).toBe(projectFile);
        setProjectRootOverride(null);
      } catch (e) {
        const { setProjectRootOverride } = await import('../utils/paths');
        setProjectRootOverride(null);
        throw e;
      }
    });

    it('CODEX_NO_PROJECT wins over CODEX_PROJECT', async () => {
      const projectFile = path.join(tmpDir, '.codexcli.json');
      fs.writeFileSync(projectFile, '{}');
      vi.resetModules();
      const originalNo = process.env.CODEX_NO_PROJECT;
      const originalP = process.env.CODEX_PROJECT;
      process.env.CODEX_NO_PROJECT = '1';
      process.env.CODEX_PROJECT = projectFile;
      try {
        const { findProjectFile, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        expect(findProjectFile()).toBeNull();
      } finally {
        if (originalNo !== undefined) process.env.CODEX_NO_PROJECT = originalNo;
        else delete process.env.CODEX_NO_PROJECT;
        if (originalP !== undefined) process.env.CODEX_PROJECT = originalP;
        else delete process.env.CODEX_PROJECT;
      }
    });

    it('clearProjectFileCache resets the cache', async () => {
      vi.resetModules();
      process.env.CODEX_NO_PROJECT = '1';

      try {
        const { findProjectFile, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        findProjectFile(); // populate cache
        clearProjectFileCache(); // clear
        // After clear, it should search again
        const result = findProjectFile();
        expect(result).toBeNull(); // still null because CODEX_NO_PROJECT
      } finally {
        delete process.env.CODEX_NO_PROJECT;
      }
    });

    // Issue #102: a relative override (e.g. CODEX_PROJECT_DIR=. / --cwd .)
    // used to yield a relative resolved path, which downstream path.dirname()
    // collapsed to "." in audit rows.
    it('setProjectRootOverride absolutizes relative input so resolver returns an absolute path', async () => {
      fs.mkdirSync(path.join(tmpDir, '.codexcli'));

      const originalCwd = process.cwd();
      process.chdir(tmpDir);

      vi.resetModules();
      const { findProjectFile, getProjectRootOverride, clearProjectFileCache, setProjectRootOverride } = await import('../utils/paths');
      clearProjectFileCache();
      try {
        setProjectRootOverride('.');
        expect(path.isAbsolute(getProjectRootOverride() as string)).toBe(true);
        const resolved = findProjectFile();
        expect(resolved).not.toBeNull();
        expect(path.isAbsolute(resolved as string)).toBe(true);
        // The audit-row contract: path.dirname() of the resolved value is
        // the project directory in absolute form, never bare "." (#102).
        expect(path.dirname(resolved as string)).not.toBe('.');
        expect(path.isAbsolute(path.dirname(resolved as string))).toBe(true);
      } finally {
        setProjectRootOverride(null);
        process.chdir(originalCwd);
      }
    });
  });

  describe('file path getters', () => {
    it('getAliasFilePath returns path inside data directory', async () => {
      vi.resetModules();
      const { getAliasFilePath, getDataDirectory } = await import('../utils/paths');
      expect(getAliasFilePath()).toBe(path.join(getDataDirectory(), 'aliases.json'));
    });

    it('getConfigFilePath returns path inside data directory', async () => {
      vi.resetModules();
      const { getConfigFilePath, getDataDirectory } = await import('../utils/paths');
      expect(getConfigFilePath()).toBe(path.join(getDataDirectory(), 'config.json'));
    });

    it('getConfirmFilePath returns path inside data directory', async () => {
      vi.resetModules();
      const { getConfirmFilePath, getDataDirectory } = await import('../utils/paths');
      expect(getConfirmFilePath()).toBe(path.join(getDataDirectory(), 'confirm.json'));
    });

    it('getUnifiedDataFilePath returns data.json inside data directory', async () => {
      vi.resetModules();
      const { getUnifiedDataFilePath, getDataDirectory } = await import('../utils/paths');
      expect(getUnifiedDataFilePath()).toBe(path.join(getDataDirectory(), 'data.json'));
    });

    it('getGlobalStoreDirPath returns store subdirectory inside data directory', async () => {
      vi.resetModules();
      const { getGlobalStoreDirPath, getDataDirectory } = await import('../utils/paths');
      expect(getGlobalStoreDirPath()).toBe(path.join(getDataDirectory(), 'store'));
    });
  });

  describe('findProjectStoreDir', () => {
    it('returns null when CODEX_NO_PROJECT is set', async () => {
      vi.resetModules();
      const originalNoProject = process.env.CODEX_NO_PROJECT;
      process.env.CODEX_NO_PROJECT = '1';

      try {
        const { findProjectStoreDir, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        expect(findProjectStoreDir()).toBeNull();
      } finally {
        if (originalNoProject !== undefined) {
          process.env.CODEX_NO_PROJECT = originalNoProject;
        } else {
          delete process.env.CODEX_NO_PROJECT;
        }
      }
    });

    it('honors CODEX_PROJECT pointing at a .codexcli directory', async () => {
      const projectDir = path.join(tmpDir, '.codexcli');
      fs.mkdirSync(projectDir);
      vi.resetModules();
      const original = process.env.CODEX_PROJECT;
      process.env.CODEX_PROJECT = projectDir;
      try {
        const { findProjectStoreDir, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        expect(findProjectStoreDir()).toBe(projectDir);
      } finally {
        if (original !== undefined) process.env.CODEX_PROJECT = original;
        else delete process.env.CODEX_PROJECT;
      }
    });

    it('honors CODEX_PROJECT pointing at a containing directory', async () => {
      fs.mkdirSync(path.join(tmpDir, '.codexcli'));
      vi.resetModules();
      const original = process.env.CODEX_PROJECT;
      process.env.CODEX_PROJECT = tmpDir;
      try {
        const { findProjectStoreDir, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        expect(findProjectStoreDir()).toBe(path.join(tmpDir, '.codexcli'));
      } finally {
        if (original !== undefined) process.env.CODEX_PROJECT = original;
        else delete process.env.CODEX_PROJECT;
      }
    });

    it('fails closed when CODEX_PROJECT does not resolve to a directory', async () => {
      vi.resetModules();
      const original = process.env.CODEX_PROJECT;
      process.env.CODEX_PROJECT = path.join(tmpDir, 'nonexistent');
      try {
        const { findProjectStoreDir, clearProjectFileCache } = await import('../utils/paths');
        clearProjectFileCache();
        expect(findProjectStoreDir()).toBeNull();
      } finally {
        if (original !== undefined) process.env.CODEX_PROJECT = original;
        else delete process.env.CODEX_PROJECT;
      }
    });

    it('walks up from setProjectRootOverride to find .codexcli directory', async () => {
      const nested = path.join(tmpDir, 'a', 'b', 'c');
      fs.mkdirSync(nested, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.codexcli'));

      vi.resetModules();
      const { findProjectStoreDir, clearProjectFileCache, setProjectRootOverride } = await import('../utils/paths');
      clearProjectFileCache();
      setProjectRootOverride(nested);
      try {
        expect(findProjectStoreDir()).toBe(path.join(tmpDir, '.codexcli'));
      } finally {
        setProjectRootOverride(null);
      }
    });

    it('does not match a file named .codexcli (only directories)', async () => {
      fs.writeFileSync(path.join(tmpDir, '.codexcli'), 'not a dir');

      vi.resetModules();
      const { findProjectStoreDir, clearProjectFileCache, setProjectRootOverride } = await import('../utils/paths');
      clearProjectFileCache();
      setProjectRootOverride(tmpDir);
      try {
        expect(findProjectStoreDir()).toBeNull();
      } finally {
        setProjectRootOverride(null);
      }
    });
  });
});
