// The name resolver's decisions, table by table, over views built in memory:
// no store, no disk. Each case also says which parts of the view the
// resolver read — a lookup must read only what its context needs (loading a
// store reports its unreadable files, and the first look for a project
// store can migrate a legacy one).
import {
  type AliasMap,
  type NameContext,
  type NameView,
  aliasListedIn,
  aliasWriteBase,
  aliasWriteLayers,
  aliasesSeen,
  chainMemberContext,
  gateNamesOf,
  readsFallThrough,
  referenceContext,
  repointAliases,
  resolveName,
  typedContext,
  withAlias,
} from '../utils/nameResolver';

type Part = 'hasProjectStore' | 'projectAliases' | 'globalAliases' | 'unusedProject';

/** A view that records which parts were read. `project: null` means no project store (reading its map throws, as the store refuses). */
function view(project: AliasMap | null, global: AliasMap): { view: NameView; read: Set<Part> } {
  const read = new Set<Part>();
  return {
    read,
    view: {
      get hasProjectStore() { read.add('hasProjectStore'); return project !== null; },
      get projectAliases() {
        read.add('projectAliases');
        if (project === null) throw new Error('no project store');
        return project;
      },
      get globalAliases() { read.add('globalAliases'); return global; },
      get unusedProject() { read.add('unusedProject'); return undefined; },
    },
  };
}

const P = { pa: 'k.p', dup: 'k.p', pg: 'k.g', 'k.g': 'k.p' };
const G = { ga: 'k.g', dup: 'k.g', gp: 'k.p' };

const AUTO = typedContext(undefined);
const GLOBAL = typedContext('global');
const PROJECT = typedContext('project');
const REF_P = referenceContext('project');
const REF_G = referenceContext('global');

describe('resolveName: key and scope by context', () => {
  // [context, name, key, scope, parts read for the key]
  const cases: [string, NameContext, string, string, string, Part[]][] = [
    ['default: project alias', AUTO, 'pa', 'k.p', 'auto', ['hasProjectStore', 'globalAliases', 'projectAliases']],
    ['default: global alias', AUTO, 'ga', 'k.g', 'auto', ['hasProjectStore', 'globalAliases', 'projectAliases']],
    ['default: project wins a name in both maps', AUTO, 'dup', 'k.p', 'auto', ['hasProjectStore', 'globalAliases', 'projectAliases']],
    ['default: an alias wins over the entry it is named after', AUTO, 'k.g', 'k.p', 'auto', ['hasProjectStore', 'globalAliases', 'projectAliases']],
    ['default: not an alias', AUTO, 'k.x', 'k.x', 'auto', ['hasProjectStore', 'globalAliases', 'projectAliases']],
    ['default: trailing colon dropped', AUTO, 'pa:', 'k.p', 'auto', ['hasProjectStore', 'globalAliases', 'projectAliases']],
    ['-G: global map only (#284)', GLOBAL, 'pa', 'pa', 'global', ['globalAliases']],
    ['-G: global alias', GLOBAL, 'dup', 'k.g', 'global', ['globalAliases']],
    ['MCP project: project map only', PROJECT, 'ga', 'ga', 'project', ['projectAliases']],
    ['MCP project: project alias', PROJECT, 'dup', 'k.p', 'project', ['projectAliases']],
    ['reference in a project entry: the default view', REF_P, 'dup', 'k.p', 'auto', ['hasProjectStore', 'globalAliases', 'projectAliases']],
    ['reference in a global entry: global only (#280)', REF_G, 'pa', 'pa', 'global', ['globalAliases']],
    ['reference in a global entry: global alias', REF_G, 'dup', 'k.g', 'global', ['globalAliases']],
  ];
  it.each(cases)('%s', (_label, ctx, name, key, scope, parts) => {
    const v = view(P, G);
    const r = resolveName(v.view, ctx, name);
    expect(r.key).toBe(key);
    expect(r.scope).toBe(scope);
    expect([...v.read].sort()).toEqual([...parts].sort());
  });

  it('outside a project the default view is the global map, and the project map is never read', () => {
    const v = view(null, G);
    expect(resolveName(v.view, AUTO, 'dup').key).toBe('k.g');
    expect(resolveName(v.view, REF_P, 'pa').key).toBe('pa');
    expect([...v.read].sort()).toEqual(['globalAliases', 'hasProjectStore']);
  });

  it('project scope with no project store reads the project map, and so refuses', () => {
    const v = view(null, G);
    expect(() => resolveName(v.view, PROJECT, 'ga')).toThrow('no project store');
  });

  it('a name an object inherits is not an alias', () => {
    const v = view({}, {});
    expect(resolveName(v.view, AUTO, 'toString').key).toBe('toString');
    expect(resolveName(v.view, GLOBAL, 'hasOwnProperty').key).toBe('hasOwnProperty');
  });

  it('nothing reads the #298 condition: it is the run gate\'s', () => {
    const v = view(P, G);
    for (const ctx of [AUTO, GLOBAL, PROJECT, REF_P, REF_G]) void resolveName(v.view, ctx, 'dup').gateNames;
    expect(v.read.has('unusedProject')).toBe(false);
  });
});

describe('resolveName: the gate names (#279)', () => {
  const cases: [string, NameContext, string, string[]][] = [
    ['default: as typed, the target, the global target', AUTO, 'dup', ['dup', 'k.p', 'k.g']],
    ['default: a global-only alias adds nothing', AUTO, 'ga', ['ga', 'k.g']],
    ['default: no alias', AUTO, 'k.x', ['k.x']],
    ['default: trailing colon', AUTO, 'pa:', ['pa', 'k.p']],
    ['-G: as typed and the global target', GLOBAL, 'dup', ['dup', 'k.g']],
    ['-G: a project alias is just a name', GLOBAL, 'pa', ['pa']],
    ['MCP project: the global target is checked too', PROJECT, 'dup', ['dup', 'k.p', 'k.g']],
    ['MCP project: a global alias the project map does not hold', PROJECT, 'ga', ['ga', 'k.g']],
    ['reference in a project entry', REF_P, 'dup', ['dup', 'k.p', 'k.g']],
    ['reference in a global entry', REF_G, 'dup', ['dup', 'k.g']],
  ];
  it.each(cases)('%s', (_label, ctx, name, names) => {
    expect(resolveName(view(P, G).view, ctx, name).gateNames).toEqual(names);
  });

  it('are read lazily: a lookup that never asks for them does not read the global map for them', () => {
    const v = view(P, G);
    const r = resolveName(v.view, PROJECT, 'dup');
    expect(v.read.has('globalAliases')).toBe(false);
    expect(r.gateNames).toEqual(['dup', 'k.p', 'k.g']);
    expect(v.read.has('globalAliases')).toBe(true);
  });

  it('drop a second trailing colon for the global lookup, as resolveKey always did', () => {
    // 'ga::' is looked up as 'ga:' (no alias), and its global target as 'ga'.
    expect(gateNamesOf('ga::', 'ga:', G)).toEqual(['ga:', 'k.g']);
    expect(resolveName(view(P, G).view, AUTO, 'ga::').gateNames).toEqual(['ga:', 'k.g']);
  });
});

describe('contexts', () => {
  it('a typed scope', () => {
    expect(typedContext(undefined)).toEqual({ kind: 'typed', scope: 'auto' });
    expect(typedContext('auto')).toEqual({ kind: 'typed', scope: 'auto' });
    expect(typedContext('global')).toEqual({ kind: 'typed', scope: 'global' });
  });

  it('a global chain runs its members as global names; any other chain as its own name resolved', () => {
    expect(chainMemberContext(AUTO, 'global')).toEqual(GLOBAL);
    expect(chainMemberContext(PROJECT, 'global')).toEqual(GLOBAL);
    expect(chainMemberContext(AUTO, 'project')).toBe(AUTO);
    expect(chainMemberContext(PROJECT, 'project')).toBe(PROJECT);
    expect(chainMemberContext(GLOBAL, undefined)).toBe(GLOBAL);
  });

  it('the map each context reads', () => {
    expect(aliasesSeen(view(P, G).view, AUTO)).toEqual({ ...G, ...P });
    expect(aliasesSeen(view(null, G).view, AUTO)).toBe(G);
    expect(aliasesSeen(view(P, G).view, GLOBAL)).toBe(G);
    expect(aliasesSeen(view(P, G).view, PROJECT)).toBe(P);
    expect(aliasesSeen(view(P, G).view, REF_G)).toBe(G);
  });
});

describe('alias commands', () => {
  it('ask `in`, which also finds a name every object inherits', () => {
    expect(aliasListedIn({ pa: 'k.p' }, 'pa')).toBe(true);
    expect(aliasListedIn({ pa: 'k.p' }, 'ga')).toBe(false);
    expect(aliasListedIn({}, 'toString')).toBe(true);
  });

  it('a default-scope write in a project reads through to the global store, and lays the global aliases under its own (#260, kept)', () => {
    expect(readsFallThrough(AUTO, 'project')).toBe(true);
    expect(aliasWriteLayers(AUTO, 'project')).toBe(true);
    expect(aliasWriteBase(AUTO, 'project', { pa: 'k.p', dup: 'k.p' }, G)).toEqual({ ga: 'k.g', gp: 'k.p', pa: 'k.p', dup: 'k.p' });
    for (const ctx of [GLOBAL, PROJECT]) {
      const store = ctx === GLOBAL ? 'global' : 'project';
      expect(readsFallThrough(ctx, store)).toBe(false);
      expect(aliasWriteLayers(ctx, store)).toBe(false);
      expect(aliasWriteBase(ctx, store, P, G)).toBe(P);
    }
    // Nothing to lay under: the store's own map.
    expect(aliasWriteBase(AUTO, 'project', P, undefined)).toBe(P);
  });

  it('a rename re-points every alias of the key and of the keys under it; one alias per entry', () => {
    expect(repointAliases({ a: 'k', b: 'k.x', c: 'other' }, 'k', 'n')).toEqual({ a: 'n', b: 'n.x', c: 'other' });
    expect(repointAliases({ c: 'other' }, 'k', 'n')).toBeNull();
    // An alias already on a new target gives way to the one that moved there.
    expect(repointAliases({ a: 'k', old: 'n' }, 'k', 'n')).toEqual({ a: 'n' });
  });

  it('--set-alias takes the place of the alias the key had (the last one listed)', () => {
    expect(withAlias({ a: 'k', b: 'k', c: 'x' }, 'new', 'k')).toEqual({ a: 'k', new: 'k', c: 'x' });
    expect(withAlias({ a: 'k' }, 'a', 'k')).toEqual({ a: 'k' });
  });
});
