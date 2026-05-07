import * as fs from 'fs';
import { getCompletions, generateBashScript, generateZshScript, installCompletions, CompletionItem } from '../completions';
import { clearStoreCaches } from '../store';
import { clearConfigCache } from '../config';

vi.mock('fs', () => {
  const mock = {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(JSON.stringify({ entries: {}, aliases: {}, confirm: {} })),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    renameSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
    openSync: vi.fn(() => 3),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    constants: { O_CREAT: 0x40, O_EXCL: 0x80, O_WRONLY: 0x01 },
  };
  return { default: mock, ...mock };
});

vi.mock('../utils/paths', () => ({
  getUnifiedDataFilePath: vi.fn(() => '/mock/data.json'),
  getDataDirectory: vi.fn(() => '/mock'),
  getAliasFilePath: vi.fn(() => '/mock/aliases.json'),
  getConfirmFilePath: vi.fn(() => '/mock/confirm.json'),
  getConfigFilePath: vi.fn(() => '/mock/config.json'),
  getGlobalStoreDirPath: vi.fn(() => '/mock/store'),
  ensureDataDirectoryExists: vi.fn(),
  findProjectFile: vi.fn(() => null),
  findProjectStoreDir: vi.fn(() => null),
  clearProjectFileCache: vi.fn(),
}));

// v1.10.0: completions reads via loadData/loadAliases. Mock the facade
// modules directly rather than trying to intercept fs calls made by the
// file-per-entry store layer underneath.
vi.mock('../storage', async () => {
  const actual = await vi.importActual<typeof import('../storage')>('../storage');
  return {
    ...actual,
    loadData: vi.fn(() => ({})),
  };
});

vi.mock('../alias', async () => {
  const actual = await vi.importActual<typeof import('../alias')>('../alias');
  return {
    ...actual,
    loadAliases: vi.fn(() => ({})),
  };
});

import { loadData } from '../storage';
import { loadAliases } from '../alias';
import type { Mock } from 'vitest';

/**
 * Helper: set the data returned by the mocked store layer. Tests that
 * previously did `(fs.readFileSync as Mock).mockReturnValue(JSON.stringify({entries, aliases}))`
 * now do `setMockStore({entries, aliases})`.
 */
function setMockStore(state: { entries?: Record<string, unknown>; aliases?: Record<string, string> }): void {
  (loadData as unknown as Mock).mockReturnValue(state.entries ?? {});
  (loadAliases as unknown as Mock).mockReturnValue(state.aliases ?? {});
}

/** Extract just the .value strings from CompletionItem[] for simpler assertions */
function values(items: CompletionItem[]): string[] {
  return items.map(i => i.value);
}

/** Find a CompletionItem by value */
function findItem(items: CompletionItem[], value: string): CompletionItem | undefined {
  return items.find(i => i.value === value);
}

describe('Completions', () => {
  let originalArgv1: string;

  beforeEach(() => {
    originalArgv1 = process.argv[1];
    process.argv[1] = '/usr/local/bin/rvr';
    clearStoreCaches();
    clearConfigCache();
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
  });

  describe('getCompletions', () => {
    it('returns top-level commands when no command typed', () => {
      // Ensure enough terminal rows for all commands to appear
      const origRows = process.stderr.rows;
      Object.defineProperty(process.stderr, 'rows', { value: 80, configurable: true });
      try {
        const results = getCompletions('rvr ', 5);
        const v = values(results);
        expect(v).toContain('set');
        expect(v).toContain('get');
        expect(v).toContain('run');
        expect(v).toContain('find');
        expect(v).toContain('remove');
        expect(v).toContain('config');
        expect(v).toContain('stale');
        expect(v).toContain('lint');
        expect(v).toContain('stats');
      } finally {
        Object.defineProperty(process.stderr, 'rows', { value: origRows, configurable: true });
      }
    });

    it('returns CompletionItem objects with descriptions and groups', () => {
      const results = getCompletions('rvr ', 5);
      const setItem = findItem(results, 'set');
      expect(setItem).toBeDefined();
      expect(setItem!.description).toBe('Set an entry');
      expect(setItem!.group).toBe('commands');

      const getItem = findItem(results, 'get');
      expect(getItem).toBeDefined();
      expect(getItem!.description).toBe('List keys or retrieve entries');
      expect(getItem!.group).toBe('commands');
    });

    it('filters top-level commands by partial input', () => {
      const results = getCompletions('rvr se', 7);
      const v = values(results);
      expect(v).toContain('set');
      expect(v).not.toContain('get');
    });

    it('returns flags for get command when typing a dash', () => {
      const results = getCompletions('rvr get -', 10);
      const v = values(results);
      expect(v).toContain('--tree');
      expect(v).toContain('--plain');
      expect(v).not.toContain('--format');
    });

    it('does not return flags for get command without a dash', () => {
      const results = getCompletions('rvr get ', 9);
      const v = values(results);
      expect(v).not.toContain('--tree');
      expect(v).not.toContain('--plain');
    });

    it('returns flags with descriptions and group', () => {
      const results = getCompletions('rvr get -', 10);
      const treeItem = findItem(results, '--tree');
      expect(treeItem).toBeDefined();
      expect(treeItem!.description).toBe('Display as tree');
      expect(treeItem!.group).toBe('flags');

      const plainItem = findItem(results, '--plain');
      expect(plainItem).toBeDefined();
      expect(plainItem!.description).toBe('Plain text, no colors');
      expect(plainItem!.group).toBe('flags');

      // --plain has a -p short as of v1.11
      const shortPlainItem = findItem(results, '-p');
      expect(shortPlainItem).toBeDefined();
      expect(shortPlainItem!.description).toBe('Plain text, no colors');

      // --raw was removed in v1.11 (was deprecated since v1.9.1)
      expect(findItem(results, '--raw')).toBeUndefined();
      expect(findItem(results, '-r')).toBeUndefined();
    });

    it('returns flags for run command when typing a dash', () => {
      const results = getCompletions('rvr run -', 10);
      const v = values(results);
      expect(v).toContain('--yes');
      expect(v).toContain('--dry');
    });

    it('returns flags for r shortcut when typing a dash', () => {
      const results = getCompletions('rvr r -', 8);
      const v = values(results);
      expect(v).toContain('--yes');
      expect(v).toContain('--dry');
    });

    it('returns --encrypt flag for set command when typing a dash', () => {
      const results = getCompletions('rvr set -', 10);
      const v = values(results);
      expect(v).toContain('--encrypt');
    });

    it('returns --encrypt flag for s shortcut when typing a dash', () => {
      const results = getCompletions('rvr s -', 8);
      const v = values(results);
      expect(v).toContain('--encrypt');
    });

    it('returns --decrypt flag for get command when typing a dash', () => {
      const results = getCompletions('rvr get -', 10);
      const v = values(results);
      expect(v).toContain('--decrypt');
    });

    it('returns --decrypt flag for g shortcut when typing a dash', () => {
      const results = getCompletions('rvr g -', 8);
      const v = values(results);
      expect(v).toContain('--decrypt');
    });

    it('returns --decrypt flag for run command when typing a dash', () => {
      const results = getCompletions('rvr run -', 10);
      const v = values(results);
      expect(v).toContain('--decrypt');
    });

    it('returns --decrypt flag for r shortcut when typing a dash', () => {
      const results = getCompletions('rvr r -', 8);
      const v = values(results);
      expect(v).toContain('--decrypt');
    });

    it('returns --source flag for run command when typing a dash', () => {
      const results = getCompletions('rvr run -', 10);
      const v = values(results);
      expect(v).toContain('--source');
    });

    it('returns --source flag for r shortcut when typing a dash', () => {
      const results = getCompletions('rvr r -', 8);
      const v = values(results);
      expect(v).toContain('--source');
    });

    it('returns subcommands for config', () => {
      const results = getCompletions('rvr config ', 12);
      const v = values(results);
      expect(v).toContain('set');
      expect(v).toContain('get');
      expect(v).toContain('info');
      expect(v).toContain('examples');
      expect(v).toContain('completions');
    });

    it('returns subcommands for data', () => {
      const results = getCompletions('rvr data ', 10);
      const v = values(results);
      expect(v).toContain('export');
      expect(v).toContain('import');
      expect(v).toContain('reset');
    });

    it('returns nested subcommands for config completions', () => {
      const results = getCompletions('rvr config completions ', 24);
      const v = values(results);
      expect(v).toContain('bash');
      expect(v).toContain('zsh');
      expect(v).toContain('install');
    });

    it('returns empty array after --output flag (file completion)', () => {
      const results = getCompletions('rvr data export --output ', 26);
      expect(results).toEqual([]);
    });

    it('excludes already-used flags', () => {
      const results = getCompletions('rvr get --tree ', 16);
      const v = values(results);
      expect(v).not.toContain('--tree');
    });

    it('filters top-level commands for unknown partial input', () => {
      // 'r' matches 'run', 'remove', 'r' (alias)
      const results = getCompletions('rvr r', 6);
      const v = values(results);
      expect(v).toContain('run');
      expect(v).toContain('remove');
      expect(v).not.toContain('reset');
      expect(v).not.toContain('set');
    });

    it('returns export types for data export command', () => {
      const results = getCompletions('rvr data export ', 17);
      const v = values(results);
      expect(v).toContain('entries');
      expect(v).toContain('aliases');
      expect(v).toContain('all');
    });

    it('returns export types with descriptions', () => {
      const results = getCompletions('rvr data export ', 17);
      const entriesItem = findItem(results, 'entries');
      expect(entriesItem).toBeDefined();
      expect(entriesItem!.description).toBe('Export type');
    });

    it('includes global flags when typing a dash', () => {
      const origRows = process.stdout.rows;
      process.stdout.rows = 100;
      const results = getCompletions('rvr get -', 10);
      process.stdout.rows = origRows;
      const v = values(results);
      expect(v).toContain('--debug');
      expect(v).toContain('--version');
      expect(v).toContain('--help');
    });

    it('includes global flags with descriptions', () => {
      const origRows = process.stdout.rows;
      process.stdout.rows = 100;
      const results = getCompletions('rvr get -', 10);
      process.stdout.rows = origRows;
      const debugItem = findItem(results, '--debug');
      expect(debugItem).toBeDefined();
      expect(debugItem!.description).toBe('Enable debug output');
    });
  });

  describe('generateBashScript', () => {
    it('returns a bash completion script', () => {
      const script = generateBashScript();
      expect(script).toContain('_rvr_completions');
      expect(script).toContain('complete');
      expect(script).toContain('COMPREPLY');
    });

    it('strips tab-separated descriptions', () => {
      const script = generateBashScript();
      // Bash script should extract only the value before the tab
      expect(script).toContain('${line%%${tab}*}');
    });

    it('suppresses trailing space for namespace prefixes ending in dot', () => {
      const script = generateBashScript();
      expect(script).toContain('compopt -o nospace');
    });

    it('removes colon from COMP_WORDBREAKS for colon-composed commands', () => {
      const script = generateBashScript();
      expect(script).toContain('COMP_WORDBREAKS="${COMP_WORDBREAKS//:/}"');
      expect(script).toContain('_saved_wordbreaks');
    });
  });

  describe('generateZshScript', () => {
    it('returns a zsh completion script using _describe', () => {
      const script = generateZshScript();
      expect(script).toContain('_rvr_completions');
      expect(script).toContain('compdef');
      expect(script).toContain('_describe');
    });

    it('groups completions and issues separate _describe calls', () => {
      const script = generateZshScript();
      // Uses associative array for groups
      expect(script).toContain('local -A groups');
      // Iterates groups with sorted keys
      expect(script).toContain('${(ko)groups}');
      // Uses _describe per group for normal items
      expect(script).toContain('_describe "$grp_name" _rvr_desc');
      // Uses $'\t' for tab and $'\x1f' unit separator for key-desc delimiting
      expect(script).toContain("$'\\t'");
      expect(script).toContain("$'\\x1f'");
    });

    it('escapes colons in completion values for _describe', () => {
      const script = generateZshScript();
      // Escapes : with \: in key before passing to _describe
      expect(script).toContain('${_rvr_key//:/\\:}');
    });

    it('suppresses trailing space for namespace prefixes ending in dot', () => {
      const script = generateZshScript();
      // Uses compadd -S '' for dot-terminated items (not _describe which lacks -S support)
      expect(script).toContain("compadd -S '' -- \"${_rvr_dot[@]}\"");
    });
  });

  describe('getDynamicValues via getCompletions', () => {
    it('returns data keys and alias names for dataKey commands', () => {
      setMockStore({
        entries: { server: { ip: '1.2.3.4' } },
        aliases: { myip: 'server.ip' },
      });

      const results = getCompletions('rvr get ', 9);
      const v = values(results);
      expect(v).toContain('server.ip');
      expect(v).toContain('myip');
    });

    it('returns data keys with "Entry" description', () => {
      setMockStore({ entries: { server: { ip: '1.2.3.4' } } });

      const results = getCompletions('rvr get ', 9);
      const keyItem = findItem(results, 'server.ip');
      expect(keyItem).toBeDefined();
      expect(keyItem!.description).toBe('Entry');
    });

    it('returns alias names with "Alias" description', () => {
      setMockStore({ aliases: { myip: 'server.ip' } });

      const results = getCompletions('rvr get ', 9);
      const aliasItem = findItem(results, 'myip');
      expect(aliasItem).toBeDefined();
      expect(aliasItem!.description).toBe('Alias');
    });

    it('returns config keys for configKey commands', () => {
      const results = getCompletions('rvr config set ', 16);
      const v = values(results);
      expect(v).toContain('colors');
      expect(v).toContain('theme');
    });

    it('returns config keys with "Config setting" description', () => {
      const results = getCompletions('rvr config set ', 16);
      const colorsItem = findItem(results, 'colors');
      expect(colorsItem).toBeDefined();
      expect(colorsItem!.description).toBe('Config setting');
    });

    it('returns export types for exportType commands', () => {
      const results = getCompletions('rvr data export ', 17);
      const v = values(results);
      expect(v).toContain('entries');
      expect(v).toContain('aliases');
      expect(v).toContain('all');
    });
  });

  describe('dataKeyPrefix for set/s commands', () => {
    it('completes to namespace prefix instead of full key', () => {
      setMockStore({ entries: { test: { key1: 'val1', key2: 'val2' } } });

      const results = getCompletions('rvr set te', 11);
      const v = values(results);
      expect(v).toContain('test.');
      expect(v).not.toContain('test.key1');
      expect(v).not.toContain('test.key2');
    });

    it('shows leaf keys when partial includes the namespace dot', () => {
      setMockStore({ entries: { test: { key1: 'val1', key2: 'val2' } } });

      const results = getCompletions('rvr set test.', 14);
      const v = values(results);
      expect(v).toContain('test.key1');
      expect(v).toContain('test.key2');
    });

    it('deduplicates namespace prefixes', () => {
      setMockStore({
        entries: { server: { prod: { ip: '1.2.3.4' }, dev: { ip: '5.6.7.8' } } },
      });

      const results = getCompletions('rvr s ', 7);
      const v = values(results);
      const serverDots = v.filter(val => val === 'server.');
      expect(serverDots).toHaveLength(1);
    });

    it('completes nested namespace one level at a time', () => {
      setMockStore({
        entries: { server: { prod: { ip: '1.2.3.4' }, dev: { ip: '5.6.7.8' } } },
      });

      const results = getCompletions('rvr set server.', 16);
      const v = values(results);
      expect(v).toContain('server.prod.');
      expect(v).toContain('server.dev.');
      expect(v).not.toContain('server.prod.ip');
    });

    it('shows full key at leaf level', () => {
      setMockStore({ entries: { server: { prod: { ip: '1.2.3.4' } } } });

      const results = getCompletions('rvr set server.prod.', 21);
      const v = values(results);
      expect(v).toContain('server.prod.ip');
    });

    it('includes aliases without truncation', () => {
      setMockStore({
        entries: { test: { key1: 'val1' } },
        aliases: { myalias: 'test.key1' },
      });

      const results = getCompletions('rvr set m', 10);
      const v = values(results);
      expect(v).toContain('myalias');
    });

    it('marks truncated values as Namespace', () => {
      setMockStore({ entries: { test: { key1: 'val1' } } });

      const results = getCompletions('rvr set te', 11);
      const item = findItem(results, 'test.');
      expect(item).toBeDefined();
      expect(item!.description).toBe('Namespace');
    });

    it('does not affect get command (still returns full keys)', () => {
      setMockStore({ entries: { test: { key1: 'val1' } } });

      const results = getCompletions('rvr get te', 11);
      const v = values(results);
      expect(v).toContain('test.key1');
      expect(v).not.toContain('test.');
    });

    it('get command includes namespace prefixes (without dot)', () => {
      setMockStore({ entries: { test: { key1: 'val1', key2: 'val2' } } });

      const results = getCompletions('rvr get te', 11);
      const v = values(results);
      expect(v).toContain('test');
      expect(v).toContain('test.key1');
      expect(v).toContain('test.key2');
      const nsItem = findItem(results, 'test');
      expect(nsItem!.description).toBe('Namespace');
    });

    it('get includes nested namespace prefixes', () => {
      setMockStore({ entries: { server: { prod: { ip: '1.2.3.4' } } } });

      const results = getCompletions('rvr g s', 8);
      const v = values(results);
      expect(v).toContain('server');
      expect(v).toContain('server.prod');
      expect(v).toContain('server.prod.ip');
    });
  });

  describe('colon composition for run/r commands', () => {
    beforeEach(() => {
      setMockStore({
        entries: {
          system: { commands: { cd: 'cd ' } },
          paths: { home: '/Users/kh', github: '/Users/kh/Projects/github.com' },
        },
        aliases: { cd: 'system.commands.cd' },
      });
    });

    it('completes segment after : for run command', () => {
      const results = getCompletions('rvr run cd:paths.', 18);
      const v = values(results);
      expect(v).toContain('cd:paths.home');
      expect(v).toContain('cd:paths.github');
    });

    it('completes segment after : for r shortcut', () => {
      const results = getCompletions('rvr r cd:paths.', 16);
      const v = values(results);
      expect(v).toContain('cd:paths.home');
      expect(v).toContain('cd:paths.github');
    });

    it('completes first segment without : normally', () => {
      const results = getCompletions('rvr r cd', 9);
      const v = values(results);
      // "cd" is an alias, should match
      expect(v).toContain('cd');
    });

    it('completes segment after : with alias', () => {
      const results = getCompletions('rvr r cd:c', 11);
      const v = values(results);
      expect(v).toContain('cd:cd');
    });

    it('does not apply colon completion to get command', () => {
      const results = getCompletions('rvr get cd:paths.', 18);
      const v = values(results);
      expect(v).not.toContain('cd:paths.home');
    });

    it('handles multiple colons (multi-segment composition)', () => {
      const results = getCompletions('rvr r cd:paths.home:paths.', 26);
      const v = values(results);
      expect(v).toContain('cd:paths.home:paths.home');
      expect(v).toContain('cd:paths.home:paths.github');
    });
  });

  describe('getCompletions edge cases', () => {
    beforeEach(() => {
      setMockStore({ entries: {}, aliases: {} });
    });

    it('returns top-level commands for unknown command', () => {
      const results = getCompletions('rvr zzz ', 9);
      const v = values(results);
      expect(v).toContain('set');
      expect(v).toContain('get');
    });

    it('returns subcommands when typing partial subcommand', () => {
      const results = getCompletions('rvr config s', 13);
      const v = values(results);
      expect(v).toContain('set');
      expect(v).not.toContain('get');
    });

    it('returns subcommand list with trailing space', () => {
      const results = getCompletions('rvr config ', 12);
      const v = values(results);
      expect(v).toContain('set');
      expect(v).toContain('get');
    });

    it('returns empty for --output flag (file completion)', () => {
      const results = getCompletions('rvr data export --output ', 26);
      expect(results).toEqual([]);
    });
  });

  describe('default argType (null) branch', () => {
    it('returns flags for find command when typing a dash', () => {
      const results = getCompletions('rvr find -', 11);
      const v = values(results);
      expect(v).toContain('--entries');
      expect(v).toContain('--aliases');
      expect(v).toContain('--debug');
    });

    it('returns no completions for find command without a dash', () => {
      const results = getCompletions('rvr find ', 10);
      const v = values(results);
      // find has argType: null, so no data keys or flags
      expect(v).not.toContain('--entries');
      expect(v).not.toContain('server.ip');
    });
  });

  describe('partial subcommand that matches nothing', () => {
    it('returns empty result for unmatched subcommand prefix', () => {
      const results = getCompletions('rvr config x', 13);
      expect(results).toEqual([]);
    });
  });

  describe('error paths in data loading', () => {
    let consoleErrorSpy: SpyInstance;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation();
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it('returns empty data keys when loadData throws', () => {
      (fs.readFileSync as Mock).mockImplementation(() => {
        throw new Error('read error');
      });
      (fs.existsSync as Mock).mockReturnValue(true);

      // Should not throw, just return empty results without data keys
      const results = getCompletions('rvr get ', 9);
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it('returns empty alias names when loadAliases throws', () => {
      (fs.readFileSync as Mock).mockImplementation(() => {
        throw new Error('read error');
      });
      (fs.existsSync as Mock).mockReturnValue(true);

      // rm uses dataKey which loads both entries and aliases
      const results = getCompletions('rvr rm ', 8);
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });
  });

  describe('installCompletions', () => {
    let originalShell: string | undefined;
    let originalHome: string | undefined;
    let consoleSpy: SpyInstance;
    let consoleErrorSpy: SpyInstance;
    let exitSpy: SpyInstance;

    beforeEach(() => {
      originalShell = process.env.SHELL;
      originalHome = process.env.HOME;
      process.env.HOME = '/home/testuser';
      consoleSpy = vi.spyOn(console, 'log').mockImplementation();
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation();
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      vi.clearAllMocks();
    });

    afterEach(() => {
      process.env.SHELL = originalShell;
      process.env.HOME = originalHome;
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('installs zsh completions', () => {
      process.env.SHELL = '/bin/zsh';
      (fs.existsSync as Mock).mockReturnValue(false);

      installCompletions();

      expect(fs.appendFileSync).toHaveBeenCalled();
      const appendCall = (fs.appendFileSync as Mock).mock.calls[0];
      expect(appendCall[0]).toContain('.zshrc');
      expect(appendCall[1]).toContain('rvr config completions zsh');
    });

    it('installs bash completions on Linux', () => {
      process.env.SHELL = '/bin/bash';
      (fs.existsSync as Mock).mockReturnValue(false);
      // Mock platform as linux
      const originalPlatformValue = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      installCompletions();

      expect(fs.appendFileSync).toHaveBeenCalled();
      const appendCall = (fs.appendFileSync as Mock).mock.calls[0];
      expect(appendCall[0]).toContain('.bashrc');

      Object.defineProperty(process, 'platform', { value: originalPlatformValue, configurable: true });
    });

    it('installs bash completions on macOS using .bash_profile', () => {
      process.env.SHELL = '/bin/bash';
      // .bash_profile exists on macOS
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue('# existing content');
      const originalPlatformValue = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      installCompletions();

      expect(fs.appendFileSync).toHaveBeenCalled();
      const appendCall = (fs.appendFileSync as Mock).mock.calls[0];
      expect(appendCall[0]).toContain('.bash_profile');

      Object.defineProperty(process, 'platform', { value: originalPlatformValue, configurable: true });
    });

    it('exits with error for unsupported shell', () => {
      process.env.SHELL = '/bin/fish';

      installCompletions();

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('skips if completions, shell wrapper, and history exclusion already installed', () => {
      process.env.SHELL = '/bin/zsh';
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue('eval "$(rvr config completions zsh)"\n# Reverie shell wrapper (rvr)\n_rvr_history_filter');

      installCompletions();

      expect(fs.appendFileSync).not.toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls;
      const showedAlready = logCalls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('already installed'))
      );
      expect(showedAlready).toBe(true);
    });

    it('installs shell wrapper for rvr run', () => {
      process.env.SHELL = '/bin/zsh';
      (fs.existsSync as Mock).mockReturnValue(false);

      installCompletions();

      const appendCalls = (fs.appendFileSync as Mock).mock.calls;
      const wrapperAppend = appendCalls.find((call: unknown[]) =>
        typeof call[1] === 'string' && call[1].includes('# Reverie shell wrapper (rvr)')
      );
      expect(wrapperAppend).toBeDefined();
      expect(wrapperAppend[1]).toContain('command rvr');
      expect(wrapperAppend[1]).toContain('--source');
      expect(wrapperAppend[1]).toContain('eval "$__rvr_cmd"');
    });

    it('skips shell wrapper if already installed', () => {
      process.env.SHELL = '/bin/zsh';
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(
        'eval "$(rvr config completions zsh)"\n# Reverie shell wrapper (rvr)\nrvr() {\n}\n_rvr_history_filter'
      );

      installCompletions();

      const logCalls = consoleSpy.mock.calls;
      const showedAlready = logCalls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Shell wrapper already installed'))
      );
      expect(showedAlready).toBe(true);
    });

  });
});
