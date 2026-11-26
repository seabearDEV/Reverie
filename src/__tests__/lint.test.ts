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
  // #256: setConfirm's read of both stores; not used here. A throw, so a
  // call can never fall through to the real store.
  inspectBothStores: vi.fn(() => { throw new Error('inspectBothStores is not mocked in this suite'); }),
  findProjectFile: vi.fn(() => null),
  clearProjectFileCache: vi.fn(),
}));

vi.mock('../formatting', () => ({
  color: {
    green: (s: string) => `[green]${s}[/green]`,
    gray: (s: string) => `[gray]${s}[/gray]`,
    yellow: (s: string) => `[yellow]${s}[/yellow]`,
    bold: (s: string) => `[bold]${s}[/bold]`,
    red: (s: string) => `[red]${s}[/red]`,
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

describe('lintEntries — keys that cannot both be stored (#216)', () => {
  afterEach(() => { process.exitCode = 0; });

  it('flags a pair that differs only by case and fails the command', () => {
    mockGetEntriesFlat.mockReturnValue({ 'arch.authFlow': 'alice', 'arch.authflow': 'bob', 'arch.api': 'x' });
    lintEntries();
    const out = (console.log as Mock<typeof console.log>).mock.calls.map(c => String(c[0])).join('\n');
    expect(out).toContain('1 pair of keys cannot both be stored');
    expect(out).toContain("'arch.authFlow' and 'arch.authflow'");
    expect(out).toContain('Rename or remove one key of each pair.');
    expect(process.exitCode).toBe(1);
  });

  it('JSON: the pair is in the payload and the envelope fails with INVALID_INPUT', () => {
    mockGetEntriesFlat.mockReturnValue({ 'arch.authFlow': 'alice', 'arch.authflow': 'bob' });
    configureOutput({ json: true, command: 'lint' });
    lintEntries({ json: true });
    const env = buildEnvelope();
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect((env.result as { caseCollisions: { keys: string[] }[] }).caseCollisions).toEqual([{ keys: ['arch.authFlow', 'arch.authflow'] }]);
    configureOutput({ json: false, command: 'lint' });
  });

  it('a store with no such pair is unaffected', () => {
    mockGetEntriesFlat.mockReturnValue({ 'arch.api': 'x', 'arch.api2': 'y', 'archive.old': 'z' });
    process.exitCode = 0;
    lintEntries();
    const out = (console.log as Mock<typeof console.log>).mock.calls.map(c => String(c[0])).join('\n');
    expect(out).not.toContain('cannot both be stored');
    expect(process.exitCode).toBe(0);
  });
});
