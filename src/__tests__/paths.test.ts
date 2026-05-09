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
    it('returns RVR_DATA_DIR when set', async () => {
      // RVR_DATA_DIR is set by vitest.config.ts, so it should be respected
      expect(process.env.RVR_DATA_DIR).toBeDefined();
      // vi.resetModules() removed (#112) — cache-busting import below
      const { getDataDirectory } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
      expect(getDataDirectory()).toBe(process.env.RVR_DATA_DIR);
    });

    it('throws when RVR_DATA_DIR is a relative path', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_DATA_DIR;
      process.env.RVR_DATA_DIR = './relative/path';
      try {
        const { getDataDirectory } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        expect(() => getDataDirectory()).toThrow(/absolute path/i);
      } finally {
        if (original !== undefined) process.env.RVR_DATA_DIR = original;
        else delete process.env.RVR_DATA_DIR;
      }
    });

    it('treats an empty RVR_DATA_DIR as unset (does not produce a relative path)', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_DATA_DIR;
      process.env.RVR_DATA_DIR = '';
      try {
        const { getDataDirectory } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        const result = getDataDirectory();
        expect(result).not.toBe('');
        expect(path.isAbsolute(result)).toBe(true);
      } finally {
        if (original !== undefined) process.env.RVR_DATA_DIR = original;
        else delete process.env.RVR_DATA_DIR;
      }
    });
  });

  describe('clearDataDirectoryCache', () => {
    it('resets the cache so a new RVR_DATA_DIR is picked up on the next call', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_DATA_DIR;
      const firstDir = path.join(tmpDir, 'first');
      const secondDir = path.join(tmpDir, 'second');
      try {
        process.env.RVR_DATA_DIR = firstDir;
        const { getDataDirectory, clearDataDirectoryCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        expect(getDataDirectory()).toBe(firstDir);

        // Without clearing, the cache wins even when the env changes.
        process.env.RVR_DATA_DIR = secondDir;
        expect(getDataDirectory()).toBe(firstDir);

        // After clearing, the next call re-reads the env.
        clearDataDirectoryCache();
        expect(getDataDirectory()).toBe(secondDir);
      } finally {
        if (original !== undefined) process.env.RVR_DATA_DIR = original;
        else delete process.env.RVR_DATA_DIR;
      }
    });
  });

  describe('isDataDirectoryFromEnv', () => {
    it('returns true when RVR_DATA_DIR is set to a non-empty value', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_DATA_DIR;
      process.env.RVR_DATA_DIR = path.join(tmpDir, 'somewhere');
      try {
        const { isDataDirectoryFromEnv } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        expect(isDataDirectoryFromEnv()).toBe(true);
      } finally {
        if (original !== undefined) process.env.RVR_DATA_DIR = original;
        else delete process.env.RVR_DATA_DIR;
      }
    });

    it('returns false when RVR_DATA_DIR is unset', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_DATA_DIR;
      delete process.env.RVR_DATA_DIR;
      try {
        const { isDataDirectoryFromEnv } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        expect(isDataDirectoryFromEnv()).toBe(false);
      } finally {
        if (original !== undefined) process.env.RVR_DATA_DIR = original;
      }
    });

    it('returns false when RVR_DATA_DIR is an empty string', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_DATA_DIR;
      process.env.RVR_DATA_DIR = '';
      try {
        const { isDataDirectoryFromEnv } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        expect(isDataDirectoryFromEnv()).toBe(false);
      } finally {
        if (original !== undefined) process.env.RVR_DATA_DIR = original;
        else delete process.env.RVR_DATA_DIR;
      }
    });
  });

  describe('ensureDataDirectoryExists', () => {
    it('creates directory if it does not exist', async () => {
      const newDir = path.join(tmpDir, 'new-data-dir');
      // vi.resetModules() removed (#112) — cache-busting import below
      const originalEnv = process.env.RVR_DATA_DIR;
      process.env.RVR_DATA_DIR = newDir;

      try {
        const { ensureDataDirectoryExists } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        ensureDataDirectoryExists();
        expect(fs.existsSync(newDir)).toBe(true);
      } finally {
        process.env.RVR_DATA_DIR = originalEnv;
      }
    });
  });

  describe('findProjectFile', () => {
    it('returns null when RVR_NO_PROJECT is set', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const originalNoProject = process.env.RVR_NO_PROJECT;
      process.env.RVR_NO_PROJECT = '1';

      try {
        const { findProjectFile, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        expect(findProjectFile()).toBeNull();
      } finally {
        if (originalNoProject !== undefined) {
          process.env.RVR_NO_PROJECT = originalNoProject;
        } else {
          delete process.env.RVR_NO_PROJECT;
        }
      }
    });

    it('caches result after first call', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const originalNoProject = process.env.RVR_NO_PROJECT;
      process.env.RVR_NO_PROJECT = '1';

      try {
        const { findProjectFile, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        const first = findProjectFile();
        const second = findProjectFile();
        expect(first).toBe(second);
      } finally {
        if (originalNoProject !== undefined) {
          process.env.RVR_NO_PROJECT = originalNoProject;
        } else {
          delete process.env.RVR_NO_PROJECT;
        }
      }
    });

    it('honors RVR_PROJECT pointing at a .codexcli.json file', async () => {
      const projectFile = path.join(tmpDir, '.codexcli.json');
      fs.writeFileSync(projectFile, '{}');
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_PROJECT;
      process.env.RVR_PROJECT = projectFile;
      try {
        const { findProjectFile, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        expect(findProjectFile()).toBe(projectFile);
      } finally {
        if (original !== undefined) process.env.RVR_PROJECT = original;
        else delete process.env.RVR_PROJECT;
      }
    });

    it('honors RVR_PROJECT pointing at a directory', async () => {
      const projectFile = path.join(tmpDir, '.codexcli.json');
      fs.writeFileSync(projectFile, '{}');
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_PROJECT;
      process.env.RVR_PROJECT = tmpDir;
      try {
        const { findProjectFile, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        expect(findProjectFile()).toBe(projectFile);
      } finally {
        if (original !== undefined) process.env.RVR_PROJECT = original;
        else delete process.env.RVR_PROJECT;
      }
    });

    it('RVR_PROJECT pointing at a missing path returns null (no cwd fallback)', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_PROJECT;
      process.env.RVR_PROJECT = path.join(tmpDir, 'nope');
      try {
        const { findProjectFile, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        expect(findProjectFile()).toBeNull();
      } finally {
        if (original !== undefined) process.env.RVR_PROJECT = original;
        else delete process.env.RVR_PROJECT;
      }
    });

    it('setProjectRootOverride changes the search start directory', async () => {
      const projectFile = path.join(tmpDir, '.codexcli.json');
      fs.writeFileSync(projectFile, '{}');
      // vi.resetModules() removed (#112) — cache-busting import below
      try {
        const { findProjectFile, setProjectRootOverride } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        setProjectRootOverride(tmpDir);
        expect(findProjectFile()).toBe(projectFile);
        setProjectRootOverride(null);
      } catch (e) {
        const { setProjectRootOverride } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        setProjectRootOverride(null);
        throw e;
      }
    });

    it('RVR_NO_PROJECT wins over RVR_PROJECT', async () => {
      const projectFile = path.join(tmpDir, '.codexcli.json');
      fs.writeFileSync(projectFile, '{}');
      // vi.resetModules() removed (#112) — cache-busting import below
      const originalNo = process.env.RVR_NO_PROJECT;
      const originalP = process.env.RVR_PROJECT;
      process.env.RVR_NO_PROJECT = '1';
      process.env.RVR_PROJECT = projectFile;
      try {
        const { findProjectFile, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        expect(findProjectFile()).toBeNull();
      } finally {
        if (originalNo !== undefined) process.env.RVR_NO_PROJECT = originalNo;
        else delete process.env.RVR_NO_PROJECT;
        if (originalP !== undefined) process.env.RVR_PROJECT = originalP;
        else delete process.env.RVR_PROJECT;
      }
    });

    it('clearProjectFileCache resets the cache', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      process.env.RVR_NO_PROJECT = '1';

      try {
        const { findProjectFile, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        findProjectFile(); // populate cache
        clearProjectFileCache(); // clear
        // After clear, it should search again
        const result = findProjectFile();
        expect(result).toBeNull(); // still null because RVR_NO_PROJECT
      } finally {
        delete process.env.RVR_NO_PROJECT;
      }
    });

    // Issue #102: a relative override (e.g. RVR_PROJECT_DIR=. / --cwd .)
    // used to yield a relative resolved path, which downstream path.dirname()
    // collapsed to "." in audit rows.
    it('setProjectRootOverride absolutizes relative input so resolver returns an absolute path', async () => {
      fs.mkdirSync(path.join(tmpDir, '.reverie'));

      const originalCwd = process.cwd();
      process.chdir(tmpDir);

      // vi.resetModules() removed (#112) — cache-busting import below
      const { findProjectFile, getProjectRootOverride, clearProjectFileCache, setProjectRootOverride } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
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

    // Issue #102 acceptance: end-to-end MCP-shaped audit row with a relative
    // override yields an absolute project field (not bare ".").
    it('logAudit writes absolute project on MCP rows even when override is relative', async () => {
      fs.mkdirSync(path.join(tmpDir, '.reverie'));
      const auditDataDir = path.join(tmpDir, 'data');
      fs.mkdirSync(auditDataDir, { recursive: true });

      const originalDataDir = process.env.RVR_DATA_DIR;
      const originalCwd = process.cwd();
      process.env.RVR_DATA_DIR = auditDataDir;
      process.chdir(tmpDir);

      // vi.resetModules() removed (#112) — cache-busting import below
      const { setProjectRootOverride, clearProjectFileCache, clearDataDirectoryCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
      const { logAudit, loadAuditLog, flushAudit, clearAuditLogCache } = await import('../utils/audit');
      clearProjectFileCache();
      clearDataDirectoryCache();
      clearAuditLogCache();
      try {
        setProjectRootOverride('.');
        await logAudit({
          src: 'mcp',
          tool: 'reverie_set',
          op: 'write',
          key: 'fix.102.audit',
          success: true,
        });
        await flushAudit();
        clearAuditLogCache();

        const entry = loadAuditLog().find(e => e.key === 'fix.102.audit');
        expect(entry).toBeDefined();
        expect(entry!.project).toBeDefined();
        expect(entry!.project).not.toBe('.');
        expect(path.isAbsolute(entry!.project as string)).toBe(true);
      } finally {
        setProjectRootOverride(null);
        process.chdir(originalCwd);
        if (originalDataDir !== undefined) process.env.RVR_DATA_DIR = originalDataDir;
        else delete process.env.RVR_DATA_DIR;
        clearDataDirectoryCache();
        clearAuditLogCache();
      }
    });
  });

  describe('file path getters', () => {
    it('getAliasFilePath returns path inside data directory', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const { getAliasFilePath, getDataDirectory } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
      expect(getAliasFilePath()).toBe(path.join(getDataDirectory(), 'aliases.json'));
    });

    it('getConfigFilePath returns path inside data directory', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const { getConfigFilePath, getDataDirectory } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
      expect(getConfigFilePath()).toBe(path.join(getDataDirectory(), 'config.json'));
    });

    it('getConfirmFilePath returns path inside data directory', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const { getConfirmFilePath, getDataDirectory } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
      expect(getConfirmFilePath()).toBe(path.join(getDataDirectory(), 'confirm.json'));
    });

    it('getUnifiedDataFilePath returns data.json inside data directory', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const { getUnifiedDataFilePath, getDataDirectory } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
      expect(getUnifiedDataFilePath()).toBe(path.join(getDataDirectory(), 'data.json'));
    });

    it('getGlobalStoreDirPath returns store subdirectory inside data directory', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const { getGlobalStoreDirPath, getDataDirectory } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
      expect(getGlobalStoreDirPath()).toBe(path.join(getDataDirectory(), 'store'));
    });
  });

  describe('findProjectStoreDir', () => {
    it('returns null when RVR_NO_PROJECT is set', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const originalNoProject = process.env.RVR_NO_PROJECT;
      process.env.RVR_NO_PROJECT = '1';

      try {
        const { findProjectStoreDir, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        expect(findProjectStoreDir()).toBeNull();
      } finally {
        if (originalNoProject !== undefined) {
          process.env.RVR_NO_PROJECT = originalNoProject;
        } else {
          delete process.env.RVR_NO_PROJECT;
        }
      }
    });

    it('honors RVR_PROJECT pointing at a .reverie directory', async () => {
      const projectDir = path.join(tmpDir, '.reverie');
      fs.mkdirSync(projectDir);
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_PROJECT;
      process.env.RVR_PROJECT = projectDir;
      try {
        const { findProjectStoreDir, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        expect(findProjectStoreDir()).toBe(projectDir);
      } finally {
        if (original !== undefined) process.env.RVR_PROJECT = original;
        else delete process.env.RVR_PROJECT;
      }
    });

    it('honors RVR_PROJECT pointing at a containing directory', async () => {
      fs.mkdirSync(path.join(tmpDir, '.reverie'));
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_PROJECT;
      process.env.RVR_PROJECT = tmpDir;
      try {
        const { findProjectStoreDir, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        expect(findProjectStoreDir()).toBe(path.join(tmpDir, '.reverie'));
      } finally {
        if (original !== undefined) process.env.RVR_PROJECT = original;
        else delete process.env.RVR_PROJECT;
      }
    });

    it('fails closed when RVR_PROJECT does not resolve to a directory', async () => {
      // vi.resetModules() removed (#112) — cache-busting import below
      const original = process.env.RVR_PROJECT;
      process.env.RVR_PROJECT = path.join(tmpDir, 'nonexistent');
      try {
        const { findProjectStoreDir, clearProjectFileCache } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
        clearProjectFileCache();
        expect(findProjectStoreDir()).toBeNull();
      } finally {
        if (original !== undefined) process.env.RVR_PROJECT = original;
        else delete process.env.RVR_PROJECT;
      }
    });

    it('walks up from setProjectRootOverride to find .reverie directory', async () => {
      const nested = path.join(tmpDir, 'a', 'b', 'c');
      fs.mkdirSync(nested, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.reverie'));

      // vi.resetModules() removed (#112) — cache-busting import below
      const { findProjectStoreDir, clearProjectFileCache, setProjectRootOverride } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
      clearProjectFileCache();
      setProjectRootOverride(nested);
      try {
        expect(findProjectStoreDir()).toBe(path.join(tmpDir, '.reverie'));
      } finally {
        setProjectRootOverride(null);
      }
    });

    it('does not match a file named .codexcli (only directories)', async () => {
      fs.writeFileSync(path.join(tmpDir, '.reverie'), 'not a dir');

      // vi.resetModules() removed (#112) — cache-busting import below
      const { findProjectStoreDir, clearProjectFileCache, setProjectRootOverride } = await import(`../utils/paths?t=${Date.now()}-${Math.random()}`);
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
