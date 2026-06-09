/* eslint-disable @typescript-eslint/no-explicit-any */
// #126: the MCP handshake is per-session fixed cost every client pays
// before the first tool call. MCP clients truncate server instructions
// around 2KB, and tools/list rides along in full. These caps make the
// diet a regression test — if you grow a blob past its cap, cut
// somewhere else or justify raising the cap in review.

type RegisteredTool = { name: string; description: string; schema: Record<string, any> };
const registeredTools: RegisteredTool[] = [];

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class MockMcpServer {
    tool = vi.fn((name: string, description: string, schema: any, handler?: any) => {
      registeredTools.push({ name, description, schema: handler ? schema : {} });
    });
    connect = vi.fn().mockResolvedValue(undefined as never);
  }
  return { McpServer: MockMcpServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

import { DEFAULT_LLM_INSTRUCTIONS } from '../llm-instructions';

const INSTRUCTIONS_CAP_BYTES = 2048;
const TOTAL_DESCRIPTIONS_CAP_BYTES = 3000;
const PER_TOOL_DESCRIPTION_CAP_BYTES = 350;
const TOTAL_PARAM_DESCRIBE_CAP_BYTES = 5500;

beforeAll(async () => {
  await import('../mcp-server');
});

describe('MCP handshake size budget (#126)', () => {
  it('DEFAULT_LLM_INSTRUCTIONS fits in the ~2KB client truncation window', () => {
    expect(Buffer.byteLength(DEFAULT_LLM_INSTRUCTIONS, 'utf8')).toBeLessThanOrEqual(INSTRUCTIONS_CAP_BYTES);
  });

  it('registers the expected tool count', () => {
    expect(registeredTools.length).toBe(19);
  });

  it('keeps every tool description under the per-tool cap', () => {
    for (const t of registeredTools) {
      expect(
        Buffer.byteLength(t.description, 'utf8'),
        `description of ${t.name} exceeds ${PER_TOOL_DESCRIPTION_CAP_BYTES}B`
      ).toBeLessThanOrEqual(PER_TOOL_DESCRIPTION_CAP_BYTES);
    }
  });

  it('keeps the summed tool descriptions under the total cap', () => {
    const total = registeredTools.reduce(
      (sum, t) => sum + Buffer.byteLength(t.description, 'utf8'), 0);
    expect(total).toBeLessThanOrEqual(TOTAL_DESCRIPTIONS_CAP_BYTES);
  });

  it('keeps the summed param .describe() strings under the total cap', () => {
    let total = 0;
    for (const t of registeredTools) {
      for (const field of Object.values(t.schema)) {
        const desc = (field as any)?.description;
        if (typeof desc === 'string') total += Buffer.byteLength(desc, 'utf8');
      }
    }
    expect(total).toBeGreaterThan(0); // zod description introspection still works
    expect(total).toBeLessThanOrEqual(TOTAL_PARAM_DESCRIBE_CAP_BYTES);
  });
});
