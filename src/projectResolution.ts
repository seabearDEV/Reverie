/**
 * Project-resolution guard for write paths (#99).
 *
 * When MCP project resolution fails (no RVR_PROJECT, no MCP roots, cwd
 * walk-up finds no `.reverie/`) and the caller did not request an explicit
 * scope, write tools previously fell through silently to the user's global
 * store. This module exposes the chokepoint that turns that silent
 * fallthrough into a structured refusal: callers wrap their resolution
 * with `resolveScopeForWrite(scope)` at the top of every write entry point.
 *
 * Reads are unaffected — they intentionally fall through to global so that
 * a user with one project shell open can still browse global from a sibling
 * directory. That is the auto scope only: an explicit project scope (MCP
 * `scope: "project"`, CLI `-P`) with no project refuses everywhere, reads
 * included (#294, #296) — see `assertProjectScope` in `store.ts`.
 *
 * See `docs/design-99-project-resolution-refusal.md` for the full design.
 */

import {
  findProjectFileWithDiagnostic,
  ResolverDiagnostic,
} from './utils/paths';
import type { Scope } from './store';

export type { ResolverDiagnostic };

/**
 * Thrown by `resolveScopeForWrite` when scope is auto/undefined and project
 * resolution failed, and by the store (`assertProjectScope`) when project
 * scope was asked for explicitly and there is no project (#294, #296).
 * Carries a `code` of `'PROJECT_UNRESOLVED'` for programmatic consumers (MCP
 * wrapper, telemetry) and the captured `diagnostic` so callers can render
 * the failure mode without re-probing. `requested` says which of the two it
 * is: the message differs, the code does not. `unusable` is set for an auto
 * write whose lookup found a project the store is not using (see
 * resolveScopeForWrite).
 */
export class ProjectResolutionError extends Error {
  readonly code = 'PROJECT_UNRESOLVED';
  readonly diagnostic: ResolverDiagnostic;
  readonly requested: 'auto' | 'project';
  readonly unusable: string | undefined;

  constructor(diagnostic: ResolverDiagnostic, requested: 'auto' | 'project' = 'auto', unusable?: string) {
    super(buildMessage(diagnostic, requested, unusable));
    this.name = 'ProjectResolutionError';
    this.diagnostic = diagnostic;
    this.requested = requested;
    this.unusable = unusable;
  }
}

/**
 * Whether the store has a project store — its own lookup, the one every
 * load and save uses. Registered by store.ts (this module cannot import it:
 * store.ts imports this one). Unset — a test that mocks the store — the
 * write resolves as before.
 */
let storeHasProject: (() => boolean) | undefined;

export function registerProjectStoreLookup(lookup: () => boolean): void {
  storeHasProject = lookup;
}

/**
 * Resolve a possibly-auto scope into an explicit one. Throws
 * `ProjectResolutionError` when scope is `'auto'` or undefined and project
 * resolution failed. Use at the top of every write entry point.
 *
 * Read paths must NOT call this — they should continue to fall through to
 * global on resolution failure.
 *
 * An explicit `'project'` is returned as is, project or not: the store
 * refuses it when there is no project (`assertProjectScope` in `store.ts`,
 * checked by `resolveStore` on every load and save), so a project write
 * never lands in the global store (#294, #296).
 *
 * Auto resolves to `'project'` only when the store has a project store too.
 * This lookup is uncached and the store's is cached, so they can disagree:
 * an MCP server that started outside a project does not see one created
 * since, and a legacy `.codexcli.json` that cannot be migrated is found
 * here but gives the store nothing. The write used to resolve to 'project'
 * here and land in the global store there, its checks looking at one store
 * and its saves at another — the #294 class. It refuses now and changes
 * nothing; there is no fallback to the global store.
 */
export function resolveScopeForWrite(scope: Scope | undefined): Exclude<Scope, 'auto'> {
  if (scope === 'project' || scope === 'global') return scope;
  // scope is undefined or 'auto'
  const { path: projectPath, diagnostic } = findProjectFileWithDiagnostic();
  if (!projectPath) throw new ProjectResolutionError(diagnostic);
  if (storeHasProject !== undefined && !storeHasProject()) {
    throw new ProjectResolutionError(diagnostic, 'auto', projectPath);
  }
  return 'project';
}

/**
 * Re-probe the resolver and return the diagnostic without throwing. Useful
 * for callers that want to attach `rescuedByExplicitGlobal` telemetry on a
 * write that succeeded with explicit `scope: 'global'` despite project
 * resolution failing. Cheap — same probe as `resolveScopeForWrite` minus
 * the throw.
 */
export function captureResolverDiagnostic(): ResolverDiagnostic {
  return findProjectFileWithDiagnostic().diagnostic;
}

function buildMessage(d: ResolverDiagnostic, requested: 'auto' | 'project', unusable: string | undefined): string {
  const lines: string[] = [];
  if (unusable !== undefined) {
    lines.push(`A project store was found at ${unusable}, but this process is not using it;`);
    lines.push(requested === 'project'
      ? 'refusing scope:"project". Nothing was changed.'
      : 'refusing to write under scope:auto. Nothing was changed.');
    lines.push('');
    lines.push('Choose one to proceed:');
    lines.push('  - if it was created after this process started (a long-lived MCP server),');
    lines.push('    restart the server so it uses it');
    lines.push('  - if it is a legacy .codexcli.json that could not be migrated, fix or move it');
    lines.push('  - retry with scope:"global" (MCP) or -G / --global (CLI) for an');
    lines.push('    intentional global-store write');
    return lines.join('\n');
  }
  if (requested === 'project') {
    lines.push('Project scope was requested explicitly (scope:"project" or -P / --project), but there');
    lines.push('is no project store here. Refused; nothing was changed.');
  } else {
    lines.push('Project resolution failed; refusing to write under scope:auto.');
  }
  lines.push('');
  lines.push('Resolver tried (in order):');
  lines.push(`  1. RVR_NO_PROJECT env: ${d.rvrNoProject ? 'set (resolution disabled)' : 'not set'}`);

  if (d.rvrProject !== undefined) {
    const tail = d.rvrProjectFailed ? ' — DID NOT RESOLVE TO A .reverie DIRECTORY OR LEGACY .codexcli.json FILE' : '';
    lines.push(`  2. RVR_PROJECT env: ${d.rvrProject}${tail}`);
  } else {
    lines.push('  2. RVR_PROJECT env: not set');
  }

  if (d.rootOverride !== undefined) {
    lines.push(`  3. Programmatic root override: ${d.rootOverride}`);
  } else {
    lines.push('  3. Programmatic root override: not set');
  }

  if (d.startedFrom) {
    let tail = '';
    if (d.walkReachedRoot) {
      tail = ': reached filesystem root without finding .reverie/ or .codexcli.json';
    } else if (d.walkStoppedAtGlobalDir) {
      tail = ': stopped at the Reverie global data directory before finding a project store';
    }
    lines.push(`  4. Walk up from ${d.startedFrom}${tail}`);
  } else {
    lines.push('  4. Walk up: skipped (earlier resolver branch short-circuited)');
  }

  lines.push('');
  lines.push('Choose one to proceed:');
  if (d.rvrNoProject) {
    lines.push('  - unset RVR_NO_PROJECT and retry, or run `rvr init` in a shell once the env');
    lines.push('    is cleared');
  } else {
    lines.push('  - run `rvr init` here, in a shell, to create a project store');
  }
  if (requested === 'project') {
    lines.push('  - retry with scope:"global" (MCP) or -G / --global (CLI) to use the global');
    lines.push('    store, or with no scope to read through to it');
  } else {
    lines.push('  - retry with explicit scope:"global" (MCP) or -G / --global (CLI) for an');
    lines.push('    intentional global-store write');
  }

  return lines.join('\n');
}
