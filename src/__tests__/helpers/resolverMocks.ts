/**
 * The alias module's resolver wrappers, for suites that mock '../alias'
 * with a resolveKey of their own. They run the real resolver
 * (utils/nameResolver) over a view the suite's resolveKey describes, so a
 * mocked suite tests the resolver's own composition — the key, the scope,
 * and the gate names (#279: as written, the target, and the global target
 * when project aliases took part) — not a copy of it.
 */
import { type NameContext, type NameView, resolveName } from '../../utils/nameResolver';

type ResolveKey = (key: string, scope?: string) => string;

/**
 * An alias map whose aliases are what `lookup` answers: a name is an alias
 * when its answer differs from it. Each name is asked once per map.
 */
function mapOver(lookup: (name: string) => string): Record<string, string> {
  const answers = new Map<string, string>();
  const answer = (name: string): string => {
    if (!answers.has(name)) answers.set(name, lookup(name));
    return answers.get(name)!;
  };
  return new Proxy({} as Record<string, string>, {
    getOwnPropertyDescriptor: (_target, k) =>
      typeof k === 'string' && answer(k) !== k ? { value: answer(k), enumerable: true, configurable: true, writable: true } : undefined,
    get: (_target, k) => (typeof k === 'string' ? answer(k) : undefined),
  });
}

/**
 * The view a suite's resolveKey describes: a project store whose map
 * answers as resolveKey(name) does, and a global map that answers as
 * resolveKey(name, 'global') does.
 */
export function viewOver(resolveKey: ResolveKey): NameView {
  return {
    hasProjectStore: true,
    unusedProject: undefined,
    projectAliases: mapOver(name => resolveKey(name)),
    globalAliases: mapOver(name => resolveKey(name, 'global')),
  };
}

/** resolveNameNow over a suite's resolveKey: the real resolver, over viewOver's view. */
export function resolutionOver(resolveKey: ResolveKey, ctx: NameContext, written: string) {
  return resolveName(viewOver(resolveKey), ctx, written);
}

/** resolveReferenceName over a suite's resolveKey. */
export function referenceOver(resolveKey: ResolveKey, written: string, from: 'project' | 'global') {
  return resolutionOver(resolveKey, { kind: 'reference', from }, written);
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
