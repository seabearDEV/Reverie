import { spawn } from 'child_process';
import path from 'path';

export interface McpToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

export interface McpSession {
  /** Call a tool and wait for its result. */
  call(tool: string, args?: Record<string, unknown>): Promise<McpToolResult>;
  close(): void;
}

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
}

/**
 * One `dist/mcp-server.js` process, spoken to over stdio one request at a
 * time: what a client does. A confirm_token lives in the server's memory, so
 * the two steps of a gated `reverie_run` have to be calls to one process.
 * `env` is passed whole (Bun does not hand runtime env changes to a child
 * spawned without one).
 */
export async function openMcpSession(opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<McpSession> {
  const proc = spawn('bun', [path.resolve('dist/mcp-server.js')], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<number, (msg: RpcMessage) => void>();
  let buffered = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    for (let nl = buffered.indexOf('\n'); nl !== -1; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      let msg: RpcMessage;
      try { msg = JSON.parse(line) as RpcMessage; } catch { continue; }
      if (typeof msg.id === 'number') {
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const request = (method: string, params: unknown): Promise<RpcMessage> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { reject(new Error(`MCP ${method} timed out`)); }, 20_000);
    waiting.set(id, msg => { clearTimeout(timer); resolve(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    async call(tool, args = {}) {
      const msg = await request('tools/call', { name: tool, arguments: args });
      if (msg.error !== undefined) throw new Error(`MCP ${tool} failed: ${JSON.stringify(msg.error)}`);
      return msg.result as McpToolResult;
    },
    close() {
      proc.stdin.end();
      proc.kill();
    },
  };
}
