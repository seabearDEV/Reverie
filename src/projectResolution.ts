/**
 * Project-resolution guard for write paths (#99).
 *
 * When MCP project resolution fails (no CODEX_PROJECT, no MCP roots, cwd
 * walk-up finds no `.codexcli/`) and the caller did not request an explicit
 * scope, write tools previously fell through silently to the user's global
 * store. This module exposes the chokepoint that turns that silent
 * fallthrough into a structured refusal: callers wrap their resolution
 * with `resolveScopeForWrite(scope)` at the top of every write entry point.
 *
 * Reads are unaffected — they intentionally fall through to global so that
 * a user with one project shell open can still browse global from a sibling
 * directory.
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
 * resolution failed. Carries a `code` of `'PROJECT_UNRESOLVED'` for
 * programmatic consumers (MCP wrapper, telemetry) and the captured
 * `diagnostic` so callers can render the failure mode without re-probing.
 */
export class ProjectResolutionError extends Error {
  readonly code = 'PROJECT_UNRESOLVED';
  readonly diagnostic: ResolverDiagnostic;

  constructor(diagnostic: ResolverDiagnostic) {
    super(buildMessage(diagnostic));
    this.name = 'ProjectResolutionError';
    this.diagnostic = diagnostic;
  }
}

/**
 * Resolve a possibly-auto scope into an explicit one. Throws
 * `ProjectResolutionError` when scope is `'auto'` or undefined and project
 * resolution failed. Use at the top of every write entry point.
 *
 * Read paths must NOT call this — they should continue to fall through to
 * global on resolution failure.
 *
 * Note: when `scope === 'project'` and project resolution failed, this still
 * returns `'project'`. The caller asked for project explicitly and is
 * responsible for the downstream behavior (current behavior preserved).
 */
export function resolveScopeForWrite(scope: Scope | undefined): Exclude<Scope, 'auto'> {
  if (scope === 'project' || scope === 'global') return scope;
  // scope is undefined or 'auto'
  const { path: projectPath, diagnostic } = findProjectFileWithDiagnostic();
  if (projectPath) return 'project';
  throw new ProjectResolutionError(diagnostic);
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

function buildMessage(d: ResolverDiagnostic): string {
  const lines: string[] = [];
  lines.push('Project resolution failed; refusing to write under scope:auto.');
  lines.push('');
  lines.push('Resolver tried (in order):');
  lines.push(`  1. CODEX_NO_PROJECT env: ${d.codexNoProject ? 'set (resolution disabled)' : 'not set'}`);

  if (d.codexProject !== undefined) {
    const tail = d.codexProjectFailed ? ' — DID NOT RESOLVE TO A .codexcli DIRECTORY OR .codexcli.json FILE' : '';
    lines.push(`  2. CODEX_PROJECT env: ${d.codexProject}${tail}`);
  } else {
    lines.push('  2. CODEX_PROJECT env: not set');
  }

  if (d.rootOverride !== undefined) {
    lines.push(`  3. Programmatic root override: ${d.rootOverride}`);
  } else {
    lines.push('  3. Programmatic root override: not set');
  }

  if (d.startedFrom) {
    let tail = '';
    if (d.walkReachedRoot) {
      tail = ': reached filesystem root without finding .codexcli/ or .codexcli.json';
    } else if (d.walkStoppedAtGlobalDir) {
      tail = ': stopped at the global codex data directory before finding a project store';
    }
    lines.push(`  4. Walk up from ${d.startedFrom}${tail}`);
  } else {
    lines.push('  4. Walk up: skipped (earlier resolver branch short-circuited)');
  }

  lines.push('');
  lines.push('Choose one to proceed:');
  if (d.codexNoProject) {
    lines.push('  - unset CODEX_NO_PROJECT and retry, or run `codex_init` (or `ccli init`) once');
    lines.push('    the env is cleared');
  } else {
    lines.push('  - run `codex_init` (or `ccli init`) here to create a project store');
  }
  lines.push('  - retry with explicit scope:"global" (MCP) or --scope global (CLI) for an');
  lines.push('    intentional global-store write');

  return lines.join('\n');
}
