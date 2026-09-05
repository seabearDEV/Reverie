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
    red: (s: string) => s,
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

describe('showContext index-first (#188)', () => {
  const LONG = 'Headline about the store. ' + 'x'.repeat(300);

  it('standard tier renders pinned in full and the rest as index lines (arch.* included)', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
      'arch.store': LONG,
      'context.short': 'fits on one line',
    });
    showContext({ plain: true });
    const output = logged.join('\n');
    expect(output).toContain('project.name: reverie');
    expect(output).toContain('arch.store: Headline about the store.');
    expect(output).toContain('… [+');
    expect(output).not.toContain('x'.repeat(300));
    expect(output).toContain('context.short: fits on one line');
    expect(output).toContain('[tier: standard (3 entries: 1 in full, 2 indexed)');
    expect(output).toContain('rvr get <key>');
  });

  it('--json splits entries (full) from index (gist, bytes, truncated) and names the pinned set', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'reverie',
      'arch.store': LONG,
      'context.short': 'fits on one line',
    });
    const parsed = contextJson();
    expect(parsed.tier).toBe('standard');
    expect(parsed.entries).toEqual({ 'project.name': 'reverie' });
    expect(parsed.index['context.short']).toEqual({ gist: 'fits on one line', bytes: 16, truncated: false });
    expect(parsed.index['arch.store'].truncated).toBe(true);
    expect(parsed.index['arch.store'].bytes).toBe(LONG.length);
    expect(parsed.index['arch.store'].gist.length).toBeLessThanOrEqual(160);
    expect(parsed.pinned).toEqual(['project', 'commands', 'conventions']);
    expect(parsed.degraded).toBeUndefined();
  });

  it('essential tier renders the pinned namespaces only, no index', () => {
    mockGetEntriesFlat.mockReturnValue({ 'project.name': 'reverie', 'arch.store': LONG });
    showContext({ plain: true, tier: 'essential' });
    expect(logged.join('\n')).toContain('[tier: essential (1 entries) — use --tier full for complete context]');
    const parsed = contextJson({ tier: 'essential' });
    expect(parsed.entries).toEqual({ 'project.name': 'reverie' });
    expect(parsed.index).toBeUndefined();
  });

  it('full tier renders every value with no index and no footer', () => {
    mockGetEntriesFlat.mockReturnValue({ 'project.name': 'reverie', 'arch.store': LONG });
    showContext({ plain: true, tier: 'full' });
    const output = logged.join('\n');
    expect(output).toContain('x'.repeat(300));
    expect(output).not.toContain('[tier:');
    const parsed = contextJson({ tier: 'full' });
    expect(parsed.index).toBeUndefined();
    expect(parsed.pinned).toBeUndefined();
    expect(parsed.entries['arch.store']).toBe(LONG);
  });

  it('honors a system.bootstrap.pinned override', () => {
    mockGetEntriesFlat.mockReturnValue({
      'system.bootstrap.pinned': 'context',
      'project.name': 'reverie',
      'context.note': 'Note headline. ' + 'y'.repeat(300),
    });
    const parsed = contextJson();
    expect(parsed.pinned).toEqual(['context']);
    expect(parsed.entries['context.note']).toContain('y'.repeat(300));
    expect(parsed.index['project.name']).toEqual({ gist: 'reverie', bytes: 7, truncated: false });
  });

  it('warns and falls back on an unusable pinned override', () => {
    mockGetEntriesFlat.mockReturnValue({ 'system.bootstrap.pinned': ' , ', 'project.name': 'reverie' });
    configureOutput({ json: true, command: 'context' });
    showContext({});
    const envelope = buildEnvelope();
    expect((envelope.result as { pinned: string[] }).pinned).toEqual(['project', 'commands', 'conventions']);
    expect(envelope.warnings.some(w => w.code === 'CONFIG' && w.message.includes('system.bootstrap.pinned'))).toBe(true);
  });

  it('demotes pinned namespaces to index lines before dropping anything', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 1000 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.big': 'Headline. ' + 'p'.repeat(2000),
      'context.a': 'short',
    });
    showContext({ plain: true });
    const output = logged.join('\n');
    expect(output).toContain('[demoted to index: project.* (1 entry');
    expect(output).toContain('project.big: Headline.');
    expect(output).not.toContain('p'.repeat(2000));
    expect(output).not.toContain('[trimmed:');
    expect(output).toContain('context.a: short');

    const parsed = contextJson();
    expect(parsed.degraded).toBe(true);
    expect(parsed.demotedNamespaces).toEqual(['project.*']);
    expect(parsed.shedNamespaces).toEqual([]);
    expect(parsed.entries).toBeUndefined();
    expect(parsed.index['project.big'].truncated).toBe(true);
  });

  it('rejects an unknown tier with INVALID_INPUT', () => {
    mockGetEntriesFlat.mockReturnValue({ 'project.name': 'reverie' });
    configureOutput({ json: true, command: 'context' });
    showContext({ tier: 'bogus' });
    const envelope = buildEnvelope();
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.error?.message).toContain('bogus');
    process.exitCode = undefined;
  });

  it('--size-only reports index-shaped namespaces and the pinned set', () => {
    mockGetEntriesFlat.mockReturnValue({ 'project.name': 'reverie', 'context.gotcha': 'Gotcha headline. ' + 'z'.repeat(300) });
    showContext({ plain: true, sizeOnly: true });
    const output = logged.join('\n');
    expect(output).toContain('(index)');
    expect(output).toContain('Pinned (rendered in full): project, commands, conventions');
    const result = contextJson({ sizeOnly: true });
    const rows = Object.fromEntries(result.namespaces.map((n: { ns: string; bytes: number; shape: string }) => [n.ns, n]));
    expect(rows.project.shape).toBe('full');
    expect(rows.context.shape).toBe('index');
    expect(rows.context.bytes).toBeLessThan(300);
    expect(result.pinned).toEqual(['project', 'commands', 'conventions']);
  });
});
