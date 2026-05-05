// Integration tests for the codex_context size-budget shed wiring (#100).
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
  getBinaryName: () => 'ccli',
}));

import { getEntriesFlat } from '../storage';
import { loadConfig } from '../config';

const mockGetEntriesFlat = vi.mocked(getEntriesFlat);
const mockLoadConfig = vi.mocked(loadConfig);

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
      'project.name': 'codexcli',
      'commands.build': 'npm run build',
    });
    showContext({ plain: true });
    const output = logged.join('\n');
    expect(output).not.toContain('[trimmed:');
    expect(output).toContain('project.name: codexcli');
  });

  it('sheds files.* and prepends notice when over budget', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 200 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'codexcli',
      'files.a': 'x'.repeat(200),
      'files.b': 'x'.repeat(200),
    });
    showContext({ plain: true });
    const output = logged.join('\n');
    expect(output).toContain('[trimmed:');
    expect(output).toContain('files.*');
    expect(output).toContain('codex_get');
    // project.name preserved (never-shed)
    expect(output).toContain('project.name');
    // files.* shed
    expect(output).not.toContain('files.a:');
  });

  it('--json output includes degraded + shedNamespaces when shed fires', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 200 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'codexcli',
      'files.a': 'x'.repeat(200),
      'files.b': 'x'.repeat(200),
    });
    showContext({ json: true });
    const parsed = JSON.parse(logged.join('\n'));
    expect(parsed.degraded).toBe(true);
    expect(parsed.shedNamespaces).toContain('files.*');
    expect(parsed.entries['project.name']).toBe('codexcli');
    expect(parsed.entries['files.a']).toBeUndefined();
  });

  it('--json output omits degraded when no shed fires', () => {
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'codexcli',
    });
    showContext({ json: true });
    const parsed = JSON.parse(logged.join('\n'));
    expect(parsed.degraded).toBeUndefined();
    expect(parsed.shedNamespaces).toBeUndefined();
  });

  it('tier:"full" bypasses shed even when over budget', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 200 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'codexcli',
      'files.a': 'x'.repeat(200),
      'files.b': 'x'.repeat(200),
    });
    showContext({ json: true, tier: 'full' });
    const parsed = JSON.parse(logged.join('\n'));
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
    expect(output).toContain('codex_config_set');
  });

  it('--json output includes pathologicalOverflow flag when triggered', () => {
    mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 50 } as ReturnType<typeof loadConfig>);
    mockGetEntriesFlat.mockReturnValue({
      'project.name': 'x'.repeat(500),
      'files.shedme': 'x'.repeat(100),
    });
    showContext({ json: true });
    const parsed = JSON.parse(logged.join('\n'));
    expect(parsed.pathologicalOverflow).toBe(true);
    expect(parsed.degraded).toBe(true);
  });

  it('CODEX_BOOTSTRAP_MAX_BYTES env wins over config', () => {
    const original = process.env.CODEX_BOOTSTRAP_MAX_BYTES;
    process.env.CODEX_BOOTSTRAP_MAX_BYTES = '200';
    try {
      // Config says 50KB (no shed expected) but env says 200B (shed expected).
      mockLoadConfig.mockReturnValue({ bootstrap_max_response_bytes: 50 * 1024 } as ReturnType<typeof loadConfig>);
      mockGetEntriesFlat.mockReturnValue({
        'project.name': 'codexcli',
        'files.a': 'x'.repeat(200),
        'files.b': 'x'.repeat(200),
      });
      showContext({ json: true });
      const parsed = JSON.parse(logged.join('\n'));
      expect(parsed.degraded).toBe(true);
    } finally {
      if (original === undefined) delete process.env.CODEX_BOOTSTRAP_MAX_BYTES;
      else process.env.CODEX_BOOTSTRAP_MAX_BYTES = original;
    }
  });
});
