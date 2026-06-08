/* eslint-disable @typescript-eslint/no-explicit-any */

// Mock functions — defined at top level, cleared between tests
const mockSetEntry = vi.fn().mockResolvedValue(undefined);
const mockGetEntry = vi.fn();
const mockRunCommand = vi.fn().mockResolvedValue(undefined);
const mockSearchEntries = vi.fn();
const mockRemoveEntry = vi.fn();
const mockRenameEntry = vi.fn();
const mockHandleConfig = vi.fn();
const mockConfigSet = vi.fn();
const mockShowInfo = vi.fn();
const mockExportData = vi.fn();
const mockImportData = vi.fn().mockResolvedValue(undefined);
const mockResetData = vi.fn().mockResolvedValue(undefined);

const mockRemoveAlias = vi.fn();
const mockResolveKey = vi.fn((k: string) => k);

const mockShowHelp = vi.fn();
const mockShowExamples = vi.fn();
const identity = (s: string) => s;
const mockColor = {
  boldColors: { magenta: identity },
  gray: identity,
  cyan: identity,
  green: identity,
  red: identity,
  yellow: identity,
};

const mockGetCompletions = vi.fn().mockReturnValue(['comp1', 'comp2']);
const mockGenerateBashScript = vi.fn().mockReturnValue('bash-script');
const mockGenerateZshScript = vi.fn().mockReturnValue('zsh-script');
const mockInstallCompletions = vi.fn();

const mockGetEffectiveInstructions = vi.fn().mockReturnValue('effective instructions');
const mockDefaultLLMInstructions = 'default instructions';

function setupMocks() {
  vi.mock('../commands', () => ({
    setEntry: mockSetEntry,
    getEntry: mockGetEntry,
    runCommand: mockRunCommand,
    searchEntries: mockSearchEntries,
    removeEntry: mockRemoveEntry,
    renameEntry: mockRenameEntry,
    handleConfig: mockHandleConfig,
    configSet: mockConfigSet,
    showInfo: mockShowInfo,
    exportData: mockExportData,
    importData: mockImportData,
    resetData: mockResetData,
  }));
  vi.mock('../alias', () => ({
    removeAlias: mockRemoveAlias,
    resolveKey: mockResolveKey,
    loadAliases: vi.fn(() => ({})),
    setAlias: vi.fn(),
    renameAlias: vi.fn(() => true),
    // bun:test (#112) strict parse — stub remaining exports.
    saveAliases: vi.fn(),
    removeAliasesForKey: vi.fn(),
    buildKeyToAliasMap: vi.fn(() => ({})),
  }));
  vi.mock('../confirm', () => ({
    setConfirm: vi.fn(),
    removeConfirm: vi.fn(),
    loadConfirmKeys: vi.fn(() => ({})),
  }));
  vi.mock('../formatting', () => ({
    showHelp: mockShowHelp,
    showExamples: mockShowExamples,
    color: mockColor,
    // bun:test (#112) parses imports strictly; pad with stubs for the
    // formatting exports SUT transitively imports.
    isColorEnabled: vi.fn(() => false),
    resetColorCache: vi.fn(),
    highlightMatch: identity,
    formatKeyValue: identity,
    colorizePathByLevels: identity,
    formatTree: vi.fn(() => ''),
    displayTree: vi.fn(),
  }));
  vi.mock('../completions', () => ({
    getCompletions: mockGetCompletions,
    generateBashScript: mockGenerateBashScript,
    generateZshScript: mockGenerateZshScript,
    installCompletions: mockInstallCompletions,
  }));
  vi.mock('../llm-instructions', () => ({
    DEFAULT_LLM_INSTRUCTIONS: mockDefaultLLMInstructions,
    CLI_LLM_INSTRUCTIONS: 'cli instructions',
    getEffectiveInstructions: mockGetEffectiveInstructions,
  }));
}

const originalArgv = process.argv;

beforeEach(() => {
  // vi.resetModules() removed (#112) — bun:test has no equivalent;
  // loadCLI() uses a cache-busting import specifier instead.
  vi.restoreAllMocks();
  vi.clearAllMocks();
  // Re-apply default return values after clearAllMocks
  mockSetEntry.mockResolvedValue(undefined);
  mockRunCommand.mockResolvedValue(undefined);
  mockImportData.mockResolvedValue(undefined);
  mockResetData.mockResolvedValue(undefined);
  mockResolveKey.mockImplementation((k: string) => k);
  mockGetCompletions.mockReturnValue([
    { value: 'comp1', description: 'First', group: 'commands' },
    { value: 'comp2', description: 'Second', group: 'commands' },
  ]);
  mockGenerateBashScript.mockReturnValue('bash-script');
  mockGenerateZshScript.mockReturnValue('zsh-script');

  setupMocks();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`EXIT_${code ?? 0}`);
  }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.argv = originalArgv;
});

async function loadCLI(...args: string[]) {
  process.argv = ['node', 'rvr', ...args];
  // Cache-buster forces re-evaluation of ../index each call (#112).
  // Was paired with vi.resetModules() in beforeEach under vitest; bun:test
  // has no module-cache reset, but a different specifier query string
  // makes bun treat each load as a fresh module.
  await import(`../index?t=${Date.now()}-${Math.random()}`);
}

describe('CLI Entry Point (index.ts)', () => {
  // --- Early exit: --get-completions ---

  it('--get-completions triggers early exit with completions', async () => {
    await expect(loadCLI('--get-completions', 'rvr s')).rejects.toThrow('EXIT_0');
    expect(mockGetCompletions).toHaveBeenCalledWith('rvr s', 5);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('--get-completions with no extra args uses defaults', async () => {
    await expect(loadCLI('--get-completions')).rejects.toThrow('EXIT_0');
    expect(mockGetCompletions).toHaveBeenCalledWith('', 0);
  });

  // --- No args: show help ---

  it('shows help when no arguments provided', async () => {
    await loadCLI();
    expect(mockShowHelp).toHaveBeenCalled();
  });

  // --- Debug flag ---

  it('--debug flag sets DEBUG env via preAction hook', async () => {
    delete process.env.DEBUG;
    await loadCLI('--debug', 'get');
    expect(process.env.DEBUG).toBe('true');
    delete process.env.DEBUG;
  });

  // --- Core commands ---

  it('set command calls setEntry with joined value', async () => {
    await loadCLI('set', '--force', 'my.key', 'my', 'value');
    expect(mockSetEntry).toHaveBeenCalledWith('my.key', 'my value', true, undefined, undefined, undefined, undefined, undefined);
  });

  it('get command resolves key via resolveKey before calling getEntry', async () => {
    mockResolveKey.mockReturnValueOnce('resolved.key');
    await loadCLI('get', 'my.key');
    expect(mockResolveKey).toHaveBeenCalledWith('my.key');
    expect(mockGetEntry).toHaveBeenCalledWith('resolved.key', expect.any(Object));
  });

  it('get without key calls getEntry with undefined', async () => {
    await loadCLI('get');
    expect(mockGetEntry).toHaveBeenCalledWith(undefined, expect.any(Object));
  });

  it('run command passes raw keys array to runCommand', async () => {
    await loadCLI('run', 'my.cmd');
    expect(mockRunCommand).toHaveBeenCalledWith(['my.cmd'], expect.any(Object));
  });

  it('find command calls searchEntries with options', async () => {
    await loadCLI('find', 'myterm', '--entries');
    expect(mockSearchEntries).toHaveBeenCalledWith('myterm', expect.objectContaining({ entries: true }));
  });

  it('remove command resolves key via resolveKey before calling removeEntry', async () => {
    mockResolveKey.mockReturnValueOnce('resolved.key');
    await loadCLI('remove', 'my.key');
    expect(mockResolveKey).toHaveBeenCalledWith('my.key');
    expect(mockRemoveEntry).toHaveBeenCalledWith('resolved.key', undefined, undefined);
  });

  // --- Rename commands ---

  it('rename command calls renameEntry with resolved old key', async () => {
    mockResolveKey.mockReturnValueOnce('resolved.old');
    await loadCLI('rename', 'old.key', 'new.key');
    expect(mockResolveKey).toHaveBeenCalledWith('old.key');
    expect(mockRenameEntry).toHaveBeenCalledWith('resolved.old', 'new.key', false, undefined, undefined);
  });

  it('rename -a calls renameEntry in alias mode', async () => {
    await loadCLI('rename', '-a', 'oldalias', 'newalias');
    expect(mockRenameEntry).toHaveBeenCalledWith('oldalias', 'newalias', true, undefined, undefined);
  });

  it('rename --set-alias sets alias on renamed key', async () => {
    mockResolveKey.mockReturnValueOnce('resolved.old');
    await loadCLI('rename', 'old.key', 'new.key', '--set-alias', 'myalias');
    expect(mockRenameEntry).toHaveBeenCalledWith('resolved.old', 'new.key', false, 'myalias', undefined);
  });

  // --- Config commands ---

  it('config with no subcommand calls handleConfig', async () => {
    await loadCLI('config');
    expect(mockHandleConfig).toHaveBeenCalled();
  });

  it('config set calls configSet', async () => {
    await loadCLI('config', 'set', 'theme', 'dark');
    expect(mockConfigSet).toHaveBeenCalledWith('theme', 'dark');
  });

  it('config get calls handleConfig with key', async () => {
    await loadCLI('config', 'get', 'colors');
    expect(mockHandleConfig).toHaveBeenCalledWith('colors');
  });

  // --- Config subcommands ---

  it('config info calls showInfo', async () => {
    await loadCLI('config', 'info');
    expect(mockShowInfo).toHaveBeenCalled();
  });

  it('config examples calls showExamples', async () => {
    await loadCLI('config', 'examples');
    expect(mockShowExamples).toHaveBeenCalled();
  });

  it('config llm-instructions prints effective instructions via pager', async () => {
    await loadCLI('config', 'llm-instructions');
    expect(mockGetEffectiveInstructions).toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('effective instructions'));
  });

  it('config llm-instructions --default prints built-in defaults via pager', async () => {
    await loadCLI('config', 'llm-instructions', '--default');
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('default instructions'));
  });

  // --- Data subcommands ---

  it('data export calls exportData', async () => {
    await loadCLI('data', 'export', 'entries');
    expect(mockExportData).toHaveBeenCalledWith('entries', expect.any(Object));
  });

  it('data import calls importData', async () => {
    await loadCLI('data', 'import', 'entries', 'file.json');
    expect(mockImportData).toHaveBeenCalledWith('entries', 'file.json', expect.any(Object));
  });

  it('data reset calls resetData', async () => {
    await loadCLI('data', 'reset', 'entries');
    expect(mockResetData).toHaveBeenCalledWith('entries', expect.any(Object));
  });

  // --- Completions commands ---

  it('config completions bash outputs bash script', async () => {
    await loadCLI('config', 'completions', 'bash');
    expect(mockGenerateBashScript).toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith('bash-script');
  });

  it('config completions zsh outputs zsh script', async () => {
    await loadCLI('config', 'completions', 'zsh');
    expect(mockGenerateZshScript).toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith('zsh-script');
  });

  it('config completions install calls installCompletions', async () => {
    await loadCLI('config', 'completions', 'install');
    expect(mockInstallCompletions).toHaveBeenCalled();
  });

  // --- Help command ---

  it('no-args shows help', async () => {
    await loadCLI();
    expect(mockShowHelp).toHaveBeenCalled();
  });
});
