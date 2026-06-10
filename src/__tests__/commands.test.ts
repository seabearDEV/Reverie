import * as fs from 'fs';
import readline from 'readline';
import { execSync } from 'child_process';
import type { Mock } from 'bun:test';
import {
  setEntry,
  getEntry,
  searchEntries,
  removeEntry,
  renameEntry,
  runCommand,
  resetData,
  importData,
  exportData,
  handleConfig,
  configSet,
} from '../commands';
import { displayAliases } from '../commands/helpers';
import { encryptValue, decryptValue, isEncrypted } from '../utils/crypto';
import { copyToClipboard } from '../utils/clipboard';
import { stripAnsi } from '../utils/wordWrap';
import { clearStoreCaches } from '../store';
import { clearConfigCache } from '../config';
import type { CodexData } from '../types';

// ── Shared state for store mock ──────────────────────────────────────
// Was vi.hoisted (#112) — bun:test has no equivalent, but doesn't need
// one because vi.mock factories run in source order, after this binding.
const storeState = {
  entries: {} as CodexData,
  aliases: {} as Record<string, string>,
  confirm: {} as Record<string, true>,
};

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// autoBackup does real filesystem work (mkdir, cp, stat). These tests mock
// fs broadly and aren't verifying backup mechanics — stub the module out.
vi.mock('../utils/autoBackup', () => ({
  createAutoBackup: vi.fn(() => null),
}));

// Mock file system operations (still needed for export/import files, config, autoBackup)
vi.mock('fs', () => {
  const mock = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    openSync: vi.fn(() => 3),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    copyFileSync: vi.fn(),
    rmdirSync: vi.fn(),
    chmodSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
    constants: { O_CREAT: 0x40, O_EXCL: 0x80, O_WRONLY: 0x01 }
  };
  return { default: mock, ...mock };
});

// Mock the unified store — all data access goes through here
vi.mock('../store', () => {
  // Deep clone helper to prevent tests from mutating shared state
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const saveEntries = vi.fn((d: CodexData) => { storeState.entries = clone(d); });
  const saveAliasMap = vi.fn((d: Record<string, string>) => { storeState.aliases = clone(d); });
  const saveConfirmMap = vi.fn((d: Record<string, true>) => { storeState.confirm = clone(d); });
  const saveAll = vi.fn((sections: { entries?: CodexData; aliases?: Record<string, string>; confirm?: Record<string, true> }) => {
    if (sections.entries !== undefined) saveEntries(sections.entries);
    if (sections.aliases !== undefined) saveAliasMap(sections.aliases);
    if (sections.confirm !== undefined) saveConfirmMap(sections.confirm);
  });
  return {
    loadEntries:        vi.fn(()  => clone(storeState.entries)),
    saveEntries,
    saveAll,
    saveEntriesAndTouchMeta: vi.fn((d: CodexData) => { saveEntries(d); }),
    saveEntriesAndRemoveMeta: vi.fn((d: CodexData) => { saveEntries(d); }),
    loadEntriesMerged:  vi.fn(()  => clone(storeState.entries)),
    loadAliasMap:       vi.fn(()  => clone(storeState.aliases)),
    saveAliasMap,
    loadAliasMapMerged: vi.fn(()  => clone(storeState.aliases)),
    loadConfirmMap:       vi.fn(()  => clone(storeState.confirm)),
    saveConfirmMap,
    loadConfirmMapMerged: vi.fn(()  => clone(storeState.confirm)),
    clearStoreCaches:   vi.fn(),
    findProjectFile:    vi.fn(() => null),
    clearProjectFileCache: vi.fn(),
    getEffectiveScope:  vi.fn(() => 'global'),
    touchMeta:          vi.fn(),
    removeMeta:         vi.fn(),
    loadMeta:           vi.fn(() => ({})),
    loadMetaMerged:     vi.fn(() => ({})),
    STALE_DAYS:         30,
    STALE_MS:           30 * 86400000,
    getStalenessTag:    vi.fn((key: string, meta: Record<string, number>) => {
      const ts = meta[key];
      if (ts === undefined) return ' [untracked]';
      if (ts < Date.now() - 30 * 86400000) return ` [${Math.floor((Date.now() - ts) / 86400000)}d]`;
      return '';
    }),
    // bun:test (#112): omitting these falls through to the REAL store
    // impls (live bindings preserve un-mocked exports), which write to
    // actual filesystem. Stubbing forces the slow path that the tests
    // assert against (saveEntriesAndTouchMeta).
    setEntryFast: vi.fn(() => false),
    getEntryFast: vi.fn(() => undefined),
  };
});

// Mock readline for TTY confirmation prompts
vi.mock('readline', () => {
  const mock = { createInterface: vi.fn() };
  return { default: mock, ...mock };
});

// Mock clipboard utility
vi.mock('../utils/clipboard', () => ({
  copyToClipboard: vi.fn(),
}));

// Mock askPassword for encryption tests. Pre-load the real helpers via
// createRequire BEFORE vi.mock registers — bun:test runs vi.mock in
// source order, so this captures the unmocked module. (vitest hoists
// vi.mock above all imports, so this pattern is bun-only — vitest will
// see _realHelpers as the mock and the spread is a no-op there.)
import { createRequire } from 'node:module';
const _requireForHelpers = createRequire(import.meta.url);
const _realHelpers = _requireForHelpers('../commands/helpers') as typeof import('../commands/helpers');

vi.mock('../commands/helpers', () => ({
  ..._realHelpers,
  askPassword: vi.fn(),
}));

import { askPassword } from '../commands/helpers';
import { saveEntries, saveAliasMap } from '../store';

describe('Commands', () => {
  // Mock console methods
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  beforeEach(() => {
    // Reset mocks before each test
    vi.resetAllMocks();
    clearStoreCaches();
    clearConfigCache();
    console.log = vi.fn();
    console.error = vi.fn();

    // Mock existsSync to return true (for export/import/config file operations)
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.statSync as Mock).mockReturnValue({ mtimeMs: 1000 });

    // Set up store state with default test data
    storeState.entries = {
      server: {
        production: {
          ip: '192.168.1.100',
          port: 8080
        },
        development: {
          ip: '127.0.0.1'
        }
      },
      database: {
        uri: 'mongodb://localhost:27017'
      }
    };
    storeState.aliases = {};
    storeState.confirm = {};

    // readFileSync mock — only needed for import files, config files, etc.
    (fs.readFileSync as Mock).mockReturnValue(JSON.stringify({}));
  });

  afterEach(() => {
    // Restore console methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });
  
  describe('setEntry', () => {
    it('sets a new entry', async () => {
      await setEntry('app.version', '1.0.0', true);

      // Verify saveEntries was called via the store mock
      expect(saveEntries).toHaveBeenCalled();

      // Check that our new entry was added to store state
      expect(storeState.entries.app).toEqual({ version: '1.0.0' });
    });

    it('overwrites an existing entry with --force', async () => {
      await setEntry('server.production.ip', '192.168.1.200', true);

      // Check that the entry was updated in store state
      expect((storeState.entries.server as Record<string, unknown>)?.production).toEqual(
        expect.objectContaining({ ip: '192.168.1.200' })
      );
    });

    it('skips prompt when stdin is not a TTY', async () => {
      // In test environment, process.stdin.isTTY is undefined (non-TTY)
      await setEntry('server.production.ip', '192.168.1.200');

      // Should overwrite without prompting
      expect(saveEntries).toHaveBeenCalled();
      expect((storeState.entries.server as Record<string, unknown>)?.production).toEqual(
        expect.objectContaining({ ip: '192.168.1.200' })
      );
    });

    it('prompts and overwrites when user confirms on TTY', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('y')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await setEntry('server.production.ip', '10.0.0.1');

      // Should have shown the current value
      const logCalls = (console.log as Mock).mock.calls;
      const showedCurrentValue = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('192.168.1.100'))
      );
      expect(showedCurrentValue).toBe(true);

      // Should have written the new value
      expect(saveEntries).toHaveBeenCalled();
      expect((storeState.entries.server as Record<string, unknown>)?.production).toEqual(
        expect.objectContaining({ ip: '10.0.0.1' })
      );

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('aborts when user declines overwrite on TTY', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('n')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await setEntry('server.production.ip', '10.0.0.1');

      // Should have logged 'Aborted.'
      const logCalls = (console.log as Mock).mock.calls;
      const aborted = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Aborted.'))
      );
      expect(aborted).toBe(true);

      // Should NOT have saved anything
      expect(saveEntries).not.toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('creates an alias when alias parameter is provided', async () => {
      await setEntry('app.version', '1.0.0', true, false, 'ver');

      // Verify the entry was saved
      expect(saveEntries).toHaveBeenCalled();
      expect(storeState.entries.app).toEqual({ version: '1.0.0' });

      // Verify the alias was saved
      expect(saveAliasMap).toHaveBeenCalled();
      expect(storeState.aliases.ver).toBe('app.version');
    });

    it('does not create alias when alias parameter is omitted', async () => {
      await setEntry('app.version', '1.0.0', true);

      // Entry saved, but no alias saved
      expect(saveEntries).toHaveBeenCalled();
      expect(saveAliasMap).not.toHaveBeenCalled();
    });

    it('displays JSON for object values in overwrite prompt', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('y')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      // server.production is an object {ip: '192.168.1.100', port: 8080}
      await setEntry('server.production', 'flat-value');

      // Should have shown the JSON representation of the object
      const logCalls = (console.log as Mock).mock.calls;
      const showedJSON = logCalls.some(call =>
        call.some((arg: unknown) =>
          typeof arg === 'string' && arg.includes('{"ip":"192.168.1.100","port":8080}')
        )
      );
      expect(showedJSON).toBe(true);

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });
  });
  
  describe('getEntry', () => {
    it('retrieves all entries when no key is provided', () => {
      getEntry(undefined, {});
      
      // Verify console.log was called to display data
      expect(console.log).toHaveBeenCalled();
    });
    
    it('retrieves a specific entry by key', () => {
      getEntry('server.production.ip', {});
      
      // Check that the correct value was logged
      const logCalls = (console.log as Mock).mock.calls;
      const outputContainsValue = logCalls.some(call => 
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('192.168.1.100'))
      );
      
      expect(outputContainsValue).toBe(true);
    });
    
    it('handles non-existent keys gracefully', () => {
      getEntry('nonexistent.key', {});
      
      // Check for error message
      expect(console.error).toHaveBeenCalled();
    });
  });
  
  describe('searchEntries', () => {
    it('finds entries by key', () => {
      searchEntries('production', {});

      // Verify results were found and displayed
      expect(console.log).toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it('finds entries by value', () => {
      searchEntries('192.168', {});
      
      // Verify results were found
      expect(console.log).toHaveBeenCalled();
    });
    
    it('returns no results for non-matching terms', () => {
      searchEntries('nonexistentterm', {});
      
      // Update expectation to use a more general check
      expect(console.log).toHaveBeenCalled();
      
      // You could check that at least one call includes the word "No" or "matches"
      const logCalls = (console.log as Mock).mock.calls;
      const matchOutput = logCalls.some(call => 
        call.some((arg: unknown) => 
          typeof arg === 'string' && 
          (arg.includes('No') || arg.includes('match') || arg.includes('0'))
        )
      );
      
      expect(matchOutput).toBe(true);
    });
  });
  
  describe('removeEntry', () => {
    it('removes an existing entry with --force', async () => {
      await removeEntry('server.production.ip', true);

      // Verify saveEntries was called
      expect(saveEntries).toHaveBeenCalled();

      // Check that the entry was removed from store state
      expect((storeState.entries.server as Record<string, unknown>)?.production).not.toHaveProperty('ip');
    });

    it('skips prompt in non-TTY', async () => {
      await removeEntry('server.production.ip');

      expect(saveEntries).toHaveBeenCalled();
      expect(readline.createInterface).not.toHaveBeenCalled();
    });

    it('prompts on TTY and removes on accept', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('y')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await removeEntry('server.production.ip');

      expect(readline.createInterface).toHaveBeenCalled();
      expect(saveEntries).toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('prompts on TTY and aborts on decline', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('n')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await removeEntry('server.production.ip');

      expect(readline.createInterface).toHaveBeenCalled();
      expect(saveEntries).not.toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('handles non-existent keys gracefully', async () => {
      await removeEntry('nonexistent.key');

      expect(saveEntries).not.toHaveBeenCalled();
    });
  });

  describe('renameEntry', () => {
    it('renames an entry key', () => {
      renameEntry('server.production.ip', 'network.prod.ip');

      // Should have saved the data with the new key
      expect(saveEntries).toHaveBeenCalled();
      expect(storeState.entries.network).toBeDefined();
      expect((storeState.entries.network as Record<string, unknown>)?.prod).toEqual(
        expect.objectContaining({ ip: '192.168.1.100' })
      );
    });

    it('errors when old key does not exist', () => {
      renameEntry('nonexistent.key', 'new.key');

      expect(console.error).toHaveBeenCalled();
      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('not found'))
      );
      expect(showedError).toBe(true);
    });

    it('errors when new key already exists', () => {
      renameEntry('server.production.ip', 'server.development.ip');

      expect(console.error).toHaveBeenCalled();
      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('already exists'))
      );
      expect(showedError).toBe(true);
    });

    it('renames an alias in alias mode', () => {
      storeState.aliases = { oldname: 'server.production.ip' };

      renameEntry('oldname', 'newname', true);

      expect(saveAliasMap).toHaveBeenCalled();
      const logCalls = (console.log as Mock).mock.calls;
      const showedSuccess = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('renamed'))
      );
      expect(showedSuccess).toBe(true);
    });

    it('errors when alias does not exist in alias mode', () => {
      storeState.aliases = {};

      renameEntry('nonexistent', 'newname', true);

      expect(console.error).toHaveBeenCalled();
      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('not found'))
      );
      expect(showedError).toBe(true);
    });
  });

  describe('runCommand', () => {
    beforeEach(() => {
      // Set up store state that includes a string command
      storeState.entries = {
        commands: {
          greet: 'echo hello',
          nested: {
            deep: 'echo deep'
          }
        },
        server: {
          production: {
            ip: '192.168.1.100',
            port: 8080
          }
        }
      };
    });

    it('executes a stored string command with --yes', async () => {
      await runCommand(['commands.greet'], { yes: true });

      expect(execSync).toHaveBeenCalledWith('echo hello', { stdio: 'inherit', shell: process.env.SHELL || '/bin/sh' });
    });

    it('prints the command before executing', async () => {
      await runCommand(['commands.greet'], { yes: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedCommand = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('echo hello'))
      );
      expect(showedCommand).toBe(true);
    });

    it('skips confirmation with --yes', async () => {
      await runCommand(['commands.greet'], { yes: true });

      // Should not have created a readline interface
      expect(readline.createInterface).not.toHaveBeenCalled();
      expect(execSync).toHaveBeenCalled();
    });

    it('prints command without executing with --dry', async () => {
      await runCommand(['commands.greet'], { dry: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedCommand = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('echo hello'))
      );
      expect(showedCommand).toBe(true);
      expect(execSync).not.toHaveBeenCalled();
    });

    it('errors when key is not found', async () => {
      await runCommand(['nonexistent.key'], { yes: true });

      expect(console.error).toHaveBeenCalled();
      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('not found'))
      );
      expect(showedError).toBe(true);
      expect(execSync).not.toHaveBeenCalled();
    });

    it('errors when value is an object', async () => {
      await runCommand(['commands.nested'], { yes: true });

      expect(console.error).toHaveBeenCalled();
      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('not a string'))
      );
      expect(showedError).toBe(true);
      expect(execSync).not.toHaveBeenCalled();
    });

    it('runs without prompting when no confirm metadata is set', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      await runCommand(['commands.greet'], {});

      // No confirm metadata → runs without prompting
      expect(readline.createInterface).not.toHaveBeenCalled();
      expect(execSync).toHaveBeenCalledWith('echo hello', { stdio: 'inherit', shell: process.env.SHELL || '/bin/sh' });

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('prompts for confirmation on TTY when confirm metadata is set and aborts on decline', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      // Set up confirm metadata for commands.greet
      storeState.confirm = { 'commands.greet': true };

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('n')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await runCommand(['commands.greet'], {});

      expect(readline.createInterface).toHaveBeenCalled();
      expect(execSync).not.toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('prompts for confirmation on TTY when confirm metadata is set and executes on accept', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      // Set up confirm metadata for commands.greet
      storeState.confirm = { 'commands.greet': true };

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('y')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await runCommand(['commands.greet'], {});

      expect(readline.createInterface).toHaveBeenCalled();
      expect(execSync).toHaveBeenCalledWith('echo hello', { stdio: 'inherit', shell: process.env.SHELL || '/bin/sh' });

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('skips prompt with --yes even when confirm metadata is set', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      storeState.confirm = { 'commands.greet': true };

      await runCommand(['commands.greet'], { yes: true });

      expect(readline.createInterface).not.toHaveBeenCalled();
      expect(execSync).toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('fails closed (does NOT execute) on a confirm key with no TTY and no --yes', async () => {
      const originalIsTTY = process.stdin.isTTY;
      // Non-interactive surface (agent/CI/piped): no one can answer the prompt.
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      storeState.confirm = { 'commands.greet': true };

      await runCommand(['commands.greet'], {});

      // Must refuse, not silently run the confirm-gated command.
      expect(execSync).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('chains multiple keys with && into a single command', async () => {
      storeState.entries = {
        commands: { nav: 'cd /Users/me/project', list: 'ls -l' },
      };

      await runCommand(['commands.nav', 'commands.list'], { yes: true });

      expect(execSync).toHaveBeenCalledWith('cd /Users/me/project && ls -l', { stdio: 'inherit', shell: process.env.SHELL || '/bin/sh' });
    });

    it('composes colon-separated keys with space-join', async () => {
      storeState.entries = {
        commands: { cd: 'cd' },
        paths: { project: '/Users/me/project' },
      };

      await runCommand(['commands.cd:paths.project'], { yes: true });

      expect(execSync).toHaveBeenCalledWith('cd /Users/me/project', { stdio: 'inherit', shell: process.env.SHELL || '/bin/sh' });
    });

    it('combines colon composition and && chaining', async () => {
      storeState.entries = {
        commands: { cd: 'cd', list: 'ls -l' },
        paths: { project: '/Users/me/project' },
      };

      await runCommand(['commands.cd:paths.project', 'commands.list'], { yes: true });

      expect(execSync).toHaveBeenCalledWith('cd /Users/me/project && ls -l', { stdio: 'inherit', shell: process.env.SHELL || '/bin/sh' });
    });
  });

  describe('runCommand --chain', () => {
    it('resolves space-separated keys and chains with &&', async () => {
      storeState.entries = {
        cmd: { a: 'echo step-a', b: 'echo step-b' },
        macros: { both: 'cmd.a cmd.b' },
      };

      await runCommand(['macros.both'], { yes: true, chain: true });

      expect(execSync).toHaveBeenCalledWith('echo step-a && echo step-b', { stdio: 'inherit', shell: process.env.SHELL || '/bin/sh' });
    });

    it('supports dry run with --chain', async () => {
      storeState.entries = {
        cmd: { a: 'echo step-a', b: 'echo step-b' },
        macros: { both: 'cmd.a cmd.b' },
      };

      await runCommand(['macros.both'], { dry: true, chain: true });

      expect(execSync).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('echo step-a && echo step-b'));
    });

    it('errors when a chain key is not found', async () => {
      storeState.entries = {
        macros: { bad: 'cmd.exists cmd.missing' },
        cmd: { exists: 'echo ok' },
      };

      await runCommand(['macros.bad'], { yes: true, chain: true });

      expect(process.exitCode).toBe(1);
      expect(execSync).not.toHaveBeenCalled();
    });

    it('errors when chain entry itself is not found', async () => {
      storeState.entries = {};

      await runCommand(['macros.nope'], { yes: true, chain: true });

      expect(process.exitCode).toBe(1);
    });
  });

  describe('resetData', () => {
    it('resets data with --force without prompting', async () => {
      await resetData('entries', { force: true });

      expect(saveEntries).toHaveBeenCalled();
      expect(storeState.entries).toEqual({});
    });

    it('resets aliases with --force', async () => {
      storeState.aliases = { myalias: 'some.path' };
      await resetData('aliases', { force: true });

      expect(saveAliasMap).toHaveBeenCalled();
      expect(storeState.aliases).toEqual({});
    });

    it('rejects invalid type', async () => {
      await resetData('invalid', { force: true });

      expect(console.error).toHaveBeenCalled();
      expect(saveEntries).not.toHaveBeenCalled();
    });

    it('prompts for confirmation on TTY and aborts on decline', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('n')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await resetData('entries', {});

      expect(readline.createInterface).toHaveBeenCalled();
      expect(saveEntries).not.toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('prompts for confirmation on TTY and proceeds on accept', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('y')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await resetData('entries', {});

      expect(readline.createInterface).toHaveBeenCalled();
      expect(saveEntries).toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('does not proceed without --force in non-TTY', async () => {
      await resetData('entries', {});

      expect(saveEntries).not.toHaveBeenCalled();
    });
  });

  describe('importData', () => {
    const importFile = '/tmp/import-test.json';
    const importContent = { imported: { key: 'value' } };

    beforeEach(() => {
      (fs.existsSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return true;
        return true;
      });
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return JSON.stringify(importContent);
        return JSON.stringify({});
      });
    });

    it('imports data with --force without prompting', async () => {
      await importData('entries', importFile, { force: true });

      expect(saveEntries).toHaveBeenCalled();
    });

    it('rejects invalid type', async () => {
      await importData('invalid', importFile, { force: true });

      expect(console.error).toHaveBeenCalled();
      expect(saveEntries).not.toHaveBeenCalled();
    });

    it('errors when file not found', async () => {
      (fs.existsSync as Mock).mockImplementation((p: string) => {
        if (p === '/tmp/missing.json') return false;
        return true;
      });

      await importData('entries', '/tmp/missing.json', { force: true });

      expect(console.error).toHaveBeenCalled();
      expect(saveEntries).not.toHaveBeenCalled();
    });

    it('prompts for confirmation on TTY and aborts on decline', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('n')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await importData('entries', importFile, {});

      expect(readline.createInterface).toHaveBeenCalled();
      expect(saveEntries).not.toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('prompts for confirmation on TTY and proceeds on accept', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('y')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await importData('entries', importFile, {});

      expect(readline.createInterface).toHaveBeenCalled();
      expect(saveEntries).toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('does not proceed without --force in non-TTY', async () => {
      await importData('entries', importFile, {});

      expect(saveEntries).not.toHaveBeenCalled();
    });

    it('rejects invalid JSON in import file', async () => {
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return 'not valid json{{{';
        return JSON.stringify({});
      });

      await importData('entries', importFile, { force: true });

      expect(console.error).toHaveBeenCalled();
      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('invalid JSON'))
      );
      expect(showedError).toBe(true);
      expect(saveEntries).not.toHaveBeenCalled();
    });

    it('rejects non-object JSON (array) in import file', async () => {
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return '[1, 2, 3]';
        return JSON.stringify({});
      });

      await importData('entries', importFile, { force: true });

      expect(console.error).toHaveBeenCalled();
      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('JSON object'))
      );
      expect(showedError).toBe(true);
      expect(saveEntries).not.toHaveBeenCalled();
    });

    it('imports data with merge', async () => {
      const mergeContent = { newKey: 'newValue' };
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return JSON.stringify(mergeContent);
        return JSON.stringify({});
      });
      storeState.entries = { existing: { key: 'old' } };

      await importData('entries', importFile, { force: true, merge: true });

      expect(saveEntries).toHaveBeenCalled();
      expect(storeState.entries.existing).toBeDefined();
      expect(storeState.entries.newKey).toBe('newValue');
    });

    it('imports aliases with force', async () => {
      const aliasContent = { myalias: 'some.path' };
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return JSON.stringify(aliasContent);
        return JSON.stringify({});
      });

      await importData('aliases', importFile, { force: true });

      expect(saveAliasMap).toHaveBeenCalled();
      const logCalls = (console.log as Mock).mock.calls;
      const showedSuccess = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Aliases'))
      );
      expect(showedSuccess).toBe(true);
    });

    it('imports all with force using proper section shape', async () => {
      // type=all requires the {entries, aliases, confirm} wrapper shape.
      // Pre-fix, importData treated `validData` as both entries AND aliases
      // for type=all, which mostly broke and "worked" by accident only when
      // the input happened to have all-string values. The fix dispatches
      // each section to its own save path; this test pins the new contract.
      const allContent = {
        entries: { server: { ip: '1.2.3.4' } },
        aliases: { srv: 'server.ip' },
        confirm: { 'commands.release': true },
      };
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return JSON.stringify(allContent);
        return JSON.stringify({});
      });

      await importData('all', importFile, { force: true });

      // Should save entries, aliases, and confirm keys
      expect(saveEntries).toHaveBeenCalled();
      expect(saveAliasMap).toHaveBeenCalled();
    });

    it('does not half-apply a multi-section import when a later section fails validation (#77)', async () => {
      // Construct a bare-shape 'all' import where entries are valid but
      // aliases contain a non-string value. Pre-fix, the CLI wrote
      // entries FIRST and then tripped on aliases validation, leaving
      // the store with new entries and stale aliases — a torn state.
      // Post-fix, all validation runs up front and the one saveAll call
      // never fires because validation failed first.
      const torn = {
        entries: { ok: 'value' },
        aliases: { bad: { not: 'a string' } },
      };
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return JSON.stringify(torn);
        return JSON.stringify({});
      });
      storeState.entries = { preserved: 'before' };
      storeState.aliases = { preservedAlias: 'some.path' };

      await importData('all', importFile, { force: true });

      // Nothing was saved — the store is exactly as it was before.
      expect(saveEntries).not.toHaveBeenCalled();
      expect(saveAliasMap).not.toHaveBeenCalled();
      expect(storeState.entries).toEqual({ preserved: 'before' });
      expect(storeState.aliases).toEqual({ preservedAlias: 'some.path' });

      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Alias values must all be strings'))
      );
      expect(showedError).toBe(true);
    });

    it('rejects imports all without proper section shape', async () => {
      // Pre-fix, importData type=all silently treated raw data as each
      // section. After the fix, missing sections produce a clear error
      // instead of accidentally saving wrong data.
      const allContent = { key: 'value' };  // no entries/aliases/confirm wrapper
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return JSON.stringify(allContent);
        return JSON.stringify({});
      });

      await importData('all', importFile, { force: true });

      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('requires'))
      );
      expect(showedError).toBe(true);
      expect(saveEntries).not.toHaveBeenCalled();
      expect(saveAliasMap).not.toHaveBeenCalled();
    });

    it('aborts when a section is a string instead of an object (#89)', async () => {
      // Pre-fix, a malformed section (non-object type) was silently coerced
      // to undefined and dropped — the other sections would apply and the
      // user would see success with no hint that aliases was discarded.
      // Post-fix, the shape check aborts before any save.
      const bad = {
        entries: { ok: 'value' },
        aliases: 'THIS_IS_NOT_AN_OBJECT',
      };
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return JSON.stringify(bad);
        return JSON.stringify({});
      });
      storeState.entries = { preserved: 'before' };

      await importData('all', importFile, { force: true });

      expect(saveEntries).not.toHaveBeenCalled();
      expect(saveAliasMap).not.toHaveBeenCalled();
      expect(storeState.entries).toEqual({ preserved: 'before' });

      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes("'aliases'") && arg.includes('string'))
      );
      expect(showedError).toBe(true);
    });

    it('aborts when a section is an array instead of an object (#89)', async () => {
      const bad = {
        entries: { ok: 'value' },
        aliases: [1, 2, 3],
      };
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return JSON.stringify(bad);
        return JSON.stringify({});
      });

      await importData('all', importFile, { force: true });

      expect(saveEntries).not.toHaveBeenCalled();
      expect(saveAliasMap).not.toHaveBeenCalled();

      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes("'aliases'") && arg.includes('array'))
      );
      expect(showedError).toBe(true);
    });

    it('aborts when the confirm section is a number instead of an object (#89)', async () => {
      const bad = {
        entries: { ok: 'value' },
        confirm: 42,
      };
      (fs.readFileSync as Mock).mockImplementation((p: string) => {
        if (p === importFile) return JSON.stringify(bad);
        return JSON.stringify({});
      });

      await importData('all', importFile, { force: true });

      expect(saveEntries).not.toHaveBeenCalled();

      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes("'confirm'") && arg.includes('number'))
      );
      expect(showedError).toBe(true);
    });
  });

  describe('exportData', () => {
    it('exports data to a file', () => {
      exportData('entries', {});

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const logCalls = (console.log as Mock).mock.calls;
      const showedSuccess = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Entries exported'))
      );
      expect(showedSuccess).toBe(true);
    });

    it('exports aliases to a file', () => {
      exportData('aliases', {});

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const logCalls = (console.log as Mock).mock.calls;
      const showedSuccess = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Aliases exported'))
      );
      expect(showedSuccess).toBe(true);
    });

    it('exports all to a single wrapped file by default (#76)', () => {
      exportData('all', {});

      // Single file contains all sections under the envelope.
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const writeCall = (fs.writeFileSync as Mock).mock.calls[0];
      const parsed = JSON.parse(writeCall[1] as string);
      expect(parsed.$reverie.type).toBe('all');
      expect(parsed.entries).toBeDefined();
      expect(parsed.aliases).toBeDefined();
      expect(parsed.confirm).toBeDefined();
    });

    it('exports all to three files with --split', () => {
      exportData('all', { split: true });

      expect(fs.writeFileSync).toHaveBeenCalledTimes(3);
    });

    it('rejects invalid type', () => {
      exportData('invalid', {});

      expect(console.error).toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('uses pretty printing when option is set', () => {
      exportData('entries', { pretty: true });

      const writeCall = (fs.writeFileSync as Mock).mock.calls[0];
      const written = writeCall[1];
      // Pretty-printed JSON contains newlines
      expect(written).toContain('\n');
    });

    it('masks encrypted values in exported data', () => {
      const encryptedVal = encryptValue('secret', 'pass');
      storeState.entries = { api: { key: encryptedVal }, plain: { val: 'visible' } };

      exportData('entries', {});

      const writeCall = (fs.writeFileSync as Mock).mock.calls[0];
      const written = writeCall[1];
      expect(written).toContain('[encrypted]');
      expect(written).toContain('visible');
      expect(written).not.toContain('encrypted::v1:');
    });

    it('emits real ciphertext when --include-encrypted is set', () => {
      const encryptedVal = encryptValue('secret', 'pass');
      storeState.entries = { api: { key: encryptedVal } };

      exportData('entries', { includeEncrypted: true });

      const writeCall = (fs.writeFileSync as Mock).mock.calls[0];
      const written = writeCall[1] as string;
      expect(written).toContain('encrypted::v1:');
      expect(written).not.toContain('[encrypted]');
    });

    it('CLI encrypted roundtrip: export --include-encrypted → reset → import → decrypt returns plaintext', async () => {
      const plaintext = 'top-secret';
      const password = 'pw';
      const encryptedVal = encryptValue(plaintext, password);
      storeState.entries = { api: { key: encryptedVal } };

      // Export with ciphertext intact
      exportData('entries', { includeEncrypted: true });
      const writeCall = (fs.writeFileSync as Mock).mock.calls[0];
      const exportedJson = writeCall[1] as string;
      const exportedPath = writeCall[0] as string;

      // Simulate `data reset entries`
      storeState.entries = {};
      (saveEntries as Mock).mockClear();

      // Feed the exported JSON back through import
      (fs.existsSync as Mock).mockImplementation(() => true);
      (fs.readFileSync as Mock).mockImplementation((p: string) =>
        p === exportedPath ? exportedJson : JSON.stringify({})
      );

      await importData('entries', exportedPath, { force: true });

      expect(saveEntries).toHaveBeenCalled();
      const restored = storeState.entries as Record<string, Record<string, string>>;
      expect(restored.api?.key).toBe(encryptedVal);
      expect(isEncrypted(restored.api!.key!)).toBe(true);
      expect(decryptValue(restored.api!.key!, password)).toBe(plaintext);
    });

    it('writes to custom output path', () => {
      exportData('entries', { output: '/tmp/custom-export.json' });

      const writeCall = (fs.writeFileSync as Mock).mock.calls[0];
      expect(writeCall[0]).toBe('/tmp/custom-export.json');
    });
  });

  describe('import sentinel guard', () => {
    const sentinelFile = '/tmp/sentinel.json';

    beforeEach(() => {
      (fs.existsSync as Mock).mockImplementation(() => true);
      (fs.readFileSync as Mock).mockImplementation((p: string) =>
        p === sentinelFile
          ? JSON.stringify({ api: { key: '[encrypted]' }, other: 'visible' })
          : JSON.stringify({})
      );
    });

    it('rejects oversized import files without reading them (#80)', async () => {
      const largeFile = '/tmp/huge.json';
      (fs.existsSync as Mock).mockImplementation((p: string) => p === largeFile);
      (fs.statSync as Mock).mockImplementation((p: string) => {
        if (p === largeFile) return { size: 100 * 1024 * 1024 };
        return { size: 0 };
      });
      storeState.entries = { preserved: 'v' };

      await importData('entries', largeFile, { force: true });

      expect(saveEntries).not.toHaveBeenCalled();
      expect(storeState.entries).toEqual({ preserved: 'v' });

      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Import file too large'))
      );
      expect(showedError).toBe(true);
    });

    it('rejects import containing [encrypted] sentinel and leaves store untouched', async () => {
      storeState.entries = { preserved: 'value' };

      await importData('entries', sentinelFile, { force: true });

      expect(saveEntries).not.toHaveBeenCalled();
      expect(storeState.entries).toEqual({ preserved: 'value' });

      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('masked encrypted placeholders'))
      );
      expect(showedError).toBe(true);
    });
  });

  describe('handleConfig', () => {
    it('shows all settings when no args provided', () => {
      handleConfig();

      const logCalls = (console.log as Mock).mock.calls;
      const showedColors = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('colors'))
      );
      expect(showedColors).toBe(true);
    });

    it('lists available settings with --list option', () => {
      handleConfig(undefined, undefined, { list: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedColors = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('colors'))
      );
      expect(showedColors).toBe(true);
    });

    it('shows a specific setting value', () => {
      handleConfig('colors');

      expect(console.log).toHaveBeenCalled();
    });

    it('errors for unknown setting', () => {
      handleConfig('nonexistent');

      expect(console.error).toHaveBeenCalled();
    });

    it('updates a setting when both setting and value provided', () => {
      handleConfig('theme', 'dark');

      const logCalls = (console.log as Mock).mock.calls;
      const showedUpdate = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Updated'))
      );
      expect(showedUpdate).toBe(true);
    });
  });

  describe('configSet', () => {
    it('converts boolean string for colors setting', () => {
      configSet('colors', 'true');

      const logCalls = (console.log as Mock).mock.calls;
      const showedChange = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Changing'))
      );
      expect(showedChange).toBe(true);
    });

    it('sets a non-boolean setting', () => {
      configSet('theme', 'dark');

      const logCalls = (console.log as Mock).mock.calls;
      const showedSet = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('set to'))
      );
      expect(showedSet).toBe(true);
    });

    it('handles errors gracefully', () => {
      // Force loadConfig to return defaults by making config file unreadable
      (fs.existsSync as Mock).mockReturnValue(false);

      configSet('colors', 'true');

      // Should not throw, just log success
      expect(console.log).toHaveBeenCalled();
    });
  });

  describe('getEntry additional branches', () => {
    it('displays subtree for object values', () => {
      getEntry('server', {});

      expect(console.log).toHaveBeenCalled();
    });

    it('displays subtree in tree mode', () => {
      getEntry('server', { tree: true });

      expect(console.log).toHaveBeenCalled();
    });

    it('displays all entries in tree mode', () => {
      getEntry(undefined, { tree: true });

      expect(console.log).toHaveBeenCalled();
    });

    it('outputs plain value with --plain option', () => {
      getEntry('server.production.ip', { plain: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedPlain = logCalls.some(call =>
        call.some((arg: unknown) => arg === '192.168.1.100')
      );
      expect(showedPlain).toBe(true);
    });

    it('outputs all entries as plain key: value lines with --plain --values', () => {
      getEntry(undefined, { plain: true, values: true });

      const logCalls = (console.log as Mock).mock.calls;
      const output = logCalls.map(c => c[0]).join('\n');
      // Should contain plain key: value pairs without ANSI color codes
      expect(output).toContain('server.production.ip: 192.168.1.100');
      expect(output).toContain('server.production.port: 8080');
      expect(output).toContain('database.uri: mongodb://localhost:27017');
      expect(output).not.toMatch(/\x1b\[/);
    });

    it('outputs subtree entries as plain key: value lines with --plain --values', () => {
      getEntry('server', { plain: true, values: true });

      const logCalls = (console.log as Mock).mock.calls;
      const output = logCalls.map(c => c[0]).join('\n');
      expect(output).toContain('server.production.ip: 192.168.1.100');
      expect(output).toContain('server.production.port: 8080');
      expect(output).toContain('server.development.ip: 127.0.0.1');
      expect(output).not.toMatch(/\x1b\[/);
    });

    it('outputs nothing for empty data with --plain', () => {
      storeState.entries = {};

      getEntry(undefined, { plain: true });

      expect(console.log).not.toHaveBeenCalled();
    });

    it('masks encrypted values in plain subtree output with --values', () => {
      const encryptedVal = encryptValue('secret', 'pass');
      storeState.entries = { api: { key: encryptedVal, name: 'public' } };

      getEntry('api', { plain: true, values: true });

      const logCalls = (console.log as Mock).mock.calls;
      const output = logCalls.map(c => c[0]).join('\n');
      expect(output).toContain('api.key: [encrypted]');
      expect(output).toContain('api.name: public');
      expect(output).not.toContain('encrypted::v1:');
    });

    it('shows message for empty data', () => {
      storeState.entries = {};

      getEntry(undefined, {});

      const logCalls = (console.log as Mock).mock.calls;
      const showedEmpty = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('No entries found'))
      );
      expect(showedEmpty).toBe(true);
    });
  });

  describe('getEntry with --copy', () => {
    it('copies a single leaf value to clipboard without displaying it', async () => {
      await getEntry('server.production.ip', { copy: true });

      expect(copyToClipboard).toHaveBeenCalledWith('192.168.1.100');
      // Should NOT display the value (suppressed when copy succeeds)
      const logCalls = (console.log as Mock).mock.calls;
      const showedValue = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('192.168.1.100'))
      );
      expect(showedValue).toBe(false);
    });

    it('prints success message after copying', async () => {
      await getEntry('server.production.ip', { copy: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedCopied = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Copied to clipboard'))
      );
      expect(showedCopied).toBe(true);
    });

    it('warns when trying to copy a subtree', async () => {
      await getEntry('server', { copy: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedWarning = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('only works with a single value'))
      );
      expect(showedWarning).toBe(true);
      expect(copyToClipboard).not.toHaveBeenCalled();
    });

    it('does not copy when key is not found', async () => {
      await getEntry('nonexistent.key', { copy: true });

      expect(copyToClipboard).not.toHaveBeenCalled();
    });

    it('copies decrypted value with --copy --decrypt', async () => {
      const encryptedVal = encryptValue('secret-data', 'mypass');
      storeState.entries = { api: { key: encryptedVal } };
      (askPassword as Mock).mockResolvedValueOnce('mypass');

      await getEntry('api.key', { copy: true, decrypt: true });

      expect(copyToClipboard).toHaveBeenCalledWith('secret-data');
    });

    it('handles clipboard error gracefully', async () => {
      (copyToClipboard as Mock).mockImplementation(() => {
        throw new Error('pbcopy not found');
      });

      await getEntry('server.production.ip', { copy: true });

      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Failed to copy'))
      );
      expect(showedError).toBe(true);
      // Should still display the value
      const logCalls = (console.log as Mock).mock.calls;
      const showedValue = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('192.168.1.100'))
      );
      expect(showedValue).toBe(true);
    });
  });

  describe('displayEntries with aliases', () => {
    it('shows alias indicator when entry has an alias', () => {
      storeState.entries = { server: { ip: '192.168.1.100' } };
      storeState.aliases = { myip: 'server.ip' };

      getEntry(undefined, {});

      const logCalls = (console.log as Mock).mock.calls;
      const showedAlias = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('myip'))
      );
      expect(showedAlias).toBe(true);
    });
  });

  describe('searchEntries additional branches', () => {
    it('searches with aliasesOnly option', () => {
      storeState.aliases = { prodip: 'server.production.ip' };

      searchEntries('prodip', { aliasesOnly: true });

      const logCalls = (console.log as Mock).mock.calls;
      const foundMatch = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('match'))
      );
      expect(foundMatch).toBe(true);
    });

    it('searches with entriesOnly option', () => {
      searchEntries('192.168', { entriesOnly: true });

      const logCalls = (console.log as Mock).mock.calls;
      const foundMatch = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('match'))
      );
      expect(foundMatch).toBe(true);
    });

    it('displays search results in tree mode', () => {
      searchEntries('192.168', { tree: true });

      expect(console.log).toHaveBeenCalled();
    });

    it('displays both data and alias matches with section headers', () => {
      storeState.aliases = { prodip: 'server.production.ip' };

      // Search for 'prod' which matches both data key and alias name
      searchEntries('prod', {});

      const logCalls = (console.log as Mock).mock.calls;
      const output = logCalls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('Entries (');
      expect(output).toContain('Aliases');
    });

    it('shows message for empty data without aliasesOnly', () => {
      storeState.entries = {};

      searchEntries('anything', {});

      const logCalls = (console.log as Mock).mock.calls;
      const showedEmpty = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('No entries to search'))
      );
      expect(showedEmpty).toBe(true);
    });
  });

  describe('searchEntries regex and field filters', () => {
    it('matches entries by regex pattern', () => {
      storeState.entries = {
        server: { prod: { ip: '10.0.0.1' }, dev: { ip: '127.0.0.1' } },
      };

      searchEntries('prod.*ip', { regex: true });

      const output = (console.log as Mock).mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(output).toContain('server.prod.ip');
      expect(output).not.toContain('server.dev.ip');
    });

    it('shows error for invalid regex', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      searchEntries('[invalid', { regex: true });
      expect(process.exitCode).toBe(1);
    });

    it('filters by keys only', () => {
      storeState.entries = { server: { ip: '10.0.0.1' } };

      searchEntries('10.0', { keys: true });

      // "10.0" is only in the value, not the key
      const output = (console.log as Mock).mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(output).toContain('No matches');
    });

    it('filters by values only', () => {
      storeState.entries = { server: { ip: '10.0.0.1' } };

      searchEntries('server', { values: true });

      // "server" is only in the key, not the value
      const output = (console.log as Mock).mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(output).toContain('No matches');
    });

    it('finds value match with values filter', () => {
      storeState.entries = { server: { ip: '10.0.0.1' } };

      searchEntries('10.0', { values: true });

      const output = (console.log as Mock).mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(output).toContain('server.ip');
    });
  });

  describe('runCommand --source mode', () => {
    let stderrWriteSpy: SpyInstance;
    let stdoutWriteSpy: SpyInstance;

    beforeEach(() => {
      storeState.entries = {
        commands: {
          greet: 'echo hello',
          nav: 'cd ~/projects',
        },
      };
      stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderrWriteSpy.mockRestore();
      stdoutWriteSpy.mockRestore();
    });

    it('emits raw command to stdout in source mode', async () => {
      await runCommand(['commands.greet'], { yes: true, source: true });

      expect(stdoutWriteSpy).toHaveBeenCalledWith('echo hello\n');
      expect(execSync).not.toHaveBeenCalled();
    });

    it('writes preview to stderr in source mode', async () => {
      await runCommand(['commands.greet'], { yes: true, source: true });

      const stderrCalls = stderrWriteSpy.mock.calls;
      const showedPreview = stderrCalls.some((call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('echo hello')
      );
      expect(showedPreview).toBe(true);
      // Preview should NOT go to console.log (stdout)
      expect(console.log).not.toHaveBeenCalled();
    });

    it('emits nothing to stdout with --source --dry', async () => {
      await runCommand(['commands.greet'], { dry: true, source: true });

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
      // But preview should still go to stderr
      const stderrCalls = stderrWriteSpy.mock.calls;
      const showedPreview = stderrCalls.some((call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('echo hello')
      );
      expect(showedPreview).toBe(true);
    });

    it('uses stderr for confirmation prompt in source mode when confirm is set', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      // Set up confirm metadata
      storeState.confirm = { 'commands.greet': true };

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('y')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await runCommand(['commands.greet'], { source: true });

      expect(readline.createInterface).toHaveBeenCalledWith(
        expect.objectContaining({ output: process.stderr })
      );

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('writes Aborted to stderr in source mode when confirm is set', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      // Set up confirm metadata
      storeState.confirm = { 'commands.greet': true };

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('n')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await runCommand(['commands.greet'], { source: true });

      const stderrCalls = stderrWriteSpy.mock.calls;
      const showedAborted = stderrCalls.some((call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('Aborted.')
      );
      expect(showedAborted).toBe(true);
      // Should NOT appear in console.log
      const logCalls = (console.log as Mock).mock.calls;
      const loggedAborted = logCalls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Aborted.'))
      );
      expect(loggedAborted).toBe(false);

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });
  });

  describe('exec interpolation $(key) integration', () => {
    // SECURITY REGRESSION (read = RCE, fixed): `get` must NOT execute $(key)
    // exec refs. A hostile .reverie/ store in a cloned repo could otherwise
    // run arbitrary commands the instant an agent read an entry. Reading now
    // leaves $(key) literal; only `run` (below) executes.
    it('get with $(key) does NOT execute — leaves it literal', async () => {
      storeState.entries = {
        system: { user: 'whoami' },
        paths: { home: '/Users/$(system.user)' },
      };

      await getEntry('paths.home', {});

      expect(execSync).not.toHaveBeenCalled();
      const logCalls = (console.log as Mock).mock.calls;
      const showedLiteral = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('/Users/$(system.user)'))
      );
      expect(showedLiteral).toBe(true);
    });

    it('run with $(key) interpolates exec before running', async () => {
      storeState.entries = {
        system: { user: 'whoami' },
        commands: { greet: 'echo hello $(system.user)' },
      };

      // First call: exec interpolation of $(system.user) → 'kh'
      // Second call: actual command execution
      (execSync as Mock)
        .mockReturnValueOnce('kh\n')
        .mockReturnValueOnce(undefined);

      await runCommand(['commands.greet'], { yes: true });

      // The actual command should have the resolved value
      expect(execSync).toHaveBeenCalledWith('echo hello kh', expect.objectContaining({ stdio: 'inherit' }));
    });

    it('get --source skips $(key) (shows raw)', async () => {
      storeState.entries = {
        system: { user: 'whoami' },
        paths: { home: '/Users/$(system.user)' },
      };

      await getEntry('paths.home', { source: true });

      // Should NOT have called execSync for interpolation
      expect(execSync).not.toHaveBeenCalled();

      const logCalls = (console.log as Mock).mock.calls;
      const showedRaw = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('$(system.user)'))
      );
      expect(showedRaw).toBe(true);
    });
  });

  describe('runCommand error path', () => {
    it('sets process.exitCode when execSync throws', async () => {
      storeState.entries = { commands: { fail: 'exit 42' } };

      const originalExitCode = process.exitCode;
      (execSync as Mock).mockImplementation(() => {
        const err: any = new Error('Command failed');
        err.status = 42;
        throw err;
      });

      await runCommand(['commands.fail'], { yes: true });

      expect(process.exitCode).toBe(42);
      process.exitCode = originalExitCode;
    });
  });

  describe('resetData additional', () => {
    it('resets all (data + aliases + confirm) with force', async () => {
      await resetData('all', { force: true });

      // entries + aliases + confirm
      expect(saveEntries).toHaveBeenCalled();
      expect(saveAliasMap).toHaveBeenCalled();
    });
  });

  describe('error catch blocks', () => {
    // bun:test's vi.resetAllMocks() in beforeEach clears call history
    // but NOT impl, and mockReset wipes it without restoring the
    // factory default. Capture the factory-set impl up front and put
    // it back so the change doesn't leak into the next describe block
    // (#112).
    const factorySaveEntries = (saveEntries as Mock).getMockImplementation();
    afterEach(() => {
      (saveEntries as Mock).mockImplementation(factorySaveEntries ?? (() => {}));
    });

    it('handles setEntry storage error gracefully', async () => {
      (saveEntries as Mock).mockImplementation(() => {
        throw new Error('disk full');
      });

      await setEntry('test.key', 'value', true);

      expect(console.error).toHaveBeenCalled();
    });

    it('handles removeEntry storage error gracefully', async () => {
      // Simulate a save failure that the store would normally catch and log
      (saveEntries as Mock).mockImplementation(() => {
        console.error('Error saving data:', new Error('disk full'));
      });

      await removeEntry('server.production.ip', true);

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('setEntry with --encrypt', () => {
    it('encrypts the value when encrypt flag is true', async () => {
      (askPassword as Mock)
        .mockResolvedValueOnce('mypassword')
        .mockResolvedValueOnce('mypassword');

      await setEntry('secret.key', 'my-api-key', true, true);

      expect(saveEntries).toHaveBeenCalled();
      expect(isEncrypted(String((storeState.entries.secret as Record<string, unknown>)?.key))).toBe(true);
      expect(String((storeState.entries.secret as Record<string, unknown>)?.key)).not.toContain('my-api-key');
    });

    it('aborts when passwords do not match', async () => {
      (askPassword as Mock)
        .mockResolvedValueOnce('password1')
        .mockResolvedValueOnce('password2');

      await setEntry('secret.key', 'value', true, true);

      // Should not write
      expect(saveEntries).not.toHaveBeenCalled();
      const errorCalls = (console.error as Mock).mock.calls;
      const showedMismatch = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('do not match'))
      );
      expect(showedMismatch).toBe(true);
    });

    it('shows [encrypted] in overwrite prompt for encrypted existing value', async () => {
      const encryptedVal = encryptValue('old-secret', 'pass');
      storeState.entries = { secret: { key: encryptedVal } };

      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const mockRl = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb('n')),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockRl);

      await setEntry('secret.key', 'new-value');

      const logCalls = (console.log as Mock).mock.calls;
      const showedEncrypted = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('[encrypted]'))
      );
      expect(showedEncrypted).toBe(true);

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });
  });

  describe('getEntry with encrypted values', () => {
    it('shows [encrypted] for encrypted value without --decrypt', async () => {
      const encryptedVal = encryptValue('secret-data', 'mypass');
      storeState.entries = { api: { key: encryptedVal } };

      await getEntry('api.key', {});

      const logCalls = (console.log as Mock).mock.calls;
      const showedEncrypted = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('[encrypted]'))
      );
      expect(showedEncrypted).toBe(true);
    });

    it('decrypts and displays value with --decrypt', async () => {
      const encryptedVal = encryptValue('secret-data', 'mypass');
      storeState.entries = { api: { key: encryptedVal } };
      (askPassword as Mock).mockResolvedValueOnce('mypass');

      await getEntry('api.key', { decrypt: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedDecrypted = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('secret-data'))
      );
      expect(showedDecrypted).toBe(true);
    });

    it('outputs [encrypted] with --plain on encrypted value', async () => {
      const encryptedVal = encryptValue('secret-data', 'mypass');
      storeState.entries = { api: { key: encryptedVal } };

      await getEntry('api.key', { plain: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedMasked = logCalls.some(call =>
        call.some((arg: unknown) => arg === '[encrypted]')
      );
      expect(showedMasked).toBe(true);
      // Must NOT leak ciphertext
      const leakedCiphertext = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && String(arg).startsWith('encrypted::v1:'))
      );
      expect(leakedCiphertext).toBe(false);
    });

    it('outputs plain decrypted value with --plain --decrypt', async () => {
      const encryptedVal = encryptValue('secret-data', 'mypass');
      storeState.entries = { api: { key: encryptedVal } };
      (askPassword as Mock).mockResolvedValueOnce('mypass');

      await getEntry('api.key', { plain: true, decrypt: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedPlainDecrypted = logCalls.some(call =>
        call.some((arg: unknown) => arg === 'secret-data')
      );
      expect(showedPlainDecrypted).toBe(true);
    });
  });

  describe('runCommand with encrypted values', () => {
    it('errors when value is encrypted and --decrypt not provided', async () => {
      const encryptedVal = encryptValue('echo hello', 'mypass');
      storeState.entries = { commands: { secret: encryptedVal } };

      await runCommand(['commands.secret'], { yes: true });

      const errorCalls = (console.error as Mock).mock.calls;
      const showedError = errorCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('encrypted'))
      );
      expect(showedError).toBe(true);
      expect(execSync).not.toHaveBeenCalled();
    });

    it('decrypts and executes with --decrypt', async () => {
      const encryptedVal = encryptValue('echo hello', 'mypass');
      storeState.entries = { commands: { secret: encryptedVal } };
      (askPassword as Mock).mockResolvedValueOnce('mypass');

      await runCommand(['commands.secret'], { yes: true, decrypt: true });

      expect(execSync).toHaveBeenCalledWith('echo hello', expect.anything());
    });
  });

  describe('searchEntries with encrypted values', () => {
    it('matches encrypted entries by key but shows [encrypted]', () => {
      const encryptedVal = encryptValue('secret-data', 'mypass');
      storeState.entries = { api: { key: encryptedVal } };

      searchEntries('api', {});

      const logCalls = (console.log as Mock).mock.calls;
      const output = logCalls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('[encrypted]');
      expect(output).not.toContain('encrypted::v1:');
    });

    it('does not match encrypted values by value content', () => {
      const encryptedVal = encryptValue('findme', 'mypass');
      storeState.entries = { api: { key: encryptedVal } };

      searchEntries('findme', { valuesOnly: true });

      const logCalls = (console.log as Mock).mock.calls;
      const showedNoMatch = logCalls.some(call =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('No match'))
      );
      expect(showedNoMatch).toBe(true);
    });
  });

  describe('printSuccess / printError / printWarning', () => {
    let printSuccess: (msg: string) => void, printError: (msg: string) => void, printWarning: (msg: string) => void;
    beforeAll(() => {
      printSuccess = _realHelpers.printSuccess;
      printError = _realHelpers.printError;
      printWarning = _realHelpers.printWarning;
    });

    it('printSuccess logs green checkmark with message', () => {
      printSuccess('Operation complete');

      const logCalls = (console.log as Mock).mock.calls;
      const output = logCalls.map(c => c[0]).join('');
      expect(output).toContain('✓');
      expect(output).toContain('Operation complete');
    });

    it('printError logs red cross with message to stderr', () => {
      printError('Something failed');

      const errorCalls = (console.error as Mock).mock.calls;
      const output = errorCalls.map(c => c[0]).join('');
      expect(output).toContain('✗');
      expect(output).toContain('Something failed');
    });

    it('printWarning logs yellow warning with message', () => {
      printWarning('Heads up');

      const logCalls = (console.log as Mock).mock.calls;
      const output = logCalls.map(c => c[0]).join('');
      expect(output).toContain('⚠');
      expect(output).toContain('Heads up');
    });
  });

  describe('displayAliases', () => {
    it('shows empty message when no aliases exist', () => {
      displayAliases({});
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No aliases found'));
    });

    it('lists aliases in key: value format', () => {
      displayAliases({ srv: 'server.ip', db: 'database.host' });
      const calls = (console.log as Mock).mock.calls.map(c => stripAnsi(c[0]));
      expect(calls.some((c: string) => c.includes('srv') && c.includes('server.ip'))).toBe(true);
      expect(calls.some((c: string) => c.includes('db') && c.includes('database.host'))).toBe(true);
    });

    it('shows specific alias by name', () => {
      displayAliases({ srv: 'server.ip' }, { name: 'srv' });
      const calls = (console.log as Mock).mock.calls.map(c => stripAnsi(c[0]));
      expect(calls.some((c: string) => c.includes('srv') && c.includes('server.ip'))).toBe(true);
    });

    it('shows error for missing alias name', () => {
      displayAliases({}, { name: 'missing' });
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('displays aliases in tree format', () => {
      displayAliases({ srv: 'server.ip' }, { tree: true });
      const calls = (console.log as Mock).mock.calls.map(c => c[0]);
      expect(calls.some((c: string) => c.includes('srv'))).toBe(true);
    });

    it('displays specific alias in tree format', () => {
      displayAliases({ srv: 'server.ip' }, { tree: true, name: 'srv' });
      const calls = (console.log as Mock).mock.calls.map(c => c[0]);
      expect(calls.some((c: string) => c.includes('srv'))).toBe(true);
    });

    it('shows error for missing alias in tree format', () => {
      displayAliases({ srv: 'server.ip' }, { tree: true, name: 'missing' });
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });
  });
});
