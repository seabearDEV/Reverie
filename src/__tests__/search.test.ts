import { searchEntries } from '../commands/search';
import { configureOutput, buildEnvelope } from '../utils/output';

vi.mock('../storage', () => ({
  getEntriesFlat: vi.fn(() => ({
    'server.prod.ip': '192.168.1.100',
    'server.prod.port': '8080',
    'server.dev.ip': '127.0.0.1',
    'server.dev.port': '3000',
    'app.name': 'TestApp',
    'app.version': '1.0.0',
    'commands.build': 'npm run build',
    'commands.test': 'npm test',
  })),
  loadData: vi.fn(() => ({})),
}));

vi.mock('../alias', () => ({
  loadAliases: vi.fn(() => ({
    srv: 'server.prod.ip',
    build: 'commands.build',
  })),
  buildKeyToAliasMap: vi.fn(() => ({
    'server.prod.ip': 'srv',
    'commands.build': 'build',
  })),
}));

vi.mock('../formatting', () => ({
  formatKeyValue: vi.fn(),
  displayTree: vi.fn(),
  highlightMatch: vi.fn((text: string) => text),
  color: {
    cyan: (t: string) => t,
    gray: (t: string) => t,
    yellow: (t: string) => t,
    bold: (t: string) => t,
  },
}));

vi.mock('../utils/interpolate', () => ({
  interpolate: vi.fn((v: string) => v),
}));

vi.mock('../utils/crypto', () => ({
  isEncrypted: vi.fn((v: string) => v.startsWith('encrypted::')),
}));

describe('searchEntries', () => {
  let consoleSpy: SpyInstance;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('finds entries matching a key pattern', () => {
    const { dataCount, aliasCount } = searchEntries('server');
    expect(dataCount).toBe(4); // all server.* entries
  });

  it('finds entries matching a value pattern', () => {
    const { dataCount } = searchEntries('192.168');
    expect(dataCount).toBe(1);
  });

  it('returns zero for no matches', () => {
    const { dataCount, aliasCount } = searchEntries('zzzzz');
    expect(dataCount).toBe(0);
    expect(aliasCount).toBe(0);
  });

  it('searches aliases too', () => {
    const { aliasCount } = searchEntries('srv');
    expect(aliasCount).toBe(1);
  });

  it('supports --entries flag (aliases excluded)', () => {
    const { dataCount, aliasCount } = searchEntries('build', { entries: true });
    expect(dataCount).toBeGreaterThan(0);
    expect(aliasCount).toBe(0);
  });

  it('supports --aliases flag (entries excluded)', () => {
    const { dataCount, aliasCount } = searchEntries('build', { aliases: true });
    expect(dataCount).toBe(0);
    expect(aliasCount).toBeGreaterThan(0);
  });

  it('rejects mutually exclusive --keys and --values', () => {
    const { dataCount, aliasCount } = searchEntries('test', { keys: true, values: true });
    expect(dataCount).toBe(0);
    expect(aliasCount).toBe(0);
    expect(process.exitCode).toBe(1);
  });

  it('supports regex search', () => {
    const { dataCount } = searchEntries('^\\d+\\.\\d+\\.\\d+', { regex: true });
    expect(dataCount).toBeGreaterThan(0);
  });

  it('returns error for invalid regex', () => {
    const { dataCount } = searchEntries('[invalid regex', { regex: true });
    expect(dataCount).toBe(0);
    expect(process.exitCode).toBe(1);
  });

  it('supports JSON output', () => {
    // #117: JSON output is recorded into the envelope result, not console.log'd.
    configureOutput({ json: true, command: 'find' });
    searchEntries('server', {});
    const result = buildEnvelope().result as { entries?: Record<string, string> };
    expect(result.entries).toBeDefined();
  });

  it('supports --keys flag (value matches excluded)', () => {
    // 'server' is in keys but not in values
    const { dataCount } = searchEntries('server', { keys: true });
    expect(dataCount).toBe(4);
  });

  it('--keys projects values out of the JSON result (#127, MCP keysOnly parity)', () => {
    configureOutput({ json: true, command: 'find' });
    searchEntries('server', { keys: true });
    const result = buildEnvelope().result as { entries?: string[] };
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.entries).toHaveLength(4);
    expect(JSON.stringify(result.entries)).not.toContain('192.168.1.100');
  });

  it('supports --values flag (key matches excluded)', () => {
    // '8080' is in values but not keys
    const { dataCount } = searchEntries('8080', { values: true });
    expect(dataCount).toBe(1);
  });

  it('case-insensitive search', () => {
    const { dataCount } = searchEntries('TESTAPP');
    expect(dataCount).toBe(1);
  });
});
