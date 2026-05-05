# Design: refuse codex_set on project resolution failure (#99)

**Issue:** [#99](https://github.com/seabearDEV/codexCLI/issues/99)
**Status:** design — not yet implemented
**Driving evidence:** `docs/investigation-bootstrap-overflow-2026-05-05.md`, `docs/dataset-2026-05-05-findings.md`
**Playbook:** mirrors the #91 design-first treatment

## Problem

When project resolution fails (`CODEX_NO_PROJECT` set, or `CODEX_PROJECT` set-but-unresolvable, or no `.codexcli/` found from the resolver's starting directory), `findProjectFile()` returns `null`. Every write tool with `scope: undefined` or `scope: "auto"` then routes to the global store via the silent fallthrough in `storage.ts:setValue`, `storage.ts:removeValue`, and the equivalent paths in `alias.ts` / `confirm.ts` / `store.ts`.

In practice this misroutes project-shaped data into the user's global store. The 2026-05-05 dataset showed five FA-iOS sessions writing FA-iOS-shaped keys (`context.uikit_canimport_pattern`, `files.icon_detail_view`, `arch.swift_dual_layout`, `deps.seabearkit`) into global because the FA-iOS repo had no `.codexcli/`. The `[project: NONE — auto-scope writes will fall through to global]` banner is informational only and agents do not act on it.

This change makes the misconfiguration loud: writes refuse, forcing the user to decide between `codex_init` (create a project store), `--scope global` / `scope: "global"` (intentional global write), or fixing the resolver inputs.

## Decisions locked (2026-05-05 design conversation)

| | Decision |
|---|---|
| **D1** | Refuse, no auto-pin. Misconfiguration must remain loud. |
| **D2** | Inline error: refusal reason + resolver chain (what was tried, what failed) + two recovery actions named explicitly. |
| **D3** | Reads stay silent on `project: null + scope: auto` — no new warnings, current behavior preserved. Revisit only if telemetry shows non-trivial post-deploy resolution-failure rate. |
| **D4** | Telemetry: piggyback existing tool-call records with `refusedReason: "project_unresolved"` on refused calls; `rescuedByExplicitGlobal: true` on calls that would-have-refused but used explicit `scope: "global"`. |
| **D5** | Break loudly on first call after upgrade. Document prominently in CHANGELOG and v1.14.0 dogfooding post. No deprecation cycle. |

## Affected surfaces

### Refuses on `auto + null`

CRUD entry points in storage layer (callers in MCP wrapper and CLI handlers):

| File | Function | Tool |
|---|---|---|
| `src/storage.ts` | `setValue` | `codex_set` |
| `src/storage.ts` | `removeValue` | `codex_remove` |
| `src/storage.ts` | `saveData` | `codex_import` (bulk write path) |
| `src/alias.ts` | `setAlias` | `codex_alias_set` |
| `src/alias.ts` | `removeAlias` | `codex_alias_remove` |
| `src/alias.ts` | `renameAlias` | (used internally by rename flows) |
| `src/alias.ts` | `saveAliases` | `codex_import` (bulk) |
| `src/alias.ts` | `removeAliasesForKey` | (cascade on entry remove — same scope as the cascading remove) |
| `src/confirm.ts` | `setConfirm` | `codex_confirm_set` |
| `src/confirm.ts` | `removeConfirm` | `codex_confirm_remove` |
| `src/confirm.ts` | `removeConfirmForKey` | (cascade on entry remove) |
| `src/confirm.ts` | `saveConfirmKeys` | `codex_import` (bulk) |
| `src/store.ts` | `saveAll` | `codex_import` transactional bulk |
| `src/commands/data-management.ts` | rename / copy handlers | `codex_rename`, `codex_copy` (for the destination scope) |
| `src/commands/data-management.ts` | reset handler | `codex_reset` |

### Exempt from refusal

| Path | Reason |
|---|---|
| `codex_init` | Its job is to create `.codexcli/` — refusal would block the cure. |
| `codex_export` | Read-only. |
| All `codex_get` / `codex_find` / `codex_context` / `codex_audit` / `codex_stats` / `codex_alias_list` / `codex_stale` | Reads — D3 says reads stay silent. |
| Internal write paths called *as part of* a successful resolution context (e.g. cascade removes inside an explicit-scope remove) | Inherit the caller's scope, no double-guard. |

### Open question for implementation pass

`removeAliasesForKey` and `removeConfirmForKey` are called as cascades from `removeEntry`. They take `scope?` but the callers in `src/commands/entries.ts` (lines 630–634 per `context.cascadeDelete`) pass through whatever scope was resolved for the entry remove. If the entry remove resolved (success), these cascades have a real scope — no guard needed. The guard at `setValue` / `removeValue` already gates the entry op; the cascades inherit. **Verify in implementation:** cascades never receive `undefined` / `"auto"` after the entry remove has completed.

## Architecture: where the guard lives

Single chokepoint in a new `src/projectResolution.ts` module:

```ts
import { findProjectFile } from './utils/paths';
import { Scope } from './store';

export interface ResolverDiagnostic {
  codexNoProject: boolean;
  codexProject: string | undefined;     // value if set
  codexProjectFailed: boolean;          // true if env was set but didn't resolve
  rootOverride: string | undefined;     // value if set programmatically (MCP roots / launcher)
  startedFrom: string;                  // dir where the walk began
  walkReachedRoot: boolean;             // true if walk-up exhausted without finding .codexcli/
}

export class ProjectResolutionError extends Error {
  readonly code = 'PROJECT_UNRESOLVED';
  constructor(public readonly diagnostic: ResolverDiagnostic) {
    super(buildMessage(diagnostic));
  }
}

/**
 * Resolve a possibly-auto scope into an explicit one. Throws
 * ProjectResolutionError if scope is auto/undefined and project resolution
 * failed.
 *
 * Use at the top of every write entry point. Read paths skip this — they
 * fall through to global as today.
 */
export function resolveScopeForWrite(scope: Scope | undefined): Scope {
  if (scope === 'project' || scope === 'global') return scope;
  const projectPath = findProjectFile();
  if (projectPath) return 'project';
  throw new ProjectResolutionError(captureResolverDiagnostic());
}
```

`captureResolverDiagnostic()` reads the same env vars and override state that `findProjectFile()` reads, so the error message can name what was tried. **This requires `paths.ts` to export the override state via a new accessor** (currently `projectRootOverride` is module-private). Alternative: snapshot env + cwd inside `resolveScopeForWrite` and infer the rest. The accessor is cleaner.

The 11 write entry points listed above each gain a one-liner at the top:

```ts
const effectiveScope = resolveScopeForWrite(scope);
// ... existing logic, with `effectiveScope` substituted for `scope ?? 'auto'`
```

Existing code paths that branch on `if (!scope || scope === 'auto')` (e.g. `removeValue`'s project-then-global fallthrough) collapse: `effectiveScope` is now always `'project'` or `'global'`.

## Error shape

### Inline message body (D2 = inline)

```
Project resolution failed; refusing to write under scope:auto.

Resolver tried (in order):
  1. CODEX_NO_PROJECT env: not set
  2. CODEX_PROJECT env: <value> — DID NOT RESOLVE TO A .codexcli DIRECTORY
  3. Programmatic root override: not set
  4. Walk up from <cwd>: reached filesystem root without finding .codexcli/

Choose one to proceed:
  - run `codex_init` (or `ccli init`) here to create a project store
  - retry with explicit scope:"global" (MCP) or --scope global (CLI) for an
    intentional global-store write
```

Lines for resolver steps that did not fire (e.g. `CODEX_PROJECT env: not set`) are still listed — the user can scan and confirm what's expected. Lines for steps that fired with a failure mark the failure inline (`DID NOT RESOLVE`, `NO MATCH FOUND`, etc.).

### Wire format

| Caller | Surface | Format |
|---|---|---|
| MCP | tool result | Throw → MCP wrapper catches → returns `{ isError: true, content: [{ type: "text", text: <message> }] }`. The structured `code: "PROJECT_UNRESOLVED"` and `diagnostic` go into a second content block as a JSON code block for programmatic consumers. |
| CLI | stderr + exit | `process.stderr.write(message + "\n")`, `process.exitCode = 1` (matches existing `handleError` in `storage.ts:42`). |

**Q1 (CLI exit code) settled 2026-05-05:** stay with `1`. The "validation = 2" convention is not actually universal (`git` and `gh` don't use it cleanly) — it's mainly bash builtins and Python's argparse. Sticking with `1` keeps internal consistency with `handleError`, avoids creating ongoing pressure to classify every future error as validation-vs-runtime, and the error message itself carries the actionable signal. Differentiation can be introduced later as a behavior change if a concrete user workflow ever requires it.

## Resolver diagnostic refactor

`findProjectFile()` and `findProjectStoreDir()` in `src/utils/paths.ts` currently return `string | null` with no diagnostic. Two non-invasive options:

**Option A:** Add a sibling function `findProjectFileWithDiagnostic()` that returns `{ path: string | null; diagnostic: ResolverDiagnostic }`. Existing callers keep using `findProjectFile()` (which becomes a thin wrapper). The new function powers `resolveScopeForWrite`.

**Option B:** Change `findProjectFile()` to return `{ path: string | null; diagnostic: ResolverDiagnostic }` and update all 20-ish call sites. Higher blast radius, lower long-term API surface.

**Recommendation: A.** Lower blast radius, keeps the cached fast path untouched for read callers.

The diagnostic capture itself is straightforward — the four resolver steps in `paths.ts:189-273` each have a clear branch where the path is decided. We just record which branch fired and why.

## Test matrix

### Unit: `resolveScopeForWrite` itself

| Input scope | findProjectFile | Expected |
|---|---|---|
| `'project'` | resolves | returns `'project'` |
| `'project'` | null | returns `'project'` (caller responsible — current behavior preserved) |
| `'global'` | resolves | returns `'global'` |
| `'global'` | null | returns `'global'` |
| `undefined` | resolves | returns `'project'` |
| `undefined` | null | throws `ProjectResolutionError` |
| `'auto'` | resolves | returns `'project'` |
| `'auto'` | null | throws `ProjectResolutionError` |

### Unit: each write entry point

Single happy-path test (resolves to project) + single refused-path test (auto + null) per function. ~22 tests.

### Integration: MCP path

For each MCP write tool:
- happy: `CODEX_PROJECT` pointing at fixture → succeeds
- refused: no `CODEX_PROJECT`, cwd fixture has no `.codexcli/` → tool result has `isError: true`, message contains "PROJECT_UNRESOLVED" and the recovery actions

### Integration: CLI path

For each CLI write subcommand:
- happy: cwd fixture with `.codexcli/` → succeeds
- refused: cwd fixture without `.codexcli/` → stderr matches, exit code matches the decided value

### Telemetry

- `refusedReason` field present on the audit/telemetry record for every refused call
- `rescuedByExplicitGlobal` field present on calls where `scope: 'global'` was explicit AND `findProjectFile()` would have returned null

### Existing test sweep

Grep for tests that:
- Set entries via MCP tools without `CODEX_PROJECT` and without an explicit `scope` parameter — these will start failing
- Use `CODEX_DATA_DIR` for isolation but no project fixture — these probably already work because the test doesn't assert "wrote to project store"; verify

Estimated impact: small. `CODEX_DATA_DIR` test isolation creates a global store but does not by itself create a project store. Tests that exercise project-scope writes already need to set up a `.codexcli/` fixture. Tests that exercise global-scope writes already pass `scope: 'global'` (or are read-only). The break surface is tests in the middle that wrote without thinking about scope.

## Migration / break tolerance

- v1.14.0 minor bump — semver allows behavior changes that fix correctness bugs.
- CHANGELOG entry under "Breaking changes" with the recovery actions reproduced.
- v1.14.0 dogfooding post (part three) leads with this as the soak-data outcome.
- LLM_INSTRUCTIONS update (`src/llm-instructions.ts`) — agents reading the default instructions should see the refusal-aware guidance: "if `codex_set` returns PROJECT_UNRESOLVED, run `codex_init` or pass `scope: 'global'`".

## Out of scope (explicitly)

- Auto-pin via ancestor-walk (D1 rejected)
- Read-side warnings (D3 rejected)
- Deprecation cycle (D5 rejected)
- Backfill of historical `project: "."` audit rows (covered by #102, separately)
- Reworking the `[project: NONE]` banner — becomes mostly redundant after this lands, but the banner change is a sub-issue if it surfaces
- Changes to `codex_init` (it remains the cure)

## Open questions for implementation pass

1. **Cascade verification:** confirm that `removeAliasesForKey` and `removeConfirmForKey` always inherit a resolved scope from the caller and never need their own guard.
2. **Resolver-diagnostic refactor:** option A (sibling function) confirmed, or revisit option B?
3. **MCP error wire format:** plain-text body + JSON code block as the second content item, or single content item with the message body and `code` in MCP error metadata? Depends on how the SDK exposes the `isError` path — verify with an MCP probe before the first PR.

## Acceptance criteria (for the implementation PR)

- All 11 write entry points refuse on `auto + null`; explicit scopes still work
- `codex_init` still works on a fresh directory
- Error message matches the format above; resolver diagnostic accurately reflects which step failed
- Telemetry records `refusedReason: "project_unresolved"` and `rescuedByExplicitGlobal` correctly
- Test suite passes; new tests cover the matrix above
- CHANGELOG + LLM_INSTRUCTIONS updated
- Manual: re-run the FA-iOS reproduction (cwd with no `.codexcli/`, `codex_set` via MCP) → refusal with the correct message
