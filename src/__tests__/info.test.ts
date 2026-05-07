import * as fs from 'fs';
import { showInfo } from '../commands/info';
import { loadConfig } from '../config';
import { getEntriesFlat } from '../storage';
import { loadAliases } from '../alias';

vi.mock('../config', () => ({
  loadConfig: vi.fn(() => ({ colors: false, theme: 'default' })),
}));

vi.mock('../storage', () => ({
  getEntriesFlat: vi.fn(() => ({
    'server.ip': '192.168.1.1',
    'server.port': '22',
    'db.host': 'localhost',
  })),
}));

vi.mock('../alias', () => ({
  loadAliases: vi.fn(() => ({
    myip: 'server.ip',
    prod: 'server.production',
  })),
}));

vi.mock('../confirm', () => ({
  loadConfirmKeys: vi.fn(() => ({})),
}));

vi.mock('../store', () => ({
  findProjectFile: vi.fn(() => null),
  clearProjectFileCache: vi.fn(),
}));

vi.mock('../utils/paths', () => ({
  getUnifiedDataFilePath: vi.fn(() => '/mock/data.json'),
  getConfigFilePath: vi.fn(() => '/mock/config.json'),
  getGlobalStoreDirPath: vi.fn(() => '/mock/store'),
  isDataDirectoryFromEnv: vi.fn(() => false),
}));

vi.mock('fs', () => {
  const mock = {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue('{}'),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 0 }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  return { default: mock, ...mock };
});

describe('showInfo', () => {
  let consoleSpy: SpyInstance;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function getOutput(): string {
    return consoleSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  }

  it('outputs version from package.json', async () => {
    const { version } = await import('../../package.json');
    showInfo();
    expect(getOutput()).toContain(version);
  });

  it('shows correct entry count', () => {
    showInfo();
    expect(getOutput()).toContain('3');
  });

  it('shows correct alias count', () => {
    showInfo();
    expect(getOutput()).toContain('2');
  });

  it('shows storage paths', () => {
    showInfo();
    const output = getOutput();
    expect(output).toContain('/mock/store');
    expect(output).toContain('config.json');
  });

  it('annotates Data line with (RVR_DATA_DIR) when env var is set', async () => {
    const pathsMock = await import('../utils/paths');
    (pathsMock.isDataDirectoryFromEnv as Mock).mockReturnValueOnce(true);
    showInfo();
    expect(getOutput()).toContain('(RVR_DATA_DIR)');
  });

  it('does not annotate Data line when env var is not set', () => {
    showInfo();
    expect(getOutput()).not.toContain('(RVR_DATA_DIR)');
  });

  it('shows version label', () => {
    showInfo();
    const output = getOutput();
    expect(output).toContain('Version:');
  });
});

describe('showInfo with empty data', () => {
  let consoleSpy: SpyInstance;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation();
    (getEntriesFlat as Mock).mockReturnValue({});
    (loadAliases as Mock).mockReturnValue({});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    (getEntriesFlat as Mock).mockReturnValue({
      'server.ip': '192.168.1.1',
      'server.port': '22',
      'db.host': 'localhost',
    });
    (loadAliases as Mock).mockReturnValue({
      myip: 'server.ip',
      prod: 'server.production',
    });
  });

  it('handles 0 entries and 0 aliases', () => {
    showInfo();
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    // Should contain "0" for both counts
    const lines = output.split('\n');
    const entriesLine = lines.find(l => l.includes('Entries:'));
    const aliasesLine = lines.find(l => l.includes('Aliases:'));
    expect(entriesLine).toContain('0');
    expect(aliasesLine).toContain('0');
  });
});

describe('showInfo shell completions', () => {
  let consoleSpy: SpyInstance;
  let originalShell: string | undefined;
  let originalArgv1: string;

  beforeEach(() => {
    originalArgv1 = process.argv[1];
    process.argv[1] = '/usr/local/bin/rvr';
    consoleSpy = vi.spyOn(console, 'log').mockImplementation();
    originalShell = process.env.SHELL;
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    consoleSpy.mockRestore();
    process.env.SHELL = originalShell;
  });

  function getOutput(): string {
    return consoleSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  }

  it('shows installed when rc file contains rvr completions', () => {
    process.env.SHELL = '/bin/zsh';
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockReturnValue('eval "$(rvr config completions zsh)"');

    showInfo();
    expect(getOutput()).toContain('installed');
  });

  it('shows not installed when rc file does not contain rvr completions', () => {
    process.env.SHELL = '/bin/zsh';
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockReturnValue('# empty rc');

    showInfo();
    expect(getOutput()).toContain('not installed');
  });

  it('shows not installed when shell is unrecognized', () => {
    process.env.SHELL = '/bin/fish';
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockReturnValue('{}');

    showInfo();
    expect(getOutput()).toContain('not installed');
  });
});
