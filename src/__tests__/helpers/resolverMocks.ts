/**
 * The alias module's resolver wrappers, over a test's resolveKey mock. A
 * suite that mocks '../alias' with a resolveKey of its own gets the names a
 * reference resolves to, and the gate names, composed from that mock as
 * interpolate.ts composed them before the resolver (#280: a global entry's
 * references read the global aliases; #279: as written, the target, and the
 * global target when project aliases took part).
 */
type ResolveKey = (key: string, scope?: string) => string;

export function referenceOver(resolveKey: ResolveKey, written: string, from: 'project' | 'global') {
  const key = from === 'global' ? resolveKey(written, 'global') : resolveKey(written);
  const name = written.replace(/:$/, '');
  return {
    name,
    key,
    scope: from === 'global' ? 'global' as const : 'auto' as const,
    get gateNames() {
      const names = new Set([name, key]);
      if (from !== 'global') names.add(resolveKey(name, 'global'));
      return [...names];
    },
  };
}


type Context = { kind: 'typed'; scope: string } | { kind: 'reference'; from: 'project' | 'global' };

/**
 * resolveNameNow over a resolveKey mock: a typed name resolves as
 * resolveKey(name, scope) did, and its gate names are composed as
 * gateNamesFor composed them.
 */
export function resolutionOver(resolveKey: ResolveKey, ctx: Context, written: string) {
  if (ctx.kind === 'reference') return referenceOver(resolveKey, written, ctx.from);
  const key = resolveKey(written, ctx.scope);
  const name = written.replace(/:$/, '');
  return {
    name,
    key,
    scope: ctx.scope,
    get gateNames() {
      const names = new Set([name, key]);
      if (ctx.scope !== 'global') names.add(resolveKey(name, 'global'));
      return [...names];
    },
  };
}

/**
 * nameView as these suites see it: with the store mocked, no project-store
 * lookup is registered, so unusedProjectStore() answers undefined. The maps
 * are not read through the view in them.
 */
export function mockNameView() {
  return {
    hasProjectStore: false,
    unusedProject: undefined,
    get projectAliases(): Record<string, string> { throw new Error('projectAliases is not mocked in this suite'); },
    get globalAliases(): Record<string, string> { throw new Error('globalAliases is not mocked in this suite'); },
  };
}
