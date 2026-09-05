import {
  partitionByTier,
  resolvePinnedNamespaces,
  isContextTier,
  DEFAULT_PINNED_NAMESPACES,
  PINNED_CONFIG_KEY,
  ESSENTIAL_PREFIXES,
} from '../commands/context';

const flat: Record<string, string> = {
  'project.name': 'test',
  'project.stack': 'Node.js',
  'commands.build': 'npm run build',
  'conventions.tests': 'Vitest',
  'arch.storage': 'Unified data.json',
  'arch.mcp': 'MCP SDK',
  'files.entry': 'src/index.ts',
  'context.ci': 'GitHub Actions',
  'deps.express': 'Express',
};

describe('partitionByTier (#188)', () => {
  const pinned = resolvePinnedNamespaces(flat).prefixes;

  it('full tier puts everything in full', () => {
    const r = partitionByTier(flat, 'full', pinned);
    expect(r.full).toEqual(flat);
    expect(r.rest).toEqual({});
  });

  it('essential tier renders the pinned namespaces only', () => {
    const r = partitionByTier(flat, 'essential', pinned);
    expect(Object.keys(r.full).sort()).toEqual(['commands.build', 'conventions.tests', 'project.name', 'project.stack']);
    expect(r.rest).toEqual({});
  });

  it('standard tier indexes everything else, arch.* included', () => {
    const r = partitionByTier(flat, 'standard', pinned);
    expect(Object.keys(r.full).length).toBe(4);
    expect(Object.keys(r.rest).sort()).toEqual(['arch.mcp', 'arch.storage', 'context.ci', 'deps.express', 'files.entry']);
  });

  it('handles empty input', () => {
    expect(partitionByTier({}, 'full', pinned)).toEqual({ full: {}, rest: {} });
    expect(partitionByTier({}, 'essential', pinned)).toEqual({ full: {}, rest: {} });
    expect(partitionByTier({}, 'standard', pinned)).toEqual({ full: {}, rest: {} });
  });
});

describe('resolvePinnedNamespaces (#188)', () => {
  it('defaults to project/commands/conventions', () => {
    const r = resolvePinnedNamespaces({});
    expect(r.namespaces).toEqual([...DEFAULT_PINNED_NAMESPACES]);
    expect(r.prefixes).toEqual([...ESSENTIAL_PREFIXES]);
    expect(r.prefixes).toEqual(['project.', 'commands.', 'conventions.']);
    expect(r.warning).toBeUndefined();
  });

  it('reads a comma-separated override from system.bootstrap.pinned', () => {
    const r = resolvePinnedNamespaces({ [PINNED_CONFIG_KEY]: 'conventions, commands., context' });
    expect(r.namespaces).toEqual(['conventions', 'commands', 'context']);
    expect(r.prefixes).toEqual(['conventions.', 'commands.', 'context.']);
    expect(r.warning).toBeUndefined();
  });

  it('dedupes repeated names', () => {
    const r = resolvePinnedNamespaces({ [PINNED_CONFIG_KEY]: 'context,context' });
    expect(r.namespaces).toEqual(['context']);
  });

  it('falls back to the default set with a warning on an unusable value', () => {
    const empty = resolvePinnedNamespaces({ [PINNED_CONFIG_KEY]: ' , ' });
    expect(empty.namespaces).toEqual([...DEFAULT_PINNED_NAMESPACES]);
    expect(empty.warning).toContain(PINNED_CONFIG_KEY);
    const bad = resolvePinnedNamespaces({ [PINNED_CONFIG_KEY]: 'a b/c' });
    expect(bad.namespaces).toEqual([...DEFAULT_PINNED_NAMESPACES]);
    expect(bad.warning).toBeDefined();
  });
});

describe('isContextTier', () => {
  it('accepts the three tiers and rejects anything else', () => {
    expect(isContextTier('essential')).toBe(true);
    expect(isContextTier('standard')).toBe(true);
    expect(isContextTier('full')).toBe(true);
    expect(isContextTier('bogus')).toBe(false);
    expect(isContextTier('')).toBe(false);
  });
});
