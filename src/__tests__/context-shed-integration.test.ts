// Integration tests for the reverie_context size-budget shed wiring (#100).
// Verifies that showContext (CLI) actually invokes the shed function and
// surfaces the right notice + JSON fields end-to-end.

import { showContext } from '../commands/context';

vi.mock('../storage', () => ({
  getEntriesFlat: vi.fn(),
}));
vi.mock('../alias', () => ({
  loadAliases: vi.fn(() => ({})),
}));
vi.mock('../store', () => ({
  loadMeta: vi.fn(() => ({})),
  loadMetaMerged: vi.fn(() => ({})),
  getStalenessTag: vi.fn(() => ''),
}));
vi.mock('../config', () => ({
  loadConfig: vi.fn(() => ({ bootstrap_max_response_bytes: 50 * 1024 })),
  DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES: 38 * 1024,
}));
vi.mock('../utils/handoff', () => ({
  HANDOFF_KEY: 'context.next_session',
  buildHandoffBanner: vi.fn(() => null),
}));
vi.mock('../formatting', () => ({
  color: {
    cyan: (s: string) => s,
    yellow: (s: string) => s,
    gray: (s: string) => s,
    bold: (s: string) => s,
    green: (s: string) => s,
    white: (s: string) => s,
  },
}));
vi.mock('../utils/binaryName', () => ({
  getBinaryName: () => 'rvr',
}));

import type { Mock } from 'bun:test';
import { getEntriesFlat } from '../storage';
import { loadConfig } from '../config';
import { configureOutput, buildEnvelope } from '../utils/output';

const mockGetEntriesFlat = getEntriesFlat as Mock<typeof getEntriesFlat>;
const mockLoadConfig = loadConfig as Mock<typeof loadConfig>;

// #117: JSON output now goes inside the envelope's `result` (emitted by the
// instrumentation wrapper at runtime). In a direct unit call we enable JSON
// mode, invoke showContext, and read the recorded result.
 
function contextJson(opts: Parameters<typeof showContext>[0] = {}): any {
  configureOutput({ json: true, command: 'context' });
  showContext(opts);
  return buildEnvelope().result;
}

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 50 * 1024 } as ReturnType<typeof loadConfig>);
  vi.spyOn(console, 'log').mockImplementation((s: unknown) => {
    logged.push(typeof s === 'string' ? s : JSON.stringify(s));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('showContext shed integration (#100)', () => {
  it('does not shed under-budget store (no notice in output)', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
      'commands.build': 'npm run build',
    });
    showContext({ plain: true });
    const output = logged.join('\n');
    expect(output).not.toContain('[trimmed:');
    expect(output).toContain('project.name: reverie');
  });

  it('sheds files.* and prepends notice when over budget', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 200 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
      'files.a': 'x'.repeat(200),
      'files.b': 'x'.repeat(200),
    });
    showContext({ plain: true });
    const output = logged.join('\n');
    expect(output).toContain('[trimmed:');
    expect(output).toContain('files.*');
    expect(output).toContain('reverie_get');
    // project.name preserved (never-shed)
    expect(output).toContain('project.name');
    // files.* shed
    expect(output).not.toContain('files.a:');
  });

  it('--json output includes degraded + shedNamespaces when shed fires', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 200 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
      'files.a': 'x'.repeat(200),
      'files.b': 'x'.repeat(200),
    });
    const parsed = contextJson();
    expect(parsed.degraded).toBe(true);
    expect(parsed.shedNamespaces).toContain('files.*');
    expect(parsed.entries['project.name']).toBe('reverie');
    expect(parsed.entries['files.a']).toBeUndefined();
  });

  it('--json output omits degraded when no shed fires', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
    });
    const parsed = contextJson();
    expect(parsed.degraded).toBeUndefined();
    expect(parsed.shedNamespaces).toBeUndefined();
  });

  it('tier:"full" bypasses shed even when over budget', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 200 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
      'files.a': 'x'.repeat(200),
      'files.b': 'x'.repeat(200),
    });
    const parsed = contextJson({ tier: "full" });
    expect(parsed.degraded).toBeUndefined();
    expect(parsed.entries['files.a']).toBeDefined();
    expect(parsed.entries['files.b']).toBeDefined();
  });

  it('surfaces pathological-overflow notice when never-shed alone exceeds budget', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 50 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'x'.repeat(500),  // never-shed, alone > budget
      'files.shedme': 'x'.repeat(100),
    });
    showContext({ plain: true });
    const output = logged.join('\n');
    expect(output).toContain('still exceeds budget');
    expect(output).toContain('bootstrap_max_response_bytes');
    expect(output).toContain('reverie_config_set');
  });

  it('--json output includes pathologicalOverflow flag when triggered', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 50 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'x'.repeat(500),
      'files.shedme': 'x'.repeat(100),
    });
    const parsed = contextJson();
    expect(parsed.pathologicalOverflow).toBe(true);
    expect(parsed.degraded).toBe(true);
  });

  it('RVR_BOOTSTRAP_MAX_BYTES env wins over config', () => {
    const original = process.env.RVR_BOOTSTRAP_MAX_BYTES;
    process.env.RVR_BOOTSTRAP_MAX_BYTES = '200';
    try {
      // Config says 50KB (no shed expected) but env says 200B (shed expected).
      mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 50 * 1024 } as ReturnType<typeof loadConfig>);
      mockGetEntriesFlat.mockReturnValue({
        'project.name': 'reverie',
        'files.a': 'x'.repeat(200),
        'files.b': 'x'.repeat(200),
      });
      const parsed = contextJson();
      expect(parsed.degraded).toBe(true);
    } finally {
      if (original === undefined) delete process.env.RVR_BOOTSTRAP_MAX_BYTES;
      else process.env.RVR_BOOTSTRAP_MAX_BYTES = original;
    }
  });
});

describe('showContext --size-only (#127)', () => {
  it('reports per-namespace counts and budget without entry content', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
      'files.a': 'x'.repeat(100),
    });
    showContext({ plain: true, sizeOnly: true });
    const output = logged.join('\n');
    expect(output).toContain('Context size (tier: standard)');
    expect(output).toContain('total');
    expect(output).toContain('Budget:');
    expect(output).not.toContain('reverie');
    expect(output).not.toContain('xxxx');
  });

  it('returns the structured report in JSON mode', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
      'context.gotcha': 'beware',
    });
    const result = contextJson({ sizeOnly: true });
    expect(result.totalEntries).toBe(2);
    expect(result.budgetBytes).toBe(50 * 1024);
    expect(result.namespaces.map((n: { ns: string }) => n.ns).sort()).toEqual(['context', 'project']);
    expect(JSON.stringify(result)).not.toContain('beware');
  });

  it('respects the tier filter', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
      'arch.pattern': 'MVC',
    });
    const result = contextJson({ sizeOnly: true, tier: 'essential' });
    expect(result.totalEntries).toBe(1);
    expect(result.namespaces.map((n: { ns: string }) => n.ns)).toEqual(['project']);
  });
});
