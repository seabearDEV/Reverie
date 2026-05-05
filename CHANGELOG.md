# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.14.0] - 2026-05-05

### Breaking changes

- **Auto-scope writes refuse when project resolution fails** (`#99`): pre-fix, every write tool (`codex_set`, `codex_remove`, `codex_alias_*`, `codex_confirm_*`, `codex_copy`, `codex_rename`, `codex_import`, `codex_reset`) silently fell through to the user's global store when no `.codexcli/` could be resolved (`CODEX_NO_PROJECT` set, `CODEX_PROJECT` unresolvable, or cwd walk-up exhausted) and the caller did not pass an explicit scope. The 2026-05-05 soak dataset showed this misrouting project-shaped data into global, growing the bootstrap response past the agent's tool-result cap. Auto-scope writes now refuse with a `PROJECT_UNRESOLVED` error naming what the resolver tried and how to recover. Read paths (`codex_get`, `codex_context`, `codex_find`, …) are unchanged — cross-scope reads remain useful when project resolution fails.

  The auto-mode project-then-global *fallthrough* on remove/alias-remove/confirm-remove also collapses: with auto + resolved project, the operation now targets project only. To remove a global entry while inside a project directory, pass explicit `--scope global` (CLI) or `scope: 'global'` (MCP).

  Recovery actions (named in every refusal):
  - run `codex_init` (or `ccli init`) to create a project store
  - retry with explicit `scope: 'global'` (MCP) or `--scope global` (CLI) for an intentional global-store write
  - if `CODEX_NO_PROJECT` is set, unset it before `codex_init`

  MCP refusals return a two-content-block response: the human-readable message in the first block, and a JSON code block carrying `code: 'PROJECT_UNRESOLVED'` plus a `diagnostic` record of which resolver branches fired. CLI refusals exit with code 1 and write the same message body to stderr.

  Telemetry/audit gains `refusedReason: 'project_unresolved'` on refused calls and `rescuedByExplicitGlobal: true` on calls that succeeded under explicit `scope: 'global'` despite project resolution failing — lets us measure how often the escape hatch is in use post-deploy.

### Added

- **`codex_context` size-budget shedding** (`#100`): when the projected response would exceed `bootstrap_max_response_bytes` (config, default 50KB), entries are shed by priority — `files.*` first, then `arch.*`, then large `context.*` (largest-first). `project.*`, `conventions.*`, `commands.*`, `deps.*`, and `context.next_session` are never shed. A one-line notice at the top of the response names what was trimmed and points at `codex_get` or `tier:"full"` for retrieval. `tier:"full"` opts out of degradation entirely. The `CODEX_BOOTSTRAP_MAX_BYTES` env override wins over config (test/integration use). MCP and CLI (`ccli context`, including `--json`) apply the same shed. Telemetry/audit on `codex_context` rows gain `degraded: true` and `shedNamespaces` when shedding fired. Driving evidence: machine 02's `CAS_robot` store hit the host tool-result cap at 89 entries / 26K bytes despite being well-tended — the failure mode is not store-hygiene-specific, any growing store eventually trips it. See `docs/design-100-context-size-budget.md`.

- **`codex_set` write-amp guard** (`#101`): when the same key is set 3+ times in the same MCP session within a 30-min sliding window, the success response gains a `warning:` line naming the count, time-since-first-write, and a pointer to `conventions.seedDensity`. The write itself succeeds — informational only. Telemetry/audit rows gain `writeAmpWarning: true` and `writeAmpCount`. MCP-only (CLI invocations are per-process and have no multi-call session for the guard to attach to). Driving evidence: the 2026-05-05 dataset showed problem keys hit 4-7× rewrites per session (`files.font_awesome_content_view` 7×, `files.icon_search_view` 6×) while disciplined stores cap at 2×. See `docs/design-101-write-amp-guard.md`.

### Documentation

- **Bootstrap tiers + size-budget interaction documented in schema-guide.md** (`#103`): new "Bootstrap tiers" section explains the `essential` / `standard` / `full` cones, gives tier-vs-task guidance (focused work → `essential`, default → `standard`, refactoring/onboarding → `full`), and documents the relationship to `bootstrap_max_response_bytes` from `#100` (shed for non-full tiers, full opts out, pathological-overflow notice when never-shed alone is over). The `codex_context` MCP tool description now references the section so agents don't have to discover the guidance by trial. The `LLM_INSTRUCTIONS` `GUARDRAILS` block gains a line covering the pathological-overflow notice (was undocumented).

### Fixed

- **MCP audit/telemetry rows now log absolute project paths** (`#102`): when the MCP server received a relative launcher hint (`CODEX_PROJECT_DIR=.` env or `--cwd .` arg), `setProjectRootOverride` stored the relative value verbatim, the walk-up resolver returned `.codexcli` (relative), and downstream `path.dirname()` collapsed to `"."` in 234 of 302 audit rows on the 2026-05-05 soak machine. The override now absolutizes via `path.resolve()` at set time, so all walk-up branches return absolute paths and audit/telemetry `project` fields match the resolver's absolute output. Forward-only — historical `"."` rows are not backfilled.

## [1.13.0] - 2026-04-23

Agent-first release driven by mining a 584-call, 15-day real-usage dataset (see `docs/dogfooding-real-usage.md`). Eleven issues closed across three themes: make agent tool-selection unambiguous (#92), make the audit signal clean enough to mine again (#93 + #94), and formalize the cross-session handoff pattern agents organically converged on (#91). The rest — small bug fixes, soak findings, and the first two Layer 2 tools from the seedRoadmap — fell into the same cycle once the milestone was trimmed to match.

Test count: 1269 → 1325 (+56). No breaking behavior changes; MCP tool shapes unchanged.

### Added

- **Cross-session handoff protocol** (`#91`): `codex_context` (CLI + MCP) now renders a top banner when `context.next_session` exists, with relative age (`3h ago`, `2d ago`) and a `[likely stale — Nd]` marker past 7 days. The key is omitted from the entries list below the banner to avoid duplicating content. Tier-independent — appears even at `tier:'essential'`. `DEFAULT_LLM_INSTRUCTIONS` gained a nudge so agents learn to write the key at session end. No new MCP tool; the convention works with existing `codex_set`.
- **Non-interactive password resolution** (`#88`): `askPassword` now resolves from `--password-file <path>` (explicit flag on `set --encrypt`, `get --decrypt`, `run --decrypt`, `edit --decrypt`; refuses world-readable files) and from the `CCLI_PASSWORD` env var (ambient fallback with a one-shot stderr warning). Interactive TTY prompt remains the fallback. Unblocks CI, cron, and script workflows for encrypted entries.
- **`ccli lint --seed-quality`** (`#82`): new heuristic pass on `ccli lint` that flags low-amplification entries (too short with no project-specific signal, matching a known low-amp phrase pattern, or carrying an interpolation landmine). Soft warnings ("consider rewriting"), exempting `commands.*`, `deps.*`, `session.*`, `project.*`, `context.next_session`, and `conventions.seedDensity`. Operationalizes the seed-density principle.
- **`ccli topology`** (`#83`): co-occurrence analysis on the audit log. Surfaces which entries get pulled in the same focused-read sessions and which sit isolated. Signal source is `codex_get` with a specific key; bootstraps (`codex_context`), searches (`codex_find`), and misses are deliberately excluded. `--dot` emits graphviz for visualization; `--json` for pipelines; `--period`, `--limit`, `--min-sessions` for filtering. Alias-canonical (reads via an alias and via the resolved key count as the same entry).

### Changed

- **MCP tool descriptions rewritten for agent tool-selection clarity** (`#92`): all 19 MCP tool descriptions now explicitly disambiguate overlapping pairs. The core behavioral lever: `codex_get` no longer advertises "list all entries" — that affordance was driving a 48% empty-key rate in the dataset (agents using `codex_get` when `codex_context` was the intended tool). Added "prefer X over Y when…" hints for `codex_context` vs `codex_get` vs `codex_find`, `codex_set` vs `codex_alias_set`, `codex_remove` vs `codex_alias_remove`, `codex_copy` vs `codex_rename` vs `codex_alias_set`, `codex_config_*` vs `codex_*`, and `codex_stats` vs `codex_audit`. Documentation-only — no behavior change.
- **CI: `softprops/action-gh-release` v2 → v3** (`#86`): last remaining Node-20 action in `.github/workflows/release.yml`. Gets ahead of the 2026-06-02 forced-Node-24 cutover and the 2026-09-16 Node 20 removal from GitHub Actions runners.

### Fixed

- **`codex_remove` and siblings log `op:"remove"`, not `op:"write"`** (`#93` part 1): `classifyOp` routes `codex_remove`, `codex_alias_remove`, `codex_confirm_remove`, and `codex_reset` to a new distinct `'remove'` op category. Stats output shows removes as a separate count; `readWriteRatio` is now pure (reads / true writes) instead of being inflated ~15% by conflated removes. `codex_audit --writes-only` correspondingly narrows to true writes only.
- **`aliasResolved` reliably captured on CLI `codex_run`** (`#93` part 2): the CLI callsite now pre-resolves the target key and passes both `rawKey` (user input) and `key` (resolved) to the instrumentation wrapper, matching the convention already used by `set`, `get`, and `rename`. Closes the dominant gap surfaced by the dataset (alias `sgdie` captured on only 3 of 6 runs).
- **`codex_copy`'s `aliasResolved` tracks source, not dest** (`#94`): both MCP and CLI wrappers now resolve the source key (the thing that might be an alias) rather than the dest (a new canonical key). Audit `key` semantic preserved — the operation target is still dest.
- **`bootstrapRate` and `writeBackRate` labels clarify MCP-sessions-only** (`#93` part 3): stats output now says "of MCP sessions" instead of the ambiguous "of sessions" — CLI one-shot sessions can't bootstrap, and lumping them in overstated overall discipline.
- **`data import` rejects shape-invalid sections instead of silently dropping them** (`#89`): section extraction was split from the shape check; a present-but-malformed section (e.g. `aliases: "not-an-object"`) now aborts the import with a typed error rather than silently coercing to `undefined` and leaving the other sections to apply. Closes a loophole in the `#77` transactional-import guarantee.
- **Error hints use `getBinaryName()` instead of hardcoded `ccli`** (`#90`): `import_max_bytes` rejection message (CLI + MCP) and the `handleProjectFile` already-exists error no longer point users to a command they may not have installed under a renamed distribution (e.g. `ccli-beta`).
- **Interpolation syntax landmines rewritten** (`#39`): `files.interpolate` and `context.execInterpolation` contained literal `${key}` / `$(key)` references that would fail interpolation. Backslash-escaped each occurrence; post-fix all 77 stored entries interpolate cleanly. Display still renders the unescaped syntax (interpolate resolves the escape before returning).

## [1.12.2] - 2026-04-16

Stable promotion of v1.12.2-beta.1 after successful soak. Beta.0 shipped the consolidated export/import integrity patch (five audit findings from the 2026-04-09 review); beta.1 added one fix found during beta.0 flogging (#87 `_meta` stamping on import). No source-code changes since the beta.1 tag — soak passed clean. See beta entries below for full detail; consolidated summary follows.

### Added

- **Export integrity envelope**: CLI `data export` and MCP `codex_export` now wrap output in a `$codexcli` envelope carrying version, type, scope, `exportedAt`, `includesEncrypted` flag, and a `sha256` of the payload. Imports verify the hash (tamper detection) and surface `includesEncrypted` in the confirmation prompt / preview. Bare-shape files (pre-v1.12.2 exports, hand-written JSON) still import via the backwards-compat path. Closes #78.

### Fixed

- **`data export all` and `data import all` share a file shape**: default is one wrapped file that round-trips cleanly; `--split` preserves the legacy three-file layout. Closes #76.
- **Transactional multi-section imports**: `data import all` (CLI + MCP) validates every section up front and commits all sections in a single `saveAll` cycle. A validation failure in any section rolls back the entire import. Closes #77.
- **Leaf value-type validation**: `validateImportEntries` now rejects non-string leaves (numbers, booleans, arrays, `null`) with a clear error listing the offending keys. Closes #79.
- **Import size cap**: CLI and MCP imports reject payloads larger than `import_max_bytes` (default 50 MB) before reading them. Override via `ccli config set import_max_bytes <bytes>`. Closes #80.
- **Imported entries no longer land `[untracked]`**: `saveAll` stamps `_meta` for new/changed leaves on import so a fresh backup restore doesn't surface every entry as the highest-suspicion staleness tier. Unchanged leaves (under `--merge`) keep their existing timestamps. `_meta` entries for leaves no longer present are dropped. Closes #87.
- **Auto-backup timestamp**: `createAutoBackup` now includes milliseconds in its directory names so back-to-back calls in the same second no longer collide with `mkdirSync EEXIST`.

## [1.12.2-beta.1] - 2026-04-16

Second prerelease of v1.12.2. Adds one bug fix found during beta.0 soak flogging; all beta.0 changes carry forward unchanged.

### Fixed

- **Imported entries no longer land `[untracked]`**: `saveAll` now stamps `_meta` for new/changed leaves on import so a fresh backup restore doesn't surface every entry as the highest-suspicion staleness tier. Unchanged leaves (under `--merge`) keep their existing timestamps. `_meta` entries for leaves no longer present are dropped. Closes #87.

## [1.12.2-beta.0] - 2026-04-16

First prerelease of v1.12.2 — the consolidated export/import integrity patch. Five audit findings from the 2026-04-09 review, batched into one beta for soak testing. Install via `brew install seabearDEV/ccli/ccli-beta` for side-by-side testing with stable.

### Added

- **Export integrity envelope**: CLI `data export` and MCP `codex_export` now wrap output in a `$codexcli` envelope carrying version, type, scope, `exportedAt` timestamp, `includesEncrypted` flag, and a `sha256` hash of the payload. Imports verify the hash (tamper detection), surface `includesEncrypted` in the confirmation prompt / preview, and warn on future version. Bare-shape files (pre-v1.12.2 exports, hand-written JSON) still import via the backwards-compat path. Closes #78.

### Fixed

- **`data export all` and `data import all` now share a file shape**: `ccli data export all -o backup.json` previously wrote three suffixed files (`backup-entries.json`, `backup-aliases.json`, `backup-confirm.json`) that the single-file `data import all` couldn't consume. Default now produces one wrapped file containing all three sections that round-trips cleanly. Pass `--split` for the legacy three-file layout. Closes #76.
- **Transactional multi-section imports**: `data import all` (CLI + MCP) now validates every section up front and commits all sections in a single `saveAll` cycle via the new `saveAll` store primitive. Previously, a validation failure in the aliases section AFTER entries had already been saved left the store half-applied, and process death between section writes had the same effect. Closes #77.
- **Leaf value-type validation**: `validateImportEntries` now rejects non-string leaves (numbers, booleans, arrays, `null`) with a clear error listing the offending keys. Previously these slipped through structural validation and surfaced as confusing errors in downstream read paths. Closes #79.
- **Import size cap**: CLI and MCP imports now reject payloads larger than `import_max_bytes` (default 50 MB) before reading them, so a misplaced heap dump or adversarial input can't OOM the process with a cryptic V8 error. Override via `ccli config set import_max_bytes <bytes>`. Closes #80.
- **Auto-backup timestamp**: `createAutoBackup` now includes milliseconds in its directory names so back-to-back calls in the same second no longer collide with `mkdirSync EEXIST`.

### Notes for testers

Main surfaces to flog:

- **Export-all roundtrip**: `ccli-beta data export all -o backup.json && ccli-beta data reset all --force && ccli-beta data import all backup.json --force` — store should be identical before and after. Try with entries, aliases, and `--confirm`-marked commands all present.
- **`--split` compat**: `ccli-beta data export all -o split.json --split` still produces `split-entries.json` / `split-aliases.json` / `split-confirm.json` for workflows that depend on per-section files.
- **Envelope integrity**: hand-edit an exported `backup.json` (change a value, add a key), then `ccli-beta data import all backup.json --force` — expect a clear sha256-mismatch error, no store mutation.
- **Encrypted roundtrip**: `ccli-beta set api.key secret --encrypt`, then export with `--include-encrypted`, reset, reimport, `ccli-beta get api.key --decrypt` — should return the original plaintext. Without `--include-encrypted`, the export contains `[encrypted]` placeholders and a subsequent import must be *rejected* with a clear error.
- **Backwards compat**: any pre-v1.12.2 export file (bare `{entries, aliases, confirm}` shape, no `$codexcli` envelope) should still import cleanly.
- **Size cap**: create a >50 MB garbage JSON (`yes | head -c 60M > huge.json`), attempt `ccli-beta data import entries huge.json` — expect a clear pre-read rejection naming `import_max_bytes`.
- **Transactionality**: a manually-shaped import with valid entries but a malformed aliases section (e.g. non-string value) must leave entries unchanged. Pre-fix, entries would have been written before aliases validation tripped.

## [1.12.1] - 2026-04-16

Patch release covering two HIGH-severity export/import integrity bugs uncovered in the 2026-04-09 audit.

### Fixed

- **Auto-backup now honors project scope**: `createAutoBackup` previously only copied the global store (`~/.codexcli/`), so `ccli data import` and `ccli data reset` inside a project with `.codexcli/` had no rollback point — the destructive op proceeded against the project store with nothing backed up. Backups now go to `<projectRoot>/.codexcli.backups/` for project scope, and the destructive op aborts if the backup can't be written. Closes #74.
- **Encrypted values survive export/import roundtrip**: exports ran every encrypted leaf through `maskEncryptedValues`, emitting the literal string `[encrypted]`. Re-importing that file silently overwrote real ciphertext in the store with the placeholder, destroying every encrypted entry. Masking on export is still the default (safe for sharing); opt into real ciphertext with `--include-encrypted` (CLI) or `includeEncrypted: true` (MCP `codex_export`). `validateImportEntries` now rejects any import containing the `[encrypted]` sentinel with a clear error naming the offending keys. Closes #75.

## [1.12.0] - 2026-04-16

Stable promotion of v1.12.0-beta.0 after successful soak (2026-04-11 weekend → 2026-04-16). No source-code changes since the beta tag — soak passed clean. See the beta.0 entry below for full detail; the consolidated summary follows.

### Added

- **`ccli audit --follow` / `-f`**: Live audit log streaming. Tails `audit.jsonl` with the same colored format as snapshot mode and supports all existing filters (`--writes`, `--key`, `--src`, `--mcp`, `--cli`, `--project`, `--hits`, `--misses`, `--redundant`, `--detailed`). `--json` emits NDJSON. Closes #41.
- **LLM bootstrap nudge**: `DEFAULT_LLM_INSTRUCTIONS` now tells agents to run `gh issue list --state open` after `codex_context` at session start, so in-flight work is cross-referenced before coding begins. Closes #68.

### Performance

- **Telemetry tail cache**: `loadTelemetry()` caches parsed entries and reads only new tail bytes on subsequent calls, mirroring the `loadAuditLog()` pattern from v1.11.1. Eliminates full file re-read on every `computeStats()` call. Closes #81.
- **Audit query**: `queryAuditLog()` reads cached audit entries directly instead of allocating a defensive `.slice()` copy on every query.

## [1.12.0-beta.0] - 2026-04-10

First prerelease of v1.12.0 — perf + observability mini-release. Install via `brew install seabearDEV/ccli/ccli-beta` for side-by-side testing with stable.

### Added

- **`ccli audit --follow` / `-f`**: Live audit log streaming. Tails `audit.jsonl` and formats new entries with the same colors and layout as snapshot mode. Supports all existing filters (`--writes`, `--key`, `--src`, `--mcp`, `--cli`, `--project`, `--hits`, `--misses`, `--redundant`, `--detailed`). `--json` emits one JSON line per entry (NDJSON). Closes #41.
- **LLM instructions**: Agents are now nudged to run `gh issue list --state open` after `codex_context` at session start to cross-reference in-flight work. Closes #68.

### Performance

- **Telemetry tail cache**: `loadTelemetry()` now caches parsed entries and reads only new tail bytes on subsequent calls, mirroring the `loadAuditLog()` pattern from v1.11.1. Eliminates full file re-read on every `computeStats()` call. Closes #81.
- **Audit query optimization**: `queryAuditLog()` now reads the cached audit entries directly instead of creating a defensive `.slice()` copy, avoiding an O(N) allocation on every query.

### Notes for testers

- `ccli audit --follow` is the main new feature to exercise. Try it with filters: `ccli-beta audit -f --writes`, `ccli-beta audit -f --mcp`, `ccli-beta audit -f --json`.
- In one terminal run `ccli-beta audit -f`, in another run `ccli-beta set test.flog "hello"` — verify the entry appears formatted in real time.
- Ctrl+C should exit cleanly with no dangling watchers.

## [1.11.1] - 2026-04-10

Stable promotion of v1.11.1-beta.8 after successful soak. Consolidates all beta-cycle fixes below. See individual beta entries for commit-level detail.

### ⚠️ Breaking Changes

- **`codex_import` defaults to `merge:true`.** Callers that relied on replace-by-default must pass `merge:false` explicitly.
- **`codex_import` parameter renamed**: `json` → `data`, accepts either a JSON string or an object literal. `type` defaults to `'entries'`.

### Fixed

- **MCP server freeze (3 independent causes):**
  1. **Object.prototype poisoning** — telemetry entries with `__proto__`/`constructor`/`prototype` as namespace poisoned `Object.prototype` via `nsCoverage[e.ns]++`, silently breaking MCP SDK request dispatch. Dict accumulators in `computeStats` now use `Object.create(null)`. (d773c4d)
  2. **Full audit.jsonl re-read on every `loadAuditLog()` call** — added incremental tail cache; subsequent calls read only new bytes. Cache resets on shrink/rotation. (1810fc2)
  3. **Full directory scan on every `scanAndSync()` call** — added dir-mtime fast-skip; if the store directory's mtime is unchanged, the cached entry state is authoritative and per-file scanning is skipped. (b803683)
- **Numeric MCP tool params now coerce strings.** `codex_audit limit`, `codex_stale days`, `codex_get depth` use `z.coerce.number()` so MCP clients passing values as strings no longer hit validation errors. (4ef3800)
- **Validator-bypass + prototype-pollution: 7 latent bugs closed.** `setValue`, `setAlias`, `codex_copy`, `codex_rename`, and `codex_import` had inconsistent or absent key validation. See beta.0 entry for the full breakdown.
- **Interpolation `:?` and circular detection now propagate errors** instead of returning raw literals.
- **`codex_import` preview mode validates keys up-front.**
- **`codex_import type=all` (CLI) properly dispatches sections.**
- **`codex_run` no longer tagged as a redundant write.**
- **`codex_stats` namespace coverage filters noise** from failed ops, searches, and alias operations.
- **`handleError`/`printError` show underlying error message and set `exitCode = 1`.**
- **`getNestedValue` no longer walks the prototype chain** — `codex_get __proto__` returns "not found" instead of `Object.prototype`.
- **`codex_set` with invalid alias name now errors before creating the entry** (no more partial-state on bad alias).

### Changed

- **Packaging**: Beta binary installed as `ccli-beta` via `brew install seabearDEV/ccli/ccli-beta` (dash, not `@beta`).
- **Test count**: 1167 → 1226 (+59 regression tests across validator, prototype-safety, perf, and session-consistency coverage).

## [1.11.1-beta.2] - 2026-04-09

Second packaging-only respin. No source-code changes; the only difference is in `.github/workflows/release.yml` where the beta channel now writes `Formula/ccli-beta.rb` (with class `CcliBeta`) instead of `Formula/ccli@beta.rb` (with class `CcliAtBeta`).

**Why**: Homebrew's `Formulary.class_s` only handles `@<digit>`-versioned formulas (like `python@3.11`, `node@20`). It does NOT handle `@<letter>` like `@beta` — trying to load `ccli@beta.rb` errors with `Expected to find class Ccli@beta`, which isn't even a valid Ruby identifier. Both beta.0 and beta.1 wrote the un-loadable file. The dash form sidesteps brew's `class_s` entirely: `ccli-beta.rb` → `CcliBeta` via the standard separator + capitalize transform.

The release workflow also now removes the obsolete `Formula/ccli@beta.rb` from the tap repo on the first beta tag after this fix lands, so existing tap users running `brew update` stop seeing the load error.

**Install command changes**: `brew install seabearDEV/ccli/ccli-beta` (with a dash, not `@beta`). Binary is still invoked as `ccli-beta`.

## [1.11.1-beta.1] - 2026-04-09

Packaging-only respin of v1.11.1-beta.0. No source-code changes; the only difference is in `.github/workflows/release.yml` where the Homebrew formula generator now installs the beta binary as `ccli-beta` instead of `ccli`. This lets `ccli@beta` coexist on a machine with stable `ccli` (no `brew unlink` cycling required to test the beta side-by-side). Stable formula generation is unchanged — still installs as `ccli`.

After upgrading from beta.0 to beta.1, the binary is invoked as **`ccli-beta`** (not `ccli`). If you already had beta.0 installed via brew, `brew upgrade seabearDEV/ccli/ccli@beta` will replace the keg and the new symlink will be `ccli-beta`.

## [1.11.1-beta.0] - 2026-04-09

First prerelease of v1.11.1, surfaced for beta-channel testing via `brew install seabearDEV/ccli/ccli@beta` before promotion to stable. The work is exclusively bug fixes and validator hardening — no new features. Found by an end-to-end MCP flogging session against the freshly-installed v1.11.0 binary; every fix has live verification + inline regression coverage.

### ⚠️ Behavior Changes

These are bug fixes, but they change visible behavior in ways scripted callers might notice. None of the prior behaviors were documented as features — they were latent bugs surfacing as silent successes or empty responses — but flagging them anyway:

1. **Interpolation `${key:?required-message}` now throws on a missing key.** Pre-fix, the `:?` form silently returned the literal template (`${key:?required-message}`) instead of erroring. The success case (`${present:?msg}` → returns the value) was always correct; only the failure case was broken. The codex docs always claimed `:?` was a "required check" — this aligns the behavior with the docs.
2. **Interpolation circular references now throw with the full chain.** Pre-fix, a cycle like `${a → b → a}` halted at one expansion and returned the literal of the other side, with no surfaced error. Now throws `StrictInterpolationError: Circular interpolation detected: a → b → a`. Subtree-fallback callers (the "raw template if interpolation fails" pattern in `interpolateObject` and `codex_get`) explicitly re-throw `StrictInterpolationError` while still falling back for plain "key not found" errors.
3. **`codex_get __proto__` (and `constructor`, `hasOwnProperty`, `toString`, `valueOf`, `propertyIsEnumerable`, `isPrototypeOf`, `__defineGetter__`, etc.) now return "not found".** Pre-fix, `codex_get __proto__` rendered an empty subtree (because `getValue` returned `Object.prototype` and the formatter walked its enumerable own properties — none); `codex_get constructor` returned the source of the `Object` constructor function. `getNestedValue` now uses `Object.hasOwn` per hop so the prototype chain is invisible to lookups.
4. **Bad import keys now error instead of silently merging.** `codex_import` (MCP) and `ccli data import` (CLI) used to report "merged successfully" for inputs like `{"__proto__":"x"}`, `{"constructor.prototype.polluted":"x"}`, or `{".dotleading":"x"}` and persist nothing — `expandFlatKeys` and `setNestedValue` silently dropped the bad keys via `isSafeKey`. Now both apply and preview paths run the new `validateImport*` family before any save, listing every invalid key in the error.
5. **`codex_set` with `alias=__proto__` (or any invalid alias name) now errors before creating the entry.** Pre-fix, `setValue` would persist the entry, then `setAlias` would throw on the bad alias name — leaving the store in a partial state where the entry existed but the alias didn't, and the user only saw the error. The MCP `codex_set` handler now pre-validates the alias name before any writes.

### Fixed

- **Validator-bypass + prototype-pollution: 7 latent bugs closed in one wave.** End-to-end flogging found that `setValue`, `setAlias`, `codex_copy`, `codex_rename`, and `codex_import` had inconsistent or absent key validation — each entry point had its own gate (or none), and `setNestedValue` / `expandFlatKeys` silently dropped names that hit `isSafeKey`'s rejection list, producing phantom-write semantics where the response said "success" but nothing actually persisted on disk.
  - **Bug 1: `resolveKey` leaked prototype-chain values.** `merged[cleanKey] ?? cleanKey` used unsafe property lookup; for `cleanKey === "__proto__"`, `merged.__proto__` returned `Object.prototype` (truthy), so `resolveKey` returned an *object* instead of a string. The object then propagated into `setValue → setNestedValue` which crashed downstream with `TypeError: path.split is not a function`. Fix: `Object.hasOwn(merged, cleanKey)` for both the project-merged and scope-explicit lookups in `src/alias.ts`.
  - **Bug 2: `setValue` had no key validation.** The only gate was at the file-system layer inside `entryFilePath`, which ran during `save()` — by then `setNestedValue` had already silently dropped bad keys via `isSafeKey`, so the user saw "Set: foo = bar" with no actual persistence. Added an `isValidEntryKey` gate at the top of `setValue` in `src/storage.ts`. `removeValue` got the same treatment (returns `false` instead of throwing for invalid keys, so callers probing with user input get "nothing removed" rather than a crash).
  - **Bug 3: `isValidEntryKey` accepted leading-dot, trailing-dot, and non-string keys.** `.dotleading` slipped through; `expandFlatKeys` then silently normalized it to `dotleading` (because `isSafeKey('')` returned true for the empty first segment, the parent walk broke out, and the leaf got set on the result root). The store ended up with a `dotleading.json` file the read path could never find via `.dotleading`. Added explicit `key.startsWith('.') || key.endsWith('.')` checks plus a `typeof key !== 'string'` defensive guard in `src/utils/directoryStore.ts`.
  - **Bug 4: `getNestedValue` walked the prototype chain.** `obj[keys[0]]` returned inherited values for `__proto__`, `constructor`, `hasOwnProperty`, etc. Now uses `Object.hasOwn` per hop in `src/utils/objectPath.ts`. This single fix closes `codex_get __proto__`, `codex_copy dest=__proto__`'s spurious "already exists" error, and several related symptoms.
  - **Bug 5: `setAlias` accepted any string.** Both alias name and target path are now validated via `isValidEntryKey` in `src/alias.ts`. Pre-fix, `__proto__` got silently dropped on persistence (JSON serialization quirk) and the empty string persisted as `  -> target`, visible in `alias_list` as a phantom entry.
  - **Bug 6: `codex_import` (MCP and CLI) silently dropped bad keys and reported success.** Three new validators in `src/storage.ts` walk the import object via `getOwnPropertyNames` + `getOwnPropertyDescriptor` to defeat the `__proto__` getter trap. Validation runs against the *raw* input (not the post-`expandFlatKeys` form) so leading-dot normalization can't erase the evidence. Wired into both MCP `codex_import` and CLI `importData` for entries, aliases, and confirm sections — including `type=all`.
  - **Bug 7: Partial-state on `codex_set` with bad alias.** `setValue` ran first and persisted the entry, then `setAlias` threw on the invalid alias name. User saw an error but the entry was already saved. Now pre-validates the alias name in the `codex_set` MCP handler before any writes.
- **Interpolation `:?` and circular detection now propagate errors instead of returning literals.** Two related bugs in the same code path: `interpolateObject` and the `codex_get` single-key handler both wrapped `interpolate()` in `try/catch { return raw }`, swallowing every interpolation error including the load-bearing `:?` required check and the circular-reference detection. New `StrictInterpolationError` class in `src/utils/interpolate.ts` is thrown from those paths; subtree fallback re-throws it instead of catching, while still allowing plain "key not found" errors to fall back to raw so a single broken leaf doesn't fail an entire subtree get.
- **`codex_import` preview mode now validates keys.** Pre-fix, the preview branch ran through `flattenObject(expandFlatKeys(input))` which trips the `__proto__` getter trap and silently drops bad keys from the diff. Users saw a clean preview that omitted the bad keys, then got an error on apply. Both MCP and CLI preview branches now run the new `validateImport*` helpers up-front, so the preview either matches what apply would do or fails with the same error.
- **`codex_import type=all` (CLI) now properly dispatches sections.** Pre-fix, the CLI `importData` ran three top-level branches (`if entries || all`, `if aliases || all`, `if confirm || all`) all against the same `validData`, so an `--all` import file shaped `{entries:..., aliases:..., confirm:...}` got saved as entries with literal top-level keys `"entries"/"aliases"/"confirm"` AND tried to save the whole wrapper as aliases (which then failed the `hasNonStringValues` check). The MCP `codex_import` handler always split sections correctly; this brings the CLI into line. An `--all` import with no recognized sections now errors cleanly instead of silently saving the wrong shape.
- **`codex_run` no longer tagged as a redundant write.** The MCP wrapper's `redundant` flag was checked against `isWrite` (which includes `op === 'exec'`), so codex_run was always tagged redundant — the stored command never changes during a run, so before === after is trivially true. Now requires `op === 'write'`, which excludes exec ops. Audit log entries for runs are clean (no `redundant` tag, no spurious "value didn't change" diff lines).
- **`codex_stats` namespace coverage hides noise.** Three sources of phantom namespaces in the dashboard:
  - **Failed operations**: rejected validator writes (`_aliases`, `flog/`, `__proto__`, etc.) showed up as namespaces with 1 write each. The wrapper now plumbs `success` through to telemetry and `computeStats` filters on `success === false`.
  - **`codex_search` keys**: search terms (regex patterns sliced on `.`) produced phantom namespaces like `^arch\` and `flog/`. Filter on `tool === 'codex_search'`.
  - **`codex_alias_set` / `codex_alias_remove` keys**: alias names like `chk` or `flog_test_alias` were treated as entry namespaces. Filter on those tool names too.
- **`handleError` and `printError` now show the underlying error message AND set `process.exitCode = 1`.** Three CLI bugs surfaced by smoke-testing the beta build itself before tagging:
  - **`handleError` swallowed the underlying error in non-DEBUG mode** — printed only `message` (e.g. "Failed to set entry:") and threw away the error text. CLI users hit this when invalid keys produced "Failed to set entry:" with no detail; the actual reason ("Invalid store key: __proto__") was only visible with `DEBUG=true`. Both branches now show `<message>: <error>`, with the stack trace gated on DEBUG.
  - **`handleError` + `printError` returned 0 on most error paths** — scripts wrapping `ccli` couldn't distinguish success from failure. Both helpers now set `exitCode = 1`; every existing call site was already followed by a `return`/abort, so this matches intent without behavioral surprise. Affects every CLI failure path that goes through either helper (set/get/run/import/export/etc.).
  - **`showImportPreview` (CLI `data import --preview`) used the same broken top-level dispatch as the old apply path** — three branches all running against the wrapper `validData`, so an `--all` import file shaped `{entries:..., aliases:..., confirm:...}` got diffed as if the wrapper itself were the entries (showing `[add] entries.foo: bar`, `[add] aliases.alias: target`, etc.). The apply path was fixed earlier in this release; this brings preview into line so what you see in the preview matches what apply would do.
- **Test count: 1167 → 1225** (+58 regression tests). Distributed across `storage.test.ts` (validator gate + import validators + handleError format), `alias.test.ts` (setAlias validation), `objectPath.test.ts` (getNestedValue prototype safety), `interpolate.test.ts` (strict error propagation), `telemetry.test.ts` (namespace filter), `session-consistency.test.ts` (MCP-source case), and `commands.test.ts` (CLI type=all dispatch).

### Notes for testers

- `codex_import preview` now fails up-front for invalid keys; if you have automation that expected the prior "silent merge with empty diff" behavior, that automation needs to handle the new error response.
- The session ID unification fix (PR #67 in v1.11.0) was correct in source but was masked in production by stale long-running MCP server processes that predated the fix. This release adds an MCP-source case to `session-consistency.test.ts` so the gap is no longer in test coverage. If you saw mismatched session IDs in your `audit.jsonl` vs `telemetry.jsonl` after upgrading to v1.11.0, restart your MCP server.
- `codex_get __proto__` returning "not found" is the correct behavior, but if anything in your tooling was scraping the prior empty-subtree response, it'll now see an error response.
- The `flog.*` namespace and `dotleading` orphans seen in `codex_stats` from v1.11.0 testing are historical telemetry — they're stuck in `~/.codexcli/telemetry.jsonl` until you reset the log. New entries from this beta will not pollute the dashboard.

## [1.11.0] - 2026-04-08

### ⚠️ Breaking Changes

Three breaking items in v1.11. Each is small individually; review before upgrading if you script against the CLI.

1. **`withFileLock` fails closed in production.** Lock acquisition failures now throw instead of silently running the closure unlocked. All three production call sites (`directoryStore.save()`, `migrateFileToDirectory()`, `saveJsonSorted()`) were audited and confirmed to have a guaranteed-existing parent directory before invoking `withFileLock`, so the new throw never fires in normal operation. Set `CODEX_DISABLE_LOCKING=1` to restore the pre-v1.11 silent fallback (test-only escape hatch).
2. **`--raw` / `-r` on `get` and `context` removed entirely.** Was a deprecated alias for `--plain` since v1.9.1. Migration: replace any scripted use of `ccli get foo --raw` or `ccli context --raw` with `--plain` (or the new `-p` short). The deprecation warning has been live for two minor versions.
3. **`stats --detailed` and `audit --detailed` moved from `-d` to `-D`.** Frees lowercase `-d` to mean `--decrypt` unambiguously across all read commands (`get`, `run`, `edit`). Mirrors the `-G/-A/-P` capital-letter convention for "broadeners". Anyone passing `-d` to `ccli stats` or `ccli audit` will get a usage error.

### Added

- **`-p` short for `--plain`** on `get` and `context` (closes the original short-flag-audit trigger from `context.shortFlagAudit`). Closes [#62](https://github.com/seabearDEV/codexCLI/issues/62).
- **`-j` short for `--json` on `stats`** — every other JSON-emitting command already had `-j`; `stats` was the lone exception. Pure consistency fix.
- **`CODEX_DATA_DIR` validation, provenance, and documentation** — the env var has always been honored by `getDataDirectory()`, but was undocumented, unvalidated, and invisible. Closes [#63](https://github.com/seabearDEV/codexCLI/issues/63).
  - **Validation**: `CODEX_DATA_DIR` must be an absolute path. Relative values (`./mydata`, etc.) now throw with a clear error rather than silently resolving against `process.cwd()`. Empty strings are treated as unset.
  - **Provenance**: `ccli info` annotates the `Data` line with `(CODEX_DATA_DIR)` when the env var is set, so users can verify their override at a glance.
  - **Writability warning**: if the resolved data directory exists but isn't writable, a one-time warning fires to stderr on first `getDataDirectory()` call.
  - **Docs**: new `## Environment Variables` section in the README listing every `CODEX_*` variable with purpose, default, and notes.
- **`clearDataDirectoryCache()`** in `src/utils/paths.ts` — resets the module-level cache and one-shot flags so a subsequent `getDataDirectory()` call re-reads `CODEX_DATA_DIR`. Mirrors `clearProjectFileCache()`. Primarily for tests.
- **`isDataDirectoryFromEnv()`** in `src/utils/paths.ts` — small predicate so `ccli info` (and tests) can label the data path with its source.
- **`CODEX_DISABLE_LOCKING=1` env var** — test-only opt-out that restores the pre-v1.11 silent-fallback behavior of `withFileLock`. Documented in the README env-var section.
- **`_README.md` hand-edit warning sidecar** — file-per-entry layout's big UX win is that per-entry files are browsable in a file manager, but that also invites developers to tweak them directly (which desyncs per-entry metadata and breaks staleness signals — see `conventions.editSurface`). The store now seeds a `_README.md` on first `save()` and during migration with an in-context nudge pointing at the supported edit paths. Idempotent: a user-customized `_README.md` is never overwritten.
- **Release checklist** at `docs/release-checklist.md` — captures the manual smoke steps for the v1.11 breaking changes plus a reusable per-release template.

### Changed

- **Short-flag namespace audit** — first comprehensive pass at the short-flag space since v1.0. Three flag moves, one orphan adoption, one consistency fix. See the Breaking Changes section for the `-d` → `-D` move on `stats`/`audit`. The other two changes are strictly additive (`-p` for `--plain`, `-j` for `stats --json`). Closes [#62](https://github.com/seabearDEV/codexCLI/issues/62).
- **`GetOptions.raw` field renamed to `plain`** in `src/types.ts` and `ContextOptions.raw` → `plain` in `src/commands/context.ts`. Internal API change; downstream consumers in `src/commands/entries.ts`, `src/commands/context.ts`, and `src/formatting.ts` (`displayTree` / `formatTree`) updated to match.
- **`loadConfig()` returns defensive shallow copies of the cached `Config`** — same hazard PR #58 fixed for sidecar caches in `directoryStore.ts`, found during the defensive shallow-cache audit. `setConfigSetting()` calls `loadConfig()`, mutates the result in place, then calls `saveConfig()` with the mutated reference; under the previous shared-reference behavior, the in-memory cache would be polluted by those mutations between the write and the next mtime-triggered re-read. **All three return paths** (cached, freshly-parsed, ENOENT/error fallback) now return copies; `saveConfig()` also stores a copy in the cache for defense in depth.
- **File-per-entry store: sidecar mtime tracking** — `_aliases.json` and `_confirm.json` were re-read and JSON-parsed on every `scanAndSync()`, even when nothing had changed. They now go through the same mtime-cached path as entry files: a stat-first refresh skips the re-read when mtime matches. Missing sidecars cache as an `-1` sentinel so they're detected the moment they appear on disk. `load()` now returns defensive shallow copies of the cached sidecar maps so callers that mutate-then-save (`setAlias` and friends) can't accidentally pollute the cache.
- **Legacy `-a` flags on `get`/`rename`/`remove` are now hidden from `--help`** — these are undocumented entry points to the alias-subcommand functionality (`ccli get -a` ≡ `ccli alias list`, etc.). They still work for back-compat but no longer appear in `--help` output. The canonical paths are the `alias` subcommands. (`set -a` and `find -a` are documented and remain visible — see `arch.cli` codex entry for the rationale.)

### Removed

- **`--raw` / `-r` on `get` and `context`** — see Breaking Changes #2. Closes [#62](https://github.com/seabearDEV/codexCLI/issues/62).

### Fixed

- **Telemetry consistency: shared session ID between audit and telemetry, accurate CLI `responseSize` measurement** — three related logging bugs that broke cross-log analysis and undercounted CLI traffic in `codex_stats`. Found by inspection of live `~/.codexcli/audit.jsonl` and `telemetry.jsonl`.
  - **Bug 1 — independent session IDs**: `src/utils/audit.ts` and `src/utils/telemetry.ts` each generated their own random `sessionId` at module-load time. Same operation written to both files would have different `session` values, breaking any analysis that joined the two logs by session. Fix: extracted a single shared `sessionId` source into `src/utils/session.ts`; both audit and telemetry now import `getSessionId()` from there. `telemetry.ts` re-exports the helper for backward-compat with the existing `MissPathTracker` consumer.
  - **Bug 2 — CLI reads silently logged `responseSize: undefined`**: the CLI wrapper at `src/utils/instrumentation.ts:142` computed `responseSize` from the `after` value, which is only set for writes. Every CLI read recorded `responseSize: undefined`, so the `codex_stats` "data served" / delivery-cost metric only counted MCP traffic. Token-savings calculations were overstated for CLI-heavy users because the delivery cost (subtracted from gross savings) was undercounted. Fix: new `src/utils/responseMeasure.ts` state machine. The CLI wrapper monkey-patches `process.stdout.write` to count bytes via `addResponseBytes()` while a measurement is active; `withPager` calls `addResponseBytes()` directly when flushing to a spawned pager (the only path that bypasses the wrapper's `stdout.write` hook).
  - **Inconsistency 3 — `responseSize` semantic mismatch between CLI and MCP writes**: MCP wrote the actual response-text size; CLI wrote the after-value size. Different concepts behind the same field name. Fixed automatically by Bug 2's fix — both now measure "bytes the user actually received" (stdout output for CLI, response payload for MCP).
  - **Tests**: 13 new test cases. New `responseMeasure.test.ts` (7 tests, state machine basics + edge cases). New `session-consistency.test.ts` (3 tests, regression coverage for Bug 1 — `logAudit` and `logToolCall` produce matching `session` fields). 3 new integration tests in `entries-advanced.test.ts` exercising the wrapper end-to-end via `execSync` (CLI read records non-zero `responseSize`, CLI write records `responseSize` matching the printed confirmation, audit + telemetry sessions match for the same op).
- **File-per-entry store: torn reads during concurrent writes** — `load()` could observe a partially-committed `save()` when another process was mid-write (some entries updated, others not), with no way to detect it. The store now uses a seqlock-style commit epoch in a new `_epoch.json` sidecar: even values mean "stable," odd means "writer mid-commit." `save()` bumps the epoch to odd before touching any files and to the next even value after all writes complete, both under the existing directory lock. `load()` snapshots the epoch before and after its scan and retries (bounded to 3 attempts with 1–4 ms backoff) if it sees a mismatch or an odd "before" value. Missing or bogus `_epoch.json` reads as 0, so legacy directories and fresh installs transition cleanly through the first save.
- **File-per-entry store: migration race on pristine installs** — `migrateFileToDirectory` ran without a lock. Two processes starting simultaneously on a pristine install could both enter the migration path and race. The migration now runs inside `withFileLock(newDirPath, …)`, reusing the same lock key as the steady-state store, so migrations and normal saves are mutually exclusive. The loser waits, observes the new directory, and returns `already-present`. Migration also seeds `_epoch.json` at 0 inside its tmp directory before the atomic rename, so readers see a coherent epoch from the instant the store directory exists.
- **`withFileLock` fails closed in production** — see Breaking Changes #1. Closes [#61](https://github.com/seabearDEV/codexCLI/issues/61).

## [1.10.0] - 2026-04-07

### Changed

- **File-per-entry store layout** — `.codexcli.json` (project) and `~/.codexcli/data.json` (global) are replaced by a `.codexcli/` directory (project) and `~/.codexcli/store/` directory (global). Each entry lives in its own file as `<dotted-key>.json` with a `{value, meta: {created, updated}}` wrapper. Store-level state lives in sidecar files `_aliases.json` and `_confirm.json`. Automatic, idempotent migration runs on first access after upgrade; old files are renamed to `.backup`. No user-visible CLI or MCP changes — the in-memory shape returned by every store-layer function is identical. Closes [#54](https://github.com/seabearDEV/codexCLI/issues/54).
  - **Why**: the old single-file layout produced merge conflicts for multi-dev projects whenever two developers added different entries on parallel branches — both writes touched the same JSON region and git textual merge fought them. Per-entry files eliminate that entire class of conflicts: git merges the directory file-by-file, so different-key concurrent edits no longer conflict at all, and same-key edits (the rare case where you actually want a human looking) remain visible in the diff.
  - **`meta.created` from day one** — every entry wrapper gets both `meta.created` (set on first write, preserved across updates) and `meta.updated` (bumped on every write). Migrated entries preserve the legacy `_meta[key]` timestamp as both fields; entries that had no legacy timestamp migrate as `[untracked]` (no `meta` block) so `ccli stale` continues to surface them accurately.
  - **Hand-editing is unsupported** — the wrapper format assumes only the CLI, MCP tools, or a future UI touch the files. Direct edits desync per-entry metadata (staleness, future provenance fields) and break the wrapper contract. Documented as `conventions.editSurface` in the codex.
  - **Dirty-tracking save()** — only files whose wrapper changed are rewritten, so single-entry updates touch exactly one file instead of rewriting all N.
  - **Bulk-op atomicity** — `reset --entries` and `import --replace` build the new state in a sibling `.codexcli.tmp/` directory and swap atomically via double-rename; failure mid-swap leaves the old state intact and is self-cleaned on next startup.
  - **`autoBackup`** now recursively copies the new store directory via `fs.cpSync`, plus any lingering legacy files as fallback.
  - **`ccli init`** creates a `.codexcli/` directory (not a file) and seeds empty `_aliases.json` / `_confirm.json` sidecars. `ccli init --remove` and `ccli project --remove` use `fs.rmSync` which handles both the new directory and legacy file uniformly.

### Added

- **`findProjectStoreDir()`** in `src/utils/paths.ts` — purpose-built resolver that walks up looking for a `.codexcli/` directory specifically, used by store internals. `findProjectFile()` remains as the general-purpose "does a project exist, where is it?" query and now recognizes both the new directory and the legacy file, preferring the directory when both exist.
- **`getGlobalStoreDirPath()`** in `src/utils/paths.ts` — returns `~/.codexcli/store/`, the v1.10.0 global store location.
- **Design decision entries in the codex** — `arch.storeLayout` captures the decision and rationale; `conventions.editSurface` codifies the "CLI / MCP / future UI only" rule. Future sessions inherit both without relitigating.

### Removed

- **`createScopedStore` factory** in `src/store.ts` — replaced entirely by `createDirectoryStore` in `src/utils/directoryStore.ts`. Public API (`loadEntries`, `saveEntries`, `loadMeta`, etc.) is unchanged; only the private implementation behind it.
- **`ScopedStore.prime()`** — removed from the interface and implementation. It was a no-op carried forward from the legacy migration cache; the new migration path writes the directory directly and does not need it.

## [1.9.2] - 2026-04-07

### Fixed

- **MCP scope fallback was silent** — when no `.codexcli.json` could be resolved (client doesn't advertise `roots` and `CODEX_PROJECT` isn't pinned), `codex_set` with no explicit `scope` would silently fall through to the global store, so project-specific writes landed in the user's global store with no indication. `codex_context` now leads with `[project: <path>]` or a `[project: NONE — ...]` banner so agents know up-front where writes will land. `codex_set` now appends `Wrote to: project|global` on every write, plus a remediation hint (`pin CODEX_PROJECT or pass scope:"project" explicitly`) when an unscoped write fell through to global. Both changes are additive — no schema changes.

## [1.9.1] - 2026-04-07

### Added

- **Interpolation backslash escape** — `\${key}` and `\$(key)` now emit literal `${key}` / `$(key)` with the backslash consumed. Prevents stored documentation or examples containing interpolation syntax from triggering resolution errors on read.
- **`--plain` flag on `get` and `context`** — replaces the misleadingly-named `--raw`, which implied "no processing" when its actual behavior was "no colors". `-r`/`--raw` is kept as a hidden, deprecated alias and prints a one-line deprecation warning. Closes [#40](https://github.com/seabearDEV/codexCLI/issues/40).
- **`CODEX_PROJECT` env var** — explicit override for the project file location. Accepts a path to a `.codexcli.json` file or its containing directory. Fails closed if the path doesn't exist (no silent walk-up to a different project), so it's safe to pin in `.claude.json` MCP blocks.
- **MCP client roots support** — the MCP server now calls `roots/list` after the initialize handshake and uses the first advertised root as the project file search start. Best-effort and silent for clients that don't implement roots.

### Fixed

- **MCP server bound to the wrong project** — `findProjectFile()` walked up from `process.cwd()`, which silently bound the server to whichever `.codexcli.json` lived above its inherited cwd. The new resolution order is: `CODEX_NO_PROJECT` → `CODEX_PROJECT` → `setProjectRootOverride()` (set from MCP roots and from launcher hints) → `process.cwd()` walk-up. The pre-existing `CODEX_PROJECT_DIR` and `--cwd` launcher hints still work but now apply via the override (no `process.chdir`) and work whether the server is run as a binary or imported.
- **`arch.interpolation` codex entry** — was self-poisoned by its own `${key}` examples, causing `"key" not found` errors on read. Rewritten to use prose descriptions. Also corrected the claim that `--raw` skips interpolation (it's `--source`).

### Maintenance

- **Cleared pre-existing lint backlog** — fixed 6 ESLint errors that had accumulated since v1.9.0, so `npm run lint` (and the `commands.check` alias) is green again. No behavior changes: `prefer-nullish-coalescing`, `prefer-regexp-exec`, `no-floating-promises` (all targets are `sync=true` and resolve immediately, marked `void`), and `no-unnecessary-type-assertion`.

## [1.9.0] - 2026-04-06

### Added

- **Net token savings** — `ccli stats` and `codex_stats` now report delivery cost (tokens consumed by cache hits) and net savings (gross exploration avoided minus delivery cost). Encourages lean, high-signal knowledge bases.
- **Miss-path tracking** — MCP server tracks exploration cost when `codex_get`/`codex_search` misses. Opens a "miss window" that records subsequent tool calls until the agent finds the answer (writeback), moves on, or times out. Stored in `~/.codexcli/miss-paths.jsonl`.
- **Self-calibrating exploration costs** — static per-namespace cost multipliers are replaced with observed medians once 5+ writeback miss-path samples exist. `--detailed` stats show `[observed, n=N]` vs `[static]` per namespace. Calibration status summary in detailed output.
- **`MissWindowTracker` class** — pure state machine in `src/utils/telemetry.ts` with no I/O, fully testable. Handles window lifecycle: open on miss, accumulate on subsequent calls, close on writeback/moved_on/timeout.
- **`miss-paths` reset type** — `ccli reset miss-paths` and `codex_reset type:"miss-paths"` to clear the miss-path log.
- **30 new tests** — `miss-path.test.ts` (MissWindowTracker lifecycle, persistence roundtrip, calibration thresholds), extended `telemetry-advanced.test.ts` (net savings, calibration, backward compat).

### Fixed

- **MCP telemetry missing `project` field** — `logToolCall()` now self-resolves the project directory via `findProjectFile()`, matching `logAudit()`'s behavior. Previously relied on the caller to pass it, which was inconsistent.
- **Fuzz test timeout** — encrypt/decrypt round-trip test (50 trials) now has a 15s timeout instead of the default 5s.
- **MCP test mocks** — `mcp-server.test.ts` and `mcp-advanced.test.ts` mocks updated for new telemetry exports (`MissWindowTracker`, `appendMissPath`, `getSessionId`, `extractNamespace`).

### Changed

- **Stats display updated** — "Est. tokens saved" line now shows "exploration avoided" instead of "agent tool calls avoided". Delivery cost and net savings lines added below. Per-namespace breakdown includes calibration tags.
- **Token savings documentation** — `docs/token-savings.md` rewritten with miss-path calibration methodology, net savings explanation, updated diagrams and worked example.
- **LLM instructions** — `codex_stats` description updated to mention net savings, delivery cost, and calibration.

## [1.8.0] - 2026-04-06

### Added

- **`alias` subcommand group** — `alias set <name> <path>`, `alias remove <name>`, `alias list`, `alias rename <old> <new>`. Dedicated alias management replacing scattered `-a` flags.
- **`confirm` subcommand group** — `confirm set <key>`, `confirm remove <key>`, `confirm list`. Dedicated confirmation management replacing `set --confirm/--no-confirm`.
- **`context` command** — CLI equivalent of MCP `codex_context` with `--tier` filtering (essential, standard, full), `--json`, `--raw`.
- **`info` top-level command** — promoted from `config info`. Shows version, entry counts, storage paths.
- **`search` hidden alias** — `ccli search` works as an alias for `ccli find`, matching MCP `codex_search` naming.
- **Enhanced `ccli init`** — codebase scanner with 6 composable detectors (project, commands, files, deps, conventions, context) and ~50-entry known-deps lookup table. Generates `CLAUDE.md` with AI agent behavioral directives. Seeds `conventions.persistence` (three-file balance rule) and `context.initialized` (agent-driven analysis marker). Flags: `--no-scan`, `--no-claude`, `--force`, `--dry-run`.
- **Agent-driven first-session analysis** — LLM instructions and CLAUDE.md template include FIRST SESSION guidance. Agents detect fresh scaffold via `context.initialized` marker and automatically perform deep codebase analysis (populate `arch.*`, `context.*`, enriched `files.*`).
- **Centralized CLI instrumentation** — `withCliInstrumentation()` wrapper in `src/utils/instrumentation.ts`. All 22 CLI commands now have full telemetry + audit logging with parity to the MCP server wrapper.
- **Shared instrumentation helpers** — `SKIP_AUDIT`, `BULK_OPS`, `captureValue` extracted from MCP server and shared between CLI and MCP wrappers.
- **Knowledge Flywheel** section in README — explains how the knowledge base compounds across sessions and agents.
- **68 new tests** — `scan.test.ts` (44), `claude-md.test.ts` (11), `init.test.ts` (13), `context.test.ts` (6), `cli-restructure.test.ts` (19).

### Changed

- **CLI audit parity** — previously untracked commands now fully instrumented: `run`, `edit`, `alias list`, `alias rename`, `confirm set/remove/list`, `context`, `lint`, `config set/get`, `export`, `import`, `reset`, `init`.
- **`scaffoldProject()` refactored** — inline manifest parsing replaced with `scanCodebase()` from `src/commands/scan.ts`.
- **`filterEntriesByTier` extracted** — moved from `mcp-server.ts` to `src/commands/context.ts`, shared between MCP and CLI.
- **Help text updated** — new commands, subcommands, updated `find` description, completions table.
- **`init` description updated** — from "Create project-scoped .codexcli.json" to "Initialize project (.codexcli.json + CLAUDE.md)".

### Deprecated

- `get -a` — use `alias list` instead (prints notice, still works)
- `remove -a` — use `alias remove` instead
- `rename -a` — use `alias rename` instead
- `init --scaffold` — scanning is now the default (use `--no-scan` to skip)
- `data projectfile` — use `init` instead

## [1.7.0] - 2026-04-06

### Added

- **Staleness awareness in context/get** — `codex_context` and `codex_get` append `[untracked]` / `[Nd]` age tags to stale entries. CLI `get` prints yellow warning for stale entries.
- **Exploration-weighted token savings** — `codex_stats` estimates tokens saved per namespace using weighted exploration cost multipliers. Bootstrap estimation based on response size and entry count. Per-namespace breakdown in `--detailed` output.
- **`EXPLORATION_COST` map** — exported from telemetry.ts for transparency. Documents estimated exploration cost per namespace (files: 2000, arch: 3000, commands: 1000, etc.).
- **Comprehensive test suite expansion** — 633 → 1048 tests across 46 files. Includes concurrency stress tests, MCP integration with real I/O, property-based fuzz tests, store/storage layer tests, telemetry boundary cases.

## [1.6.0] - 2026-04-06

### Added

- **CLI audit enrichment** — CLI entries now include `duration`, `responseSize`, `hit`/`miss`, `redundant`, and `entryCount` metrics. `cclid audit --detailed` shows per-entry metrics for both CLI and MCP entries.
- **CLI read audit entries** — `get`, `find`/`search`, and `stale` commands now create audit entries with hit/miss tracking and entry counts.
- **Token savings estimate** — `codex_stats` and `cclid stats` now show estimated tokens saved via cache hits and bootstrap context reuse (~4 bytes/token).
- **Per-agent breakdown** — `CODEX_AGENT_NAME` is tracked in telemetry. `--detailed` stats show per-agent call/read/write counts.
- **Sync CLI logging** — `logAudit` and `logToolCall` accept `sync` flag for reliable CLI writes that survive process exit.
- **11 new computeStats tests** — hit rate, redundant rate, session duration, response bytes, trends, token savings, agent breakdown, edge cases.
- **2 new sync write tests** — verify `appendFileSync` path for CLI audit and telemetry.
- **`searchEntries` returns match counts** — enables hit/miss and entryCount tracking for search audit entries.

### Fixed

- **CLI audit/telemetry lost on process exit** — CLI used async `appendFile` but the process exited before callbacks fired. Now uses `appendFileSync` for all CLI calls.
- **Batch `set --global` wrote to wrong scope** — batch mode did not forward `options.global` to `setEntry`. Entries went to project scope instead of global.
- **Redundant writes marked as failures** — `success` check required `before !== after`, so same-value writes appeared as failures. Now uses `exitCode`-based success with separate `redundant` flag.
- **Batch set missing `redundant` flag** — only single-key set tracked redundancy. Batch path now detects and flags redundant writes.

## [1.5.1] - 2026-04-06

### Added

- **Two-step MCP confirmation** — `codex_run` for `--confirm` entries returns a one-time `confirm_token` (5min TTL) on first call. Pass token back to execute. `force:true` and `dry:true` bypass.
- **Redundant write detection** — MCP audit entries now flag writes where before/after values are identical.

## [1.5.0] - 2026-04-06

### Added

- **Enriched audit/telemetry metrics** — `duration`, `responseSize`, `requestSize`, `hit`/`miss`, `tier`, `entryCount`, `redundant` fields in MCP audit entries.
- **`--detailed` flag** — `codex_audit` and `cclid audit` show per-entry metrics when `--detailed` is passed.
- **Token-efficiency section in stats** — hit rate, redundant write rate, response bytes, avg latency.
- **`--hits`, `--misses`, `--redundant` audit filters** — query audit log by cache effectiveness.

### Fixed

- **Telemetry race condition** — concurrent MCP calls could interleave JSONL writes. Added pending-write tracking.

## [1.4.2] - 2026-04-06

### Fixed

- **Regex injection in search** — code scanning alert resolved for user-supplied regex patterns.
- **SECURITY.md** — added vulnerability reporting policy.
- **Schema guide** — documented recommended namespaces and prefer-MCP guidance.

## [1.4.1] - 2026-04-06

### Changed

- **Agent-agnostic optimizations** — enriched MCP tool descriptions, tier guidance, deduped arch/files entries.
- **Test isolation** — `CODEX_DATA_DIR` redirects audit/telemetry to temp dir during tests.
- **`conventions.persistence`** — clear lanes for `.codexcli.json`, `CLAUDE.md`, `MEMORY.md`.

## [1.4.0] - 2026-04-06

### Added

- **Tiered `codex_context`** — `essential`, `standard` (default, excludes `arch.*`), `full` tiers to control context size.
- **`files.*` namespace** — key file paths and their roles stored in project data.
- **CLAUDE.md overhaul** — bootstrap instructions, prefer-MCP guidance, write-back reminders.

### Changed

- **Data cleanup** — removed duplicate arch/files entries, enriched tool descriptions.

## [1.3.0] - 2026-04-05

### Added

- **Audit UI redesign** — `cclid audit` with before/after diffs, collapsed dates, color-coded status.
- **Source filters** — `--mcp` and `--cli` flags to filter audit entries by source.
- **Log reset support** — `cclid data reset logs` to clear audit and telemetry logs.

### Fixed

- **DRY cleanup** — extracted `parsePeriodDays`, shared log paths, unified audit filtering.

## [1.2.1] - 2026-04-04

### Fixed

- **75 lint errors resolved** — auto-fixed redundant type constituents, switched to nullish coalescing where safe, added `void` to fire-and-forget telemetry/audit promises, suppressed unavoidable `any` in dynamic MCP tool wrapper.
- **Prototype pollution in `deepMerge()`** — added `isSafeKey()` guard to block `__proto__`, `constructor`, and `prototype` keys during JSON import merges.
- **Audit/telemetry log file permissions** — explicit `0o600` mode on `appendFile` so logs are created owner-readable only.
- **Predictable temp file names in edit** — replaced `Date.now()` naming with `fs.mkdtempSync()` for secure temp directory creation.
- **Encrypted values in audit params** — `sanitizeParams()` now masks encrypted values as `[encrypted]` in addition to redacting passwords.
- **Test data removed from `.codexcli.json`** — cleaned leaked `test.*` and `search.test.*` entries from project data file.

## [1.2.0] - 2026-04-04

### Added

- **Audit log** — full mutation tracking at `~/.codexcli/audit.jsonl`. Captures before/after values, success/fail, scope, agent identity, and sanitized params for every write operation. Encrypted values masked, passwords redacted.
- **`codex_audit` MCP tool** — query the audit log with key filter, time period, writes-only, and limit.
- **`ccli audit [key]` CLI command** — browse audit entries with diff-style before/after display. Supports `--period`, `--writes`, `--json`, `--limit`.
- **Scope tracking in telemetry** — telemetry now tracks scope as `project`, `global`, or `unscoped` for unresolved/auto cases. Stats display shows scope breakdown.
- **`--agent` flag** on `ccli mcp-server` — sets `CODEX_AGENT_NAME` for audit attribution. Also readable via env var.

### Fixed

- **`codex_alias_remove` scope bug** (#36) — MCP handler now uses `removeAlias()` which correctly falls through project → global, instead of manual merged-map delete that silently succeeded on the wrong scope.
- **`codex_stale` and `codex_lint` classification** — now correctly classified as read ops instead of meta.

### Changed

- **Unified CLI + MCP telemetry** — CLI commands now log to telemetry alongside MCP calls. Stats display separates MCP sessions from CLI calls.
- **`.codexcli.json` overhauled** — tightened entries, removed redundant `files.*` namespace, added `project.vision`, `project.install`, `context.devWorkflow`, full `_meta` timestamps.

## [0.8.0] - 2026-04-02

### Added

- **`codex_context` MCP tool** — returns a compact flat summary of all stored project knowledge in one call. Designed for AI agents to bootstrap context at session start.
- **`CODEX_PROJECT_DIR` environment variable** — alternative to `--cwd` for telling the MCP server where the project root is.
- **Recommended schema** — documented namespace conventions (`project.*`, `commands.*`, `arch.*`, `conventions.*`, `context.*`, `files.*`, `deps.*`) for organizing project knowledge.
- **AI agent workflow** — LLM instructions rewritten to guide agents on bootstrapping from stored context, recording discoveries, and maintaining the knowledge base.
- CodexCLI's own `.codexcli.json` populated with real project data as a living example.

## [0.7.0] - 2026-04-02

### Added

- **`ccli init`** — top-level command to create/remove project-scoped `.codexcli.json` (replaces `ccli data projectfile`).
- **`--all` / `-A` flag on `get`** — shows entries from both project and global scopes with section headers.
- MCP `codex_get`: `all` parameter for listing both scopes.

### Changed

- **`ccli get` now shows project entries only** when inside a project directory. Previously showed merged project + global entries with `[P]` markers. Use `-G` for global only, `-A` for both.
- Single-key lookups (`ccli get specific.key`) still fall through project → global transparently.
- `ccli data projectfile` is now a hidden alias for `ccli init`.
- Removed `[P]` prefix markers from listing output.

## [0.6.1] - 2026-04-02

### Added

- **`mcp-server --cwd <dir>`** — set the working directory for the MCP server so it detects project-scoped `.codexcli.json` files. Pass this when registering the server (e.g., `claude mcp add codexcli -- ccli mcp-server --cwd /path/to/project`).
- Updated default LLM instructions to guide AI agents on using project vs. global scope.

## [0.6.0] - 2026-04-02

### Added

- **Project-scoped data** — `ccli data projectfile` creates a `.codexcli.json` in the current directory. Project entries take precedence on reads, with automatic fallthrough to global data. Use `ccli data projectfile --remove` to delete.
- **`--global` / `-G` flag** on `set`, `get`, `run`, `find`, `copy`, `edit`, `rename`, `remove` — explicitly target the global data store when a project file exists.
- **`--global` / `-G` and `--project` / `-P` flags** on `data export`, `data import`, `data reset` — scope data management operations to a specific store.
- **MCP `scope` parameter** — all data-touching MCP tools (`codex_set`, `codex_get`, `codex_remove`, `codex_copy`, `codex_search`, `codex_run`, `codex_alias_*`, `codex_export`, `codex_import`, `codex_reset`) accept optional `scope: "project" | "global"`.
- Tab completion for `data projectfile` subcommand and `--global` / `-G` flags on all data commands.
- `config info` now shows project file path (or "none") alongside the unified data file path.

### Changed

- **Unified data file** — entries, aliases, and confirm metadata are now stored in a single `data.json` (format: `{ entries, aliases, confirm }`). Existing separate files (`entries.json`, `aliases.json`, `confirm.json`) are auto-migrated on first access and backed up as `.backup`.
- `config info` now shows a single "Data" path instead of separate Entries/Aliases/Confirm paths.

## [0.5.1] - 2026-03-24

### Added

- **MCP server LLM instructions** — the MCP server now sends instructions to connected AI agents on initialization, guiding default behavior (e.g., prefer reads over writes). Built-in defaults work out of the box; users can override by setting `system.llm.instructions`.

## [0.5.0] - 2026-03-24

### Added

- **`--depth` / `-k <n>` flag on `get`** — limit key depth for progressive browsing (e.g., `-k 1` for top-level namespaces, `-k 2` for two levels). Works in both flat and tree modes.
- MCP `codex_get` tool: added `depth` parameter for depth-limited key listing

### Changed

- **`get` default output is now keys-only** — `ccli get` now lists keys without values, reducing noise as the data store grows. Use `-v` / `--values` to include values. Leaf values (e.g., `ccli get server.ip`) always show their value.
- MCP `codex_get` tool: added `values` parameter (default `false`; leaf values always include their value)

### Fixed

- Prototype-polluting function in nested object helpers (code scanning alerts #1 and #2)

### Dependencies

- Bump hono from 4.12.0 to 4.12.7
- Bump @hono/node-server from 1.19.9 to 1.19.10
- Bump express-rate-limit from 8.2.1 to 8.3.0
- Bump flatted from 3.3.3 to 3.4.2
- Bump minimatch from 10.2.2 to 10.2.4
- Bump rollup from 4.57.1 to 4.59.0

## [0.3.0] - 2026-02-23

### Added

- **Exec interpolation `$(key)`** — reference a stored command with `$(key)` and its stdout is substituted at read time. Works in `get`, `run`, and tree display. Results are cached per interpolation pass so the same command only executes once.
  - Supports recursion: stored commands can themselves contain `${key}` or `$(key)` references
  - Circular reference detection across `${}` and `$()` boundaries
  - 10-second timeout per command execution
  - `--source` / `-s` shows the raw `$(key)` syntax without executing
- Tab completion for `:` composition in `run` / `r` — e.g. `ccli r cd:paths.<TAB>` completes the segment after `:`
- Namespace prefixes in `get` / `g` tab completion — `ccli g paths<TAB>` now includes `paths` as a candidate so zsh stops at the namespace boundary instead of forcing `paths.`

### Fixed

- Zsh completion script: colons in completion values (from `:` composition) no longer break `_describe` parsing
- Bash completion script: colons no longer cause word splitting issues (removed `:` from `COMP_WORDBREAKS`)

## [0.2.1] - 2026-02-23

### Added

- `copy` command (alias `cp`) — copy an entry or subtree to a new key, with `--force` to skip confirmation
- `--capture` / `-c` flag on `run` — capture stdout for piping instead of inheriting stdio
- `--preview` / `-p` flag on `data import` — show a diff of add/modify/remove changes without modifying data
- Batch set with `key=val` pairs — e.g. `ccli set a=1 b=2 c=3`
- MCP `codex_copy` tool — copy entries via MCP with optional `force` to overwrite
- MCP `codex_import`: `preview` parameter to return diff text without importing
- MCP `codex_run`: `capture` parameter for API consistency (MCP already captures output)
- `--version` / `-V` now shown in main help under global options

### Changed

- Main help (`ccli --help`) now shows only commands, subcommands, and global options; per-command options moved to `<command> --help` submenus
- `set` command description updated to reflect batch mode support

### Fixed

- Nested subcommand `--help` routing — e.g. `ccli data import --help` now correctly shows import options instead of falling through to root help
- `edit` was missing from the tab-completion commands list

## [0.2.0] - 2026-02-21

### Added

- `edit` command (alias `e`) — open an entry's value in `$EDITOR` / `$VISUAL` with `--decrypt` support
- `--json` / `-j` flag on `get` and `find` for machine-readable JSON output
- Stdin piping for `set` — read value from stdin when piped (`echo "val" | ccli set key`)
- `confirm` as a standalone type for `data export`, `data import`, and `data reset`
- Advisory file locking (`fileLock.ts`) — all writes are lock-protected with stale-lock detection
- Auto-backup before destructive operations (`data reset`, non-merge `data import`) in `~/.codexcli/.backups/`
- MCP `codex_set`: `encrypt` and `password` parameters for encrypted storage
- MCP `codex_get`: `decrypt` and `password` parameters for encrypted retrieval
- MCP `codex_run`: `force` parameter to skip confirm check on protected entries
- MCP `codex_export`, `codex_import`, `codex_reset`: support for `confirm` data type
- Windows clipboard support via `clip` command
- `dev:watch` npm script — runs `tsc --watch` for automatic recompilation during development
- `lint` npm script with ESLint and `typescript-eslint` (type-checked + stylistic rulesets)

### Removed

- `start` npm script — redundant with `cclid`
- `dev` npm script — broken with path aliases and redundant with `cclid`
- `prepublish` npm script — not used (SEA distribution)

### Fixed

- `showExamples()` referenced non-existent flags `-k`, `-v`, `-e` — now uses valid flags
- `showHelp()` config signature and subcommands were incorrect — now shows `<subcommand>` with correct list
- `displayAliases` empty-state message referenced deleted command — now shows `set <key> <value> -a <alias>`
- `data export all -o <file>` overwrote the same file three times — filenames now suffixed with type
- MCP `codex_run` ignored `confirm` metadata — now checks confirm before executing
- Data files used default permissions (0644) — now use 0600; directories use 0700

## [0.1.0] - 2026-02-20

### Added

- Hierarchical data storage with dot notation paths
- Command runner with confirmation prompts and dry-run support
- Rich output formatting with color-coded output and tree visualization
- Alias system for frequently accessed paths
- Search with filtering by entries and aliases
- Configuration system (colors, themes)
- Data import/export (JSON format)
- Shell tab-completion for Bash and Zsh
- MCP server for AI agent integration (Claude Code, Claude Desktop)
- Interpolation with `${key}` syntax
- Value encryption with password protection
- Shell wrapper for running builtins in the current shell
- Clipboard integration
- Per-entry run confirmation (`--confirm` / `--no-confirm` flags, `confirm.json`)
- `rename` command for entry keys and aliases (`--set-alias` flag)
- `--force` flag on `remove` to skip confirmation prompt
- `--source` flag for `get` and `run` (show stored value before interpolation)
- `cachedStore` utility with mtime-based caching for aliases, confirm, and data stores
- First-run prompt to install shell completions and wrapper

### Changed

- Consolidated CLI from 13 top-level commands to 7 (`set`, `get`, `run`, `find`, `remove`, `config`, `data`)
- Moved `export`, `import`, `reset` under `data` subcommand
- Moved `info`, `examples`, `completions` under `config` subcommand
- `run` command now accepts variadic keys with `&&` chaining and `:` composition
- Removed `--prefix` and `--suffix` flags from `run`
- Aliases managed via `set -a`, `get -a`, `remove -a` instead of separate `alias` command
- Type-aware ESLint linting with `recommendedTypeChecked` and `stylisticTypeChecked` presets

### Removed

- `init` command (replaced by first-run welcome message)
- SQLite storage backend and `migrate` command
- `codex_init` MCP tool
