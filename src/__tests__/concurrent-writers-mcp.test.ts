/**
 * #254 over MCP: the tool handlers that read, change and write the store
 * keep another process's writes. Same harness as concurrent-writers.test.ts
 * (helpers/interleave.ts): process B commits a write just before each of the
 * handler's store-lock acquisitions, and once before the call. The server
 * runs in-process with the real store; only the SDK transport is stubbed so
 * the handlers can be called directly.
 */
import {
  useTempGlobalStore, onDisk, seed, entryKeys, interleave, survived,
  bEntry, bAlias, bMixed,
} from './helpers/interleave';

type ToolHandler = (params: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const toolHandlers: Record<string, ToolHandler> = {};

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class MockMcpServer {
    tool = vi.fn((name: string, _desc: string, schema: unknown, handler?: ToolHandler) => {
      toolHandlers[name] = handler ?? (schema as ToolHandler);
    });
    connect = vi.fn();
  }
  return { McpServer: MockMcpServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

useTempGlobalStore();

beforeAll(async () => {
  await import('../mcp-server');
});

async function call(tool: string, params: Record<string, unknown>): Promise<void> {
  const result = await toolHandlers[tool](params);
  if (result.isError) throw new Error(`${tool} failed: ${result.content.map(c => c.text).join(' ')}`);
}

describe('#254 over MCP: a write by another process survives', () => {
  it('reverie_copy of a namespace keeps the entries set meanwhile', async () => {
    seed({ entries: { src: { a: '1', b: '2' } } });
    const bKeys = await interleave(() => call('reverie_copy', { source: 'src', dest: 'dst', scope: 'global' }), bEntry);
    const keys = entryKeys(onDisk());
    for (const k of bKeys) expect(keys).toContain(k);
    expect(keys).toEqual(expect.arrayContaining(['src.a', 'src.b', 'dst.a', 'dst.b']));
  });

  it('reverie_rename of a namespace keeps what was written meanwhile, and re-points its alias', async () => {
    seed({ entries: { src: { a: '1', b: '2' } }, aliases: { sa: 'src.a' } });
    const bKeys = await interleave(() => call('reverie_rename', { oldKey: 'src', newKey: 'moved', scope: 'global' }), bMixed);
    const d = onDisk();
    for (const k of bKeys) expect(survived(d, k)).toBe(true);
    expect(entryKeys(d)).toEqual(expect.arrayContaining(['moved.a', 'moved.b']));
    expect(entryKeys(d).filter(k => k.startsWith('src.'))).toEqual([]);
    expect(d.aliases.sa).toBe('moved.a');
  });

  it('reverie_remove of an alias keeps the aliases set meanwhile', async () => {
    seed({ entries: { x: { y: 'v' } }, aliases: { a1: 'x.y' } });
    const bNames = await interleave(() => call('reverie_remove', { key: 'a1', is_alias: true, scope: 'global' }), bAlias);
    const d = onDisk();
    for (const n of bNames) expect(d.aliases[n]).toBeDefined();
    expect(d.aliases.a1).toBeUndefined();
  });

  it('reverie_remove of an entry keeps what was written meanwhile', async () => {
    seed({ entries: { a: { x: '1' } }, aliases: { ax: 'a.x' }, confirm: { 'a.x': true } });
    const bKeys = await interleave(() => call('reverie_remove', { key: 'a', scope: 'global' }), bMixed);
    const d = onDisk();
    for (const k of bKeys) expect(survived(d, k)).toBe(true);
    expect(entryKeys(d)).not.toContain('a.x');
    expect(d.aliases.ax).toBeUndefined();
    expect(d.confirm['a.x']).toBeUndefined();
  });

  it('reverie_import with merge keeps the entries set meanwhile', async () => {
    seed({ entries: { old: { k: '1' } } });
    const bKeys = await interleave(() => call('reverie_import', {
      type: 'entries', merge: true, scope: 'global', data: JSON.stringify({ imported: { k: '2' } }),
    }), bEntry);
    const keys = entryKeys(onDisk());
    for (const k of bKeys) expect(keys).toContain(k);
    expect(keys).toEqual(expect.arrayContaining(['old.k', 'imported.k']));
  });
});
