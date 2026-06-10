import type { Mock } from 'bun:test';
import { lintEntries } from '../commands/lint';
import { getEntriesFlat } from '../storage';
import { configureOutput, buildEnvelope } from '../utils/output';
import { findProjectFile } from '../store';
import fs from 'fs';

vi.mock('../storage', () => ({
  getEntriesFlat: vi.fn(() => ({})),
}));

vi.mock('../store', () => ({
  findProjectFile: vi.fn(() => null),
  clearProjectFileCache: vi.fn(),
}));

vi.mock('../formatting', () => ({
  color: {
    green: (s: string) => `[green]${s}[/green]`,
    gray: (s: string) => `[gray]${s}[/gray]`,
    yellow: (s: string) => `[yellow]${s}[/yellow]`,
    bold: (s: string) => `[bold]${s}[/bold]`,
  },
}));

vi.mock('fs', () => ({
  default: { readFileSync: vi.fn(), existsSync: vi.fn(() => false) },
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

const mockGetEntriesFlat = getEntriesFlat as Mock<typeof getEntriesFlat>;
const mockFindProjectFile = findProjectFile as Mock<typeof findProjectFile>;
const mockReadFileSync = fs.readFileSync as Mock<typeof fs.readFileSync>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lintEntries', () => {
  it('reports no issues when all entries use recommended namespaces', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'test',
      'commands.build': 'npm run build',
      'arch.storage': 'unified store',
    });

    lintEntries();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No schema issues'));
  });

  it('flags entries outside recommended namespaces', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'test',
      'custom.key': 'value',
      'random.stuff': 'data',
    });

    lintEntries();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 entries outside'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('custom'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('random'));
  });

  it('groups issues by namespace', () => {
    mockGetEntriesFlat.mockReturnValue({
      'bad.one': 'a',
      'bad.two': 'b',
      'other.thing': 'c',
    });

    lintEntries();

    // 3 total issues, grouped under "bad" and "other"
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('3 entries'));
  });

  it('outputs JSON when --json is set', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'test',
      'custom.key': 'value',
    });

    configureOutput({ json: true, command: 'lint' });
    lintEntries({});

    const parsed = buildEnvelope().result as { issues: { key: string; namespace: string }[]; allowed: string[] };
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].namespace).toBe('custom');
    expect(parsed.allowed).toContain('project');
    expect(parsed.allowed).toContain('commands');
  });

  it('outputs empty issues array in JSON when all valid', () => {
    mockGetEntriesFlat.mockReturnValue({ 'project.name': 'test' });

    configureOutput({ json: true, command: 'lint' });
    lintEntries({});

    const parsed = buildEnvelope().result as { issues: unknown[] };
    expect(parsed.issues).toHaveLength(0);
  });

  it('allows system namespace', () => {
    mockGetEntriesFlat.mockReturnValue({
      'system.llm.instructions': 'custom prompt',
    });

    lintEntries();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No schema issues'));
  });

  it('supports custom namespaces from _schema in project file', () => {
    mockFindProjectFile.mockReturnValue('/project/.codexcli.json');
    mockReadFileSync.mockReturnValue(JSON.stringify({
      entries: {},
      aliases: {},
      confirm: {},
      _schema: { namespaces: ['custom', 'myapp'] },
    }));
    mockGetEntriesFlat.mockReturnValue({
      'custom.key': 'value',
      'myapp.setting': 'data',
      'unknown.ns': 'flagged',
    });

    lintEntries();

    // Only "unknown" should be flagged — custom and myapp are allowed
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 entries outside'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('unknown'));
  });

  it('falls back to defaults when _schema has no namespaces', () => {
    mockFindProjectFile.mockReturnValue('/project/.codexcli.json');
    mockReadFileSync.mockReturnValue(JSON.stringify({
      entries: {},
      aliases: {},
      confirm: {},
      _schema: {},
    }));
    mockGetEntriesFlat.mockReturnValue({ 'custom.key': 'value' });

    lintEntries();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 entries outside'));
  });

  it('falls back to defaults when project file parse fails', () => {
    mockFindProjectFile.mockReturnValue('/project/.codexcli.json');
    mockReadFileSync.mockImplementation(() => { throw new Error('read error'); });
    mockGetEntriesFlat.mockReturnValue({ 'custom.key': 'value' });

    lintEntries();

    // Should still work with default namespaces
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 entries outside'));
  });

  it('respects --global flag', () => {
    mockGetEntriesFlat.mockReturnValue({});

    lintEntries({ global: true });

    expect(mockGetEntriesFlat).toHaveBeenCalledWith('global');
  });
});
