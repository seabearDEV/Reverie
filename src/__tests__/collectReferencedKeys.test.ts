import type { Mock } from 'bun:test';
import { execSync } from 'child_process';
import { collectReferencedKeys } from '../utils/interpolate';
import { getValue } from '../storage';
import { resolveKey } from '../alias';

// Same mock shape as interpolate.test.ts.
vi.mock('../storage', () => ({
  getValue: vi.fn(),
  loadData: vi.fn(() => ({})),
}));
vi.mock('../alias', () => ({
  resolveKey: vi.fn((key: string) => key),
  loadAliases: vi.fn(() => ({})),
}));
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockGetValue = getValue as Mock<typeof getValue>;
const mockResolveKey = resolveKey as Mock<typeof resolveKey>;
const mockExecSync = execSync as Mock<typeof execSync>;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveKey.mockImplementation((key: string) => key);
});

// #158 regression: the confirm gate reads this key set. If a referenced key
// is missing here, its confirm tripwire is silently bypassed at run time.
describe('collectReferencedKeys (#158)', () => {
  it('finds a key referenced via ${key} value-inline', () => {
    mockGetValue.mockImplementation((k: string) => (k === 'deploy-prod' ? 'kubectl apply' : undefined));
    const keys = collectReferencedKeys('npm run build && ${deploy-prod}');
    expect(keys.has('deploy-prod')).toBe(true);
  });

  it('finds a key referenced via $(key) exec — WITHOUT executing it', () => {
    mockGetValue.mockImplementation((k: string) => (k === 'deploy-prod' ? 'kubectl apply' : undefined));
    const keys = collectReferencedKeys('echo hi && $(deploy-prod)');
    expect(keys.has('deploy-prod')).toBe(true);
    // The whole point of the collect pass: enumerate, never execute.
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('follows transitive references (a → b)', () => {
    mockGetValue.mockImplementation((k: string) => {
      if (k === 'a') return 'run ${b}';
      if (k === 'b') return 'gated-cmd';
      return undefined;
    });
    const keys = collectReferencedKeys('${a}');
    expect(keys.has('a')).toBe(true);
    expect(keys.has('b')).toBe(true);
  });

  it('resolves aliases so the gate sees the real target key', () => {
    mockResolveKey.mockImplementation((k: string) => (k === 'dp' ? 'deploy-prod' : k));
    mockGetValue.mockImplementation((k: string) => (k === 'deploy-prod' ? 'kubectl apply' : undefined));
    const keys = collectReferencedKeys('${dp}');
    expect(keys.has('deploy-prod')).toBe(true);
  });

  it('returns empty for a value with no references', () => {
    expect(collectReferencedKeys('npm run build').size).toBe(0);
  });
});
