/**
 * What a name means: the one place that decides it.
 *
 * A name reaches Reverie typed on the command line (with or without -G),
 * passed to an MCP tool (scope omitted, "global" or "project"), or written
 * in an entry as `${name}` / `$(name)`. Which entry it means used to be
 * worked out in each of those places, and every recent bug in this area was
 * two of them disagreeing: #279 (the gate checked a name other than the one
 * looked up), #280 (a reference read the wrong store), #284 (-G resolved
 * through the project's aliases). Every caller now asks this module.
 *
 * Pure: no I/O. It decides over a view — the two alias maps and whether
 * there is a project store — that the caller builds; `alias.ts` builds it
 * from disk. The view is read lazily: a context reads only what it needs,
 * so a lookup touches the same stores it always has (loading a store is
 * not free of effects — it reports unreadable files, and the first look for
 * a project store can migrate a legacy one).
 */

/** An alias map: alias name → entry key. */
export type AliasMap = Readonly<Record<string, string>>;

/** The scope a lookup reads and a write lands in: one store, or 'auto' — project, then global. */
export type NameScope = 'auto' | 'project' | 'global';

export type StoreName = 'project' | 'global';

/**
 * Where a name was written.
 *
 * - `typed`: on the command line or in an MCP call. `scope` is what the
 *   caller asked for: 'auto' for the default scope (no -G, MCP scope
 *   omitted), 'global' for -G / scope "global", 'project' for MCP scope
 *   "project" (the CLI's entry commands have no -P).
 * - `reference`: inside the value of an entry stored in `from` — a `${…}`
 *   or `$(…)`, or a member of a `--chain` / `chain: true` entry. It
 *   resolves in the store of the entry that holds it (#280).
 */
export type NameContext =
  | { readonly kind: 'typed'; readonly scope: NameScope }
  | { readonly kind: 'reference'; readonly from: StoreName };

/**
 * What the resolver needs to know. Every field is read only when the
 * context needs it, and may be a getter that loads it then.
 */
export interface NameView {
  /** hasProjectStore(): the store layer has a project store (#294, #296). */
  readonly hasProjectStore: boolean;
  /**
   * #298: a project the uncached lookup finds that the store layer is not
   * using, or undefined. Its lists were never read, so a run fails closed.
   */
  readonly unusedProject: string | undefined;
  /** The project store's alias map. Read only with a project store, or for project scope (where the store refuses without one). */
  readonly projectAliases: AliasMap;
  /** The global store's alias map. */
  readonly globalAliases: AliasMap;
}

export interface Resolution {
  /** The name as written, one trailing colon dropped (a tab-completion artifact). */
  readonly name: string;
  /** The entry key it means: an alias's target, or the name itself. */
  readonly key: string;
  /** Where `key` is read, and where a write of it lands. */
  readonly scope: NameScope;
  /**
   * The names the run-confirmation gate checks for this lookup (#279): the
   * name as written and the key its alias gives. A flag gates a name in
   * every project, so a project alias over a flagged name must not take the
   * run past the flag: checking only the target let a cloned repository's
   * `_aliases.json` point the user's flagged name at a command of its own.
   * When project aliases took part, also the key the global map alone gives
   * the name, so that a project alias cannot take a name away from the
   * user's own global alias to a flagged command. Each extra name only gates
   * more. Read lazily: only a run asks, and the extra name reads the global
   * map.
   */
  readonly gateNames: readonly string[];
}

/** The context for a name typed with a CLI or MCP scope (undefined: the default). */
export function typedContext(scope: NameScope | undefined): NameContext {
  return { kind: 'typed', scope: scope ?? 'auto' };
}

/** The context for a reference inside an entry stored in `from` (#280). */
export function referenceContext(from: StoreName): NameContext {
  return { kind: 'reference', from };
}

/**
 * The context of a member of a chain entry (`--chain`, `chain: true`) that
 * `chain` resolved and that was found in `chainStore`. A chain's members are
 * references in it, so a global chain runs global entries only (#280).
 * Otherwise they resolve as the chain's own name did — for MCP scope
 * "project", through the project's map.
 */
export function chainMemberContext(chain: NameContext, chainStore: StoreName | undefined): NameContext {
  return chainStore === 'global' ? typedContext('global') : chain;
}

/** How the stores of `ctx` combine: the alias map(s) a lookup reads, and the scope of the read. */
function plan(ctx: NameContext): { maps: 'layered' | 'project' | 'global'; scope: NameScope } {
  if (ctx.kind === 'reference') {
    // A global entry's references read the global store only; a project
    // entry's read the project, then global, as a typed name does (#280).
    return ctx.from === 'global' ? { maps: 'global', scope: 'global' } : { maps: 'layered', scope: 'auto' };
  }
  switch (ctx.scope) {
    case 'global': return { maps: 'global', scope: 'global' };       // #284
    case 'project': return { maps: 'project', scope: 'project' };    // MCP scope "project"
    case 'auto': return { maps: 'layered', scope: 'auto' };
  }
}

/**
 * The alias map a lookup in `ctx` reads: the project's laid over the
 * global one in the default view (the global one alone outside a project),
 * one store's map otherwise.
 */
export function aliasesSeen(view: NameView, ctx: NameContext): AliasMap {
  const { maps } = plan(ctx);
  if (maps === 'global') return view.globalAliases;
  if (maps === 'project') return view.projectAliases;
  if (!view.hasProjectStore) return view.globalAliases;
  return { ...view.globalAliases, ...view.projectAliases };
}

/** The target `map` gives `name` — an own property only, never one inherited from Object.prototype — or `name`. */
function lookUp(map: AliasMap, name: string): string {
  return Object.hasOwn(map, name) ? map[name] : name;
}

function dropColon(name: string): string {
  return name.replace(/:$/, '');
}

/**
 * The gate's names for one lookup of `written` that gave `key` (#279).
 * `globalAliases`: when the lookup read project aliases, the global map,
 * whose answer for the name is checked too. The name goes through the
 * global lookup with a trailing colon dropped once more, as it always has.
 */
export function gateNamesOf(written: string, key: string, globalAliases?: AliasMap): string[] {
  const name = dropColon(written);
  const names = new Set([name, key]);
  if (globalAliases !== undefined) names.add(lookUp(globalAliases, dropColon(name)));
  return [...names];
}

/** What `written` means in `ctx`, over `view`. */
export function resolveName(view: NameView, ctx: NameContext, written: string): Resolution {
  const name = dropColon(written);
  const { scope } = plan(ctx);
  const key = lookUp(aliasesSeen(view, ctx), name);
  // Project aliases were in play unless the lookup was global-only. That
  // holds outside a project too, where the default view is the global map
  // and the extra name is the key itself.
  const projectAliases = plan(ctx).maps !== 'global';
  let gateNames: string[] | undefined;
  return {
    name,
    key,
    scope,
    get gateNames() {
      gateNames ??= gateNamesOf(written, key, projectAliases ? view.globalAliases : undefined);
      return gateNames;
    },
  };
}

