# Design: deep rebrand — codex/codexcli surfaces → Reverie

**Status:** SPEC LOCKED 2026-05-06. Targets release `v1.0.0-beta.1`.
**Driving context:** `project.identity` (rebrand thesis), `project.releasePlan` (v1.0.0 launch).
**Supersedes:** the "What's NOT changing" carve-out in CHANGELOG `[1.0.0-beta.0]` (codex_* tool names, .codexcli/, $codexcli, CODEX_* env vars). Phase 3 deliberately preserved those surfaces under a "load-bearing data-layer naming" argument; this design reverses that decision after the user reaffirmed full brand commitment.

## Problem

Phase 3 (shipped in `v1.0.0-beta.0`) split the rebrand into "product surfaces" (renamed: binary, package, repo, tap) and "data-layer surfaces" (preserved: directory, envelope, env vars, MCP tools, the lowercase noun). The split was internally coherent but produces brand asymmetry visible at every developer touchpoint:

- Users invoke `rvr` → which writes to `.codexcli/` → producing files with a `$codexcli` envelope → configured by `CODEX_PROJECT` → exposing `codex_*` MCP tools → which agents are told manipulate "the codex."

Five surfaces still carry the old name. The brand pitch is "Reverie: bicameral memory for AI-assisted dev" but the actual implementation is named codex everywhere it matters.

The deep rebrand collapses the split. After this change, every surface a developer or agent touches uses the Reverie name.

## Decisions locked (2026-05-06)

| | Decision | Rationale |
|---|---|---|
| **D1** | Project store dir `.codexcli/` → `.reverie/`. Global store `~/.codexcli/` → `~/.reverie/`. Auto-backup dir `<root>/.codexcli.backups/` → `<root>/.reverie.backups/`. | Brand pull-through into the surface every developer sees in `git status`. |
| **D2** | Export envelope key `$codexcli` → `$reverie`. Read both keys indefinitely; write only `$reverie`. | Export files live forever in the wild — cannot break old imports. Write-side cutover gives clean output going forward. |
| **D3** | All seven `CODEX_*` env vars → `RVR_*` (`RVR_PROJECT`, `RVR_DATA_DIR`, `RVR_PROJECT_DIR`, `RVR_NO_PROJECT`, `RVR_AGENT_NAME`, `RVR_DISABLE_LOCKING`, `RVR_BOOTSTRAP_MAX_BYTES`). **Hard cutover, no shim.** | Same pattern as `CCLI_PASSWORD` → `RVR_PASSWORD` and `CCLI_PAGER` → `RVR_PAGER` already shipped. Consistent precedent for `RVR_*` prefix. |
| **D4** | All 19 `codex_*` MCP tools → `reverie_*` (`reverie_get`, `reverie_set`, `reverie_context`, `reverie_run`, `reverie_audit`, `reverie_stats`, `reverie_alias_set`, `reverie_config_set`, etc.). **Hard cutover, no shim.** | Fresh-launch convention. Shim adds permanent complexity for a transient migration period. CLAUDE.md updates across dogfooded repos are tractable while the user count is small. |
| **D5** | Drop "the codex" as a lowercase noun. Use "Reverie" as a system name (pattern: Git, Docker, Make). | Westworld bicameral metaphor stays implicit in the brand thesis; explicit "the codex" prose creates ongoing tension between brand pitch and instruction text. |
| **D6** | Ships as `v1.0.0-beta.1`. Phase 2 (Bun commit-phase + short-flag audit) becomes `v1.0.0-beta.2`. | Splits two large changes into separate prereleases for clean regression-hunting. Beta cycle gives the directory migration real-data soak before stable. |

## Surface map

### 1. Directories on disk

| Old | New | Migration |
|---|---|---|
| `~/.codexcli/store/` | `~/.reverie/store/` | atomic rename on first access |
| `~/.codexcli/audit.jsonl` | `~/.reverie/audit.jsonl` | rides along |
| `~/.codexcli/telemetry.jsonl` | `~/.reverie/telemetry.jsonl` | rides along |
| `~/.codexcli/miss-paths.jsonl` | `~/.reverie/miss-paths.jsonl` | rides along |
| `~/.codexcli/config.json` | `~/.reverie/config.json` | rides along |
| `~/.codexcli/.backups/` | `~/.reverie/.backups/` | rides along |
| `<root>/.codexcli/` | `<root>/.reverie/` | atomic rename on first access |
| `<root>/.codexcli.backups/` | `<root>/.reverie.backups/` | rename if present |
| `.codexcli.json` (legacy v1.10) | unchanged migration path: detect → migrate to `.reverie/` (was: migrate to `.codexcli/`) | one fewer hop |

### 2. Envelope key

`src/utils/envelope.ts:ENVELOPE_KEY = '$codexcli'` → `'$reverie'`. Reader accepts both keys; writer emits only the new one.

### 3. Env vars (hard cutover)

| Old | New |
|---|---|
| `CODEX_PROJECT` | `RVR_PROJECT` |
| `CODEX_DATA_DIR` | `RVR_DATA_DIR` |
| `CODEX_PROJECT_DIR` | `RVR_PROJECT_DIR` |
| `CODEX_NO_PROJECT` | `RVR_NO_PROJECT` |
| `CODEX_AGENT_NAME` | `RVR_AGENT_NAME` |
| `CODEX_DISABLE_LOCKING` | `RVR_DISABLE_LOCKING` |
| `CODEX_BOOTSTRAP_MAX_BYTES` | `RVR_BOOTSTRAP_MAX_BYTES` |

### 4. MCP tool names (hard cutover)

| Old | New |
|---|---|
| `codex_set` | `reverie_set` |
| `codex_get` | `reverie_get` |
| `codex_remove` | `reverie_remove` |
| `codex_copy` | `reverie_copy` |
| `codex_rename` | `reverie_rename` |
| `codex_find` | `reverie_find` |
| `codex_run` | `reverie_run` |
| `codex_context` | `reverie_context` |
| `codex_export` | `reverie_export` |
| `codex_import` | `reverie_import` |
| `codex_reset` | `reverie_reset` |
| `codex_stale` | `reverie_stale` |
| `codex_stats` | `reverie_stats` |
| `codex_audit` | `reverie_audit` |
| `codex_alias_set` | `reverie_alias_set` |
| `codex_alias_remove` | `reverie_alias_remove` |
| `codex_alias_list` | `reverie_alias_list` |
| `codex_config_get` | `reverie_config_get` |
| `codex_config_set` | `reverie_config_set` |

### 5. Prose (the noun)

Sweep "the codex" / "your codex" / "codex entries" → "Reverie" / "Reverie entries" / system-name phrasing throughout README, CLAUDE.md, llm-instructions.ts, docs/schema-guide.md, docs/dogfooding.md, docs/token-savings.md, and any in-source agent-facing strings.

CHANGELOG remains untouched as rebrand provenance — historical sections stay verbatim.

## Migration algorithm (directory rename)

Single owner: `migrateLegacyCodexCliDirs` invoked from store init, before any read or write. Idempotent — second call is a no-op.

```
function migrateLegacyCodexCliDirs(scope) {
  if (scope === "global") {
    old = ~/.codexcli
    new = ~/.reverie
  } else {
    old = <projectRoot>/.codexcli
    new = <projectRoot>/.reverie
  }

  if (!exists(old)) return         // nothing to migrate
  if (exists(new)) {
    if (exists(old)) {
      // Both exist — surface as hard error. Means the user has parallel
      // installs or a partial-migration crash. Refuse rather than guess.
      throw new MigrationConflictError(
        `Both ${old} and ${new} exist. Move or remove one before continuing.`
      )
    }
    return                          // already migrated, clean state
  }

  // Atomic rename within the same filesystem.
  fs.renameSync(old, new)

  // Sidecar backup pointer for one cycle. Drops in v1.1.
  fs.symlinkSync(new, `${old}.backup`)

  log.info(`Migrated ${old} → ${new}`)
}
```

For the auto-backup sibling dir (`<root>/.codexcli.backups/` → `<root>/.reverie.backups/`), apply the same logic.

**Atomicity guarantee.** `fs.renameSync` is atomic within a single filesystem. The `.backup` symlink is best-effort metadata; if it fails to create the symlink, the rename is still complete and Reverie boots cleanly.

**Crash-resume.** If migration crashes between rename and symlink create, the next start sees `new` exists, `old` doesn't, no symlink — boots normally and skips migration. No data loss.

**Both-exist case.** Refusing is the right call. Silent merge risks data loss; silent overwrite is worse. Surface and let the user resolve.

## Envelope back-compat

```typescript
// src/utils/envelope.ts
const ENVELOPE_KEY = '$reverie'
const LEGACY_ENVELOPE_KEY = '$codexcli'

function readEnvelope(payload: unknown): EnvelopeMeta | null {
  if (!isObject(payload)) return null
  const meta = payload[ENVELOPE_KEY] ?? payload[LEGACY_ENVELOPE_KEY]
  if (!isObject(meta)) return null
  return validateMeta(meta)
}

function writeEnvelope(payload: PayloadShape, meta: EnvelopeMeta): WrappedPayload {
  return { [ENVELOPE_KEY]: meta, ...payload }
}
```

Existing exports stay readable forever. New exports use `$reverie` only.

## Implementation order

1. **Lock spec** (this doc).
2. **Verify `.reverie/` dirname is uncontested.** Quick search: any popular tool (editor, framework, package manager) that claims `.reverie/`? If yes, revisit naming.
3. **Path resolution updates** in `src/utils/paths.ts` and `src/projectResolution.ts`. Add `.reverie/` as the canonical lookup; remove `.codexcli/` paths from primary lookup but keep migration trigger for one start.
4. **Auto-migration helper** + tests. Atomic rename, both-exist refusal, crash-resume.
5. **Env var hard cutover** in path resolution, audit, telemetry, project resolution. Remove all `process.env.CODEX_*` reads. Document old name in CHANGELOG breaking-changes only.
6. **MCP tool rename** in `src/mcp-server.ts`. Tool names, descriptions, `extractKey` switch, instrumentation. No legacy registration.
7. **Envelope key update** + back-compat read tests.
8. **String sweep** across source, tests (excluding fixture data that intentionally tests legacy paths via the migration), docs, README. Mass `codex_*` → `reverie_*`, `.codexcli` → `.reverie`, `CODEX_*` → `RVR_*`, "the codex" → "Reverie".
9. **`src/llm-instructions.ts` rewrite.** This is the agent-facing instruction string returned at MCP handshake — the highest-leverage prose surface. Every agent that connects reads it.
10. **`src/commands/claude-md.ts` template update.** This is what `rvr init` writes into new-project CLAUDE.md files. Currently still says "Always use codexCLI MCP tools" (a Phase 3 miss).
11. **README + docs sweep.** `docs/schema-guide.md` (uses `.codexcli.json` extensively), `docs/dogfooding.md`, `docs/token-savings.md`, ROADMAP narrative refs (keep historical refs in pre-rebrand sections).
12. **CHANGELOG.md** new section under `[1.0.0-beta.1]`. Breaking-changes block documents env-var cutover and MCP-tool cutover; non-breaking block documents directory auto-migration.
13. **This repo's own `.codexcli/`** moves to `.reverie/` via `git mv` so rename history is preserved in the diff.
14. **End-to-end soak.** Restore a clean snapshot of an old `.codexcli/`, point `rvr` at it, verify migration completes clean, all entries readable, audit log appended without interruption.
15. **Tag `v1.0.0-beta.1`.** Push (explicit `git push origin v1.0.0-beta.1` since the codex `commands.release` uses lightweight tags — see `context.next_session` for the gotcha).

## Test plan

### New: `src/__tests__/rebrand-migration.test.ts`

| Test | Setup | Expected |
|---|---|---|
| Project migrates | `<root>/.codexcli/` populated, no `.reverie/` | `.reverie/` exists, `.codexcli/` gone, `.codexcli.backup` symlinks to `.reverie/`, all entries readable |
| Global migrates | `~/.codexcli/` populated, no `~/.reverie/` (`HOME` redirected via `RVR_DATA_DIR` for the test) | same shape as project |
| Both exist refuses | both dirs populated | `MigrationConflictError` thrown, neither dir touched |
| Already migrated is no-op | only `.reverie/` exists | no rename, no log noise |
| Crash mid-rename leaves new | rename succeeds, symlink-create fails | next boot skips migration, store boots clean |
| Auto-backups dir migrates | `<root>/.codexcli.backups/` populated | renamed to `.reverie.backups/`, contents intact |

### Existing tests to update

- `src/__tests__/envelope.test.ts` — add cases reading `$codexcli`-keyed payloads, verify writer always emits `$reverie`.
- `src/__tests__/paths.test.ts`, `src/__tests__/projectResolution.test.ts`, `src/__tests__/directoryStore.test.ts` — adjust path strings.
- `src/__tests__/mcp-server.test.ts`, `src/__tests__/mcp-advanced.test.ts`, `src/__tests__/mcp-integration.test.ts` — rename every tool-name reference.
- `src/__tests__/telemetry.test.ts`, `src/__tests__/telemetry-advanced.test.ts`, `src/__tests__/audit.test.ts`, `src/__tests__/miss-path.test.ts` — adjust env-var names and tool-name strings used in assertions.
- `src/__tests__/init.test.ts`, `src/__tests__/claude-md.test.ts` — adjust generated-CLAUDE.md fixture text.

Test count delta: +6 (migration tests) + ~10 envelope back-compat = ~+16. Net target ~1408. (`v1.14.0` baseline was 1394.)

## Risks

1. **Data loss on migration failure.** Mitigated by atomic rename + `.backup` symlink + same-filesystem invariant + idempotent re-run. Same risk profile as v1.10.0 unified→directory migration which shipped without incident.
2. **`.reverie/` dirname collision.** Step 2 of impl explicitly verifies before commit. If contested, fallback options: `.reverie-store/` or accept a `.reverie/` collision warning at startup. Low likelihood.
3. **CLAUDE.md across dogfooded repos.** Hard MCP cutover means every project CLAUDE.md instructing `codex_context` silently routes to nothing. Mitigation: small dogfooding population (mostly the user); manual update across active repos as part of v1.0.0-beta.1 verification. A future `rvr migrate-claude-md` command is out of scope here.
4. **This repo's own codex moves mid-flight.** All in-flight work that touched `.codexcli/` since the rename will conflict. Mitigation: do the migration commit when the working tree is otherwise clean; use `git mv` for rename-history preservation.
5. **Brand-name conflict in MCP tool list.** `reverie_*` is unlikely to collide with another MCP server's tool names. Verify at impl time via the MCP registry / known-server list.
6. **Soak time pressure.** v1.0.0-beta.0 shipped 2026-05-06; bundling this into beta.1 with a meaningful soak window pushes stable to mid-to-late May at earliest. Acceptable per `project.releasePlan` 8-12 week launch timeline.

## Verification gate (before tag)

- `npm run lint` clean.
- `npm run build` clean.
- Full test suite passes — target 1408+.
- Migration soak: clean snapshot of a real `.codexcli/` migrates without error, all entries match pre-migration state.
- Manual: `rvr init` in a fresh dir produces a `.reverie/` directory and a CLAUDE.md that references `reverie_context` (not `codex_context`).
- Manual: MCP handshake from Claude Code surfaces `reverie_*` tools; `rvr` CLI invocations work against the migrated store.
- Manual: existing pre-rebrand export file (with `$codexcli` envelope) imports cleanly into the new store.

## Out of scope (explicit)

- A `rvr migrate-claude-md` command to mass-update CLAUDE.md instructions across the user's projects. Defer to v1.0.x patch if needed post-launch.
- Indefinite `codex_*` MCP-tool aliases. Decision D4 = hard cutover.
- Trademark / domain re-evaluation. `project.identity` already covered this 2026-05-06.
