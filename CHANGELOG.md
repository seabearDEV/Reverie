# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-07-23

**Theme: Trust — "trust the record."** Scoped at the v1.2.x soak exit from the first cross-machine usage dataset (two machines, ~10 weeks of telemetry): the analysis showed the observability layer itself couldn't be trusted — 56% of one log was untagged test traffic, one repo counted as three projects across path renames, bulk store-population read as write indiscipline, and the stats tools were invisible to their own record. This release makes the measurement layer honest before the next soak cycle reads it, and promotes watcher agents to a first-class pattern.

### Added

- **Test traffic is tagged and excluded** ([#130](https://github.com/seabearDEV/reverie/issues/130)). `RVR_TEST=1` marks telemetry/audit rows `test:true` at write time — rows are never dropped (the log stays evidence), but `stats`/`audit` exclude them by default. Opt back in with `--include-test` (CLI) / `include_test` (MCP). The test harness sets the marker, so suite traffic stays identifiable even if data-dir redirection regresses.
- **Canonical project identity** ([#141](https://github.com/seabearDEV/reverie/issues/141)). Rows carry `projectId` — the git origin URL normalized to `host/owner/repo` (path fallback for non-git projects). `projectBreakdown` groups by it, so directory renames and case variants of one repo count as one project; the raw path stays on the row for filtering.
- **Bulk-population writes segment out of organic stats** ([#142](https://github.com/seabearDEV/reverie/issues/142)). Runs of ≥5 writes ≤1s apart classify as `bulkWrites`; stats gain `organicWrites` and `organicReadWriteRatio`. Validated on the cross-machine dataset: a store that looked 2.6:1 write-heavy is 0.9:1 organically — bulk init is a usage mode, not indiscipline.
- **The observability tools observe themselves** ([#134](https://github.com/seabearDEV/reverie/issues/134)). `reverie_stats`/`reverie_audit` calls are now logged (`op:'meta'` fires for the first time) tagged `selfRef:true`, and excluded from aggregates by default — "stats were never run" and "stats runs are invisible" are finally distinguishable from the record. Audit queries opt back in with `--include-self-ref` (CLI) / `include_self_ref` (MCP).
- **Watch mode for watcher agents** ([#135](https://github.com/seabearDEV/reverie/issues/135)). `rvr audit --follow --json` streams raw NDJSON rows (no envelope — the single-envelope contract covers single-shot commands, not unbounded streams). `--exclude-session <id>` hides a watcher's own traffic; selfRef rows are self-excluded from the stream.
- **Ambient agent attribution** ([#138](https://github.com/seabearDEV/reverie/issues/138)). When `RVR_AGENT_NAME` is unset, the harness is detected from env fingerprints (Claude Code, Codex, Cursor, Copilot, Gemini, Aider); explicit names always win, and detected rows carry `agentDetected:true` as a confidence marker. Closes the fail-open where an unconfigured machine logged everything unattributed.
- **Leg A security automation** ([#131](https://github.com/seabearDEV/reverie/issues/131)): Dependabot (bun + github-actions), weekly `bun audit` cron, CodeQL (push/PR/weekly), private vulnerability reporting enabled, SECURITY.md gains the detection/response policy and hostile-store threat-model scope.
- **Perf regression cron** ([#132](https://github.com/seabearDEV/reverie/issues/132)): weekly MCP stress run with a new `STRESS_MEAN_MS` mean-latency ceiling to catch O(N)-blowup regressions that stay under the per-call slow threshold.

### Fixed

- **`type:'all'` replace imports no longer wipe omitted sections via MCP** ([#133](https://github.com/seabearDEV/reverie/issues/133), data-loss class). `reverie_import` cleared aliases/confirm to `{}` when a replace-all file omitted them — behavior its own preview never showed, and which the CLI never had. The contract is now "omitted sections are untouched," enforced on both surfaces by a shared `computeImportSections` helper so the section math cannot re-diverge.

## [1.2.2] - 2026-06-09

**Quality & performance pass — no new features.** A whole-repo review (dead code, complexity, algorithmic patterns, lint) followed by fixes: several real performance defects, ~530 lines of CLI/MCP twin-implementation dedup, and test code brought under lint. The structural theme: every place the CLI and MCP surfaces carried separate copies of the same logic was a drift bug waiting to happen (one was found and filed as [#133](https://github.com/seabearDEV/reverie/issues/133)) — the copies are now shared modules.

### Security

- **Imported confirm maps must carry the literal value `true`** (pre-release audit finding, medium). `validateImportConfirm` checked keys but never values, so a crafted import file/pack with `"commands.deploy": false` in its confirm section passed validation and — in merge mode — overrode the user's existing `true`, silently disarming the run-confirmation tripwire on a command the user had explicitly gated. Both surfaces (`rvr data import`, `reverie_import`) now reject non-`true` confirm values; a regression test encodes the exploit. Found by the Leg B adversarial audit run for this release, which also re-attacked the restructured `reverie_run` gate and confirmed the v1.2.1 exec-on-read invariants hold.

### Performance

- **`reverie_stats`/`rvr stats` no longer quadratic in read-hits × miss-paths.** The exploration-savings loop called `getExplorationCost` — a full filter + sort of the miss-path log — once per read-hit row instead of consulting its own per-namespace memo. On an all-period stats call over a long telemetry log this was tens of millions of predicate evaluations inside the MCP event loop.
- **Reads after writes stop paying a full store rescan.** `save()`/`setOne()` bump the store directory's mtime but never refreshed the dir-mtime fast-skip token, so every read following a write re-scanned all entry files — defeating the optimization added for exactly that scan. The token is now refreshed post-commit (where it is provably safe).
- **Long-lived MCP server memory leaks plugged**: async audit/telemetry append promises accumulated in module arrays whose only drains were never called (now self-evicting); abandoned `reverie_run` confirm tokens lived forever (now swept on each token create).
- **`rvr find --keys` interpolates lazily** — non-matching entries skip `${ref}` resolution entirely (each ref costs alias + store lookups).

### Changed

- **`rvr stats` section ordering now matches `reverie_stats`** (namespaces → projects → session → savings → agents → tools → trend) — both surfaces render through one shared formatter, which also ends the drift where color thresholds and section order existed only on one side. MCP's header block gains the CLI's two-space indent. JSON output is unchanged (raw stats object).
- **`reverie_run`'s chain and single-key paths now share one dry → confirm → exec gate.** No behavior change; the v1.2.1 exec-on-read fix class was "two parallel run paths, one fixed" — there is now structurally one gate.

### Internal

- Dead code removed: never-called telemetry flush functions, 11 dead barrel re-exports, the `tslib`/`importHelpers` no-op pair, an orphaned 406-line bench script.
- ESLint hardened: core `@eslint/js` recommended was never included (typescript-eslint presets don't bundle it); now on, plus `eqeqeq` and `switch-exhaustiveness-check`. All 16 surfaced findings fixed, including `{ cause }` on re-thrown errors (deliberately *not* on the exec-interpolation error, which would carry child stdout/stderr the terse message intentionally withholds).
- `src/__tests__/` (67 files) was outside every safety net — ESLint-ignored, tsconfig-excluded, and `bun test` doesn't type-check. Now linted (non-type-checked, with test-idiom relaxations); the 51 surfaced findings cleared.
- Shared modules extracted from CLI/MCP twins: `utils/jsonl.ts` (the audit/telemetry tail-cache with the v1.11.1 freeze history — now one implementation), `commands/statsReport.ts`, instrumentation after-value/redundant derivation, `getEffectiveScope`.
- `topology.ts`'s literal NUL bytes rewritten as `'\0'` escapes — grep classified the source file as binary and silently skipped it.

## [1.2.1] - 2026-06-09

**Security patch — `$(key)` exec refs no longer run on read.** A baseline security audit found that `$(key)` exec interpolation executed the referenced stored command as a *side effect of value substitution*, and substitution runs on read/list/JSON/lint/dry/preview paths — not just `run`. A hostile `.reverie/` store shipped inside a cloned repo could therefore achieve code execution the moment an agent merely **read** an entry (`rvr get`, `reverie_get`, `--values`) or ran a "safe" `--dry` preview, with no confirmation. Exec resolution is now opt-in and confined to the actual `run`-execution path.

### Security

- **`$(key)` exec refs are no longer executed on any read/display/dry/preview path** ([GHSA-hf25-j9h5-5vq5](https://github.com/seabearDEV/reverie/security/advisories/GHSA-hf25-j9h5-5vq5)). `interpolate()` now defaults to **not** executing exec refs (leaves `$(key)` literal); only the real `run` execution moment — past the dry and confirm gates — resolves them via the new `interpolateExec()`. Affected surfaces, all now safe: CLI `rvr get`/`get --values`/`get --json`, `rvr lint`, `rvr run --dry`; MCP `reverie_get` (leaf and `values:true` subtree) and `reverie_run` with `dry:true` or pending confirmation. The `--confirm` tripwire previously checked only the top-level key and never the keys reached through interpolation; preview/dry now build from a non-executing pass. Regression tests encode the exploit on both CLI and MCP surfaces.

### Changed

- **`rvr get` on a value containing `$(cmd)` now displays it literally** instead of executing the command and substituting its output. This is the security fix's intended, user-visible consequence: reads do not execute. To run a stored command, use `rvr run`; to emit a resolved command for shell evaluation, `rvr run --source` still resolves exec refs.

### Fixed

- **Plain (non-JSON) `rvr run` now fails closed on a confirm-gated entry when stdin is not a TTY.** Previously the confirmation prompt was gated on `process.stdin.isTTY`, so on a non-interactive surface (agent, CI, piped) the gate was skipped entirely and a `--confirm` entry executed unconfirmed. It now refuses with exit code 1 and `REQUIRES_CONFIRMATION`, matching the JSON-mode behavior; pass `--yes` to execute non-interactively.

## [1.2.0] - 2026-06-09

**Token parity for MCP, statefulness parity for the CLI** — closes the [#117](https://github.com/seabearDEV/reverie/issues/117) dual-surface arc. With parity landed, the generated agent guidance (CLAUDE.md / AGENTS.md from `rvr init`) softens from "prefer MCP, fall back to the CLI" to **"same store, same functionality, either surface"** — MCP earns writes via schema-validated params, the CLI earns filterable reads via pipes.

### Added

- **CLI session-state & observability parity — WS3 of #117** ([#119](https://github.com/seabearDEV/reverie/issues/119)). Closes the CLI-agent telemetry blind spot for the MCP-banned cohort:
  - **`RVR_SESSION`**: export any id once per agent session and every `rvr` invocation sharing it counts as one session, with guardrail state persisted to `~/.reverie/store/sessions/<id>.json` (atomic, lock-guarded, TTL-pruned after 24h; corrupt files degrade to empty, never crash a command). Unset → per-process random id, exactly the old behavior.
  - **Write-amp guard on CLI `set`** (#101 parity): 3rd+ write of the same key within 30 minutes adds a `WRITE_AMP` warning (with `count`) to the JSON envelope's `warnings[]` — stderr in human mode — plus the same `writeAmpWarning`/`writeAmpCount` telemetry and audit fields MCP emits. The window math is shared code (`pruneAndRecord`), not a re-implementation.
  - **Miss-path tracking on CLI reads**: read misses open exploration-cost windows that persist across invocations and close on writeback/hit/timeout, feeding the same `reverie_stats` calibration as MCP sessions. Skipped without `RVR_SESSION` (a window dying with a one-shot process would log noise).
  - **`aliasResolved` audit capture fixed** for `confirm set`/`confirm remove`, which pre-resolved aliases and dropped the raw key — CLI audit rows there never recorded alias→canonical resolution (gap noted in `context.aliasResolvedCapture`).
- **Projection params for read tools** ([#127](https://github.com/seabearDEV/reverie/issues/127)) — pay tokens for the distilled answer, not the full payload, matching what CLI pipes already allowed. `reverie_context` gains `sizeOnly: true` (MCP) / `rvr context --size-only` (CLI): per-namespace entry/byte counts, total, and the effective budget — the tool-native answer to "how big is my bootstrap". The size report accounts for the same fixed overhead (handoff banner, aliases, tier footer) the budget shed does, so `fitsBudget` answers "would a bootstrap at this tier shed?" exactly. `reverie_find`'s `keysOnly` now also projects values out of the response on both surfaces — MCP returns bare keys, `rvr find --keys` returns a key array in the JSON envelope and bare keys in human output (it matched on keys but still echoed every value). `reverie_get` listings already project (`values` defaults to false) — verified, no change.

### Changed

- **JSON envelope `result` is now derived from handler return values** ([#120](https://github.com/seabearDEV/reverie/issues/120)). `withCliInstrumentation` records the handler's return value as the envelope `result` when the command succeeded and nothing was set explicitly — populating the envelope stops being per-site `setResult` discipline (the silent failure mode behind the v1.1.0 `config get`/`config set` bugs). Explicit `setResult`/`failJson` still win for commands whose result is shaped differently from their return value (e.g. `find`). The ~13 scattered `if (isJsonMode()) setResult(...)` sites in set/remove/copy/rename, the inline alias/confirm actions, and config now just return their payload; `withPager` passes return values through. A new guard test sweeps 19 commands asserting every `ok` envelope carries a `result` and stdout is exactly one JSON document — it immediately caught `data export` emitting a result-less envelope, fixed here (`result` now lists the written files).

### Fixed

- **`rvr --json data export` no longer emits a result-less envelope** ([#120](https://github.com/seabearDEV/reverie/issues/120) guard catch): the success message was sunk by the JSON stdout sink and nothing populated `result`. It now returns `{ type, files: [...] }` with the written paths. Same fix for the value-less `set` variants (`set <key> --confirm`/`--no-confirm`/`-a <alias>`), which also succeeded without a `result`; all three are now in the guard sweep.
- **CLI `rvr run` rows are no longer mis-tagged as redundant writes**: the CLI audit wrapper included exec ops in redundant-write detection, where `before === after` is trivially true (a run never changes the stored command) — every successful `run` inflated the duplicate-write stats. Now matches the MCP wrapper (`write` ops only; `import --preview` also excluded).
- **Session-state hardening** ([#119](https://github.com/seabearDEV/reverie/issues/119)): `pruneStaleSessions` now deletes under the session file's lock (an unlocked unlink could race a concurrent holder whose atomic save would resurrect the file), and session-file timestamps are validated per element on load so a corrupt-but-parseable file can't silently suppress the write-amp warning.

- **Default `bootstrap_max_response_bytes` lowered 50KB → 38KB** ([#124](https://github.com/seabearDEV/reverie/issues/124)). A budget-filling `reverie_context` response at the old default was ~12.6k tokens — above the ~10k threshold where MCP clients warn about large responses. 38KB ≈ 9.5k tokens keeps a full bootstrap under the warning with headroom. Stores between 38–50KB will start seeing `[trimmed: …]` notices on standard tier; the old ceiling is one `reverie_config_set bootstrap_max_response_bytes 51200` away.
- **MCP handshake on a token diet** ([#126](https://github.com/seabearDEV/reverie/issues/126)). `DEFAULT_LLM_INSTRUCTIONS` rewritten 8.7KB → 1.9KB — MCP clients truncate server instructions around 2KB, so most of the old blob never reached the agent. The new blob front-loads the bootstrap → check-before-exploring → write-back → handoff loop and points at tool descriptions and `docs/schema-guide.md` for depth. Tool descriptions trimmed 4.4KB → 2.8KB (disambiguation pointers kept). A new size-regression test (`handshake-size.test.ts`) caps the instructions at 2048B, each description at 350B, and the summed descriptions/param-describes so neither regresses.
- **MCP `reverie_set` no longer echoes the stored value back** ([#125](https://github.com/seabearDEV/reverie/issues/125)). The response was `Set: <key> = <entire value>` — re-paying the full value the agent had just sent (~12× the CLI's confirmation on a 1KB seed; a 14-write session spent ~3.8k tokens on echoes alone). It is now a quiet confirmation: `Set: <key> (<bytes>B) → <scope> (<path>)`, with `, encrypted` marking encrypted writes. Alias confirmations and write-amplification warnings are unchanged.

## [1.1.1] - 2026-06-08

### Fixed

- **`rvr init` now generates agent files that name both surfaces** ([#121](https://github.com/seabearDEV/reverie/issues/121)). v1.1.0 split the generated instruction files by surface — `CLAUDE.md` described only the MCP tools, `AGENTS.md` only the `rvr` CLI — but both are read *before* an agent knows which surface it has. A Claude agent without an MCP server read "prefer MCP tools" it couldn't reach and never saw `AGENTS.md` (Claude Code reads `CLAUDE.md`, not `AGENTS.md`). Both files now compose from one shared core (`REVERIE_CORE_GUIDE` + `REVERIE_FIRST_SESSION`) that names **both** surfaces and the prefer-MCP / CLI-fallback rule: every MCP tool has an exact `rvr` equivalent, with `rvr manifest --json` as the map and `rvr config llm-instructions --surface cli` for CLI specifics. Completes the CLI-agent-parity work from [#117](https://github.com/seabearDEV/reverie/issues/117).
- **The MCP handshake instructions now state CLI parity too.** `DEFAULT_LLM_INSTRUCTIONS` (the MCP `instructions` blob) said "PREFER MCP TOOLS" without noting that the `rvr` CLI offers identical functionality. It now points at `rvr manifest --json` and `rvr config llm-instructions --surface cli`, mirroring the CLI blob's existing "prefer MCP when available" acknowledgement — so both fetchable instruction surfaces name both paths.

## [1.1.0] - 2026-06-08

### Added

- **CLI as a first-class agent target** ([#117](https://github.com/seabearDEV/reverie/issues/117)). The CLI now offers the protocol affordances MCP gives an agent, so agents that **cannot run an MCP server** can use Reverie fully through `rvr`. Design: `docs/design-117-cli-agent-parity.md`.
  - **Universal structured output (WS1)**: a global `--json` flag (`rvr --json <cmd>`) and a session-wide `RVR_OUTPUT=json` env var make **every** command — reads *and* mutations — emit exactly one versioned envelope on stdout: `{ "reverie": "1", "ok", "command", "result", "warnings", "error" }`. Errors are structured with a frozen `error.code` set that reuses the MCP server's names (`PROJECT_UNRESOLVED`, `NOT_FOUND`, `INVALID_INPUT`, `REQUIRES_CONFIRMATION`, `ENCRYPTED_NO_PASSWORD`, `DECRYPT_FAILED`, `COMMAND_FAILED`, `INPUT_REQUIRED`, `IO`, `RUNTIME`) and a non-zero exit. `warnings[]` are `{code,message}` objects; `[trimmed]` shed notices surface there (MCP parity). Diagnostics/prompts go to stderr. `run` on a `--confirm` entry without `--yes` returns a stateless `REQUIRES_CONFIRMATION` envelope with the resolved command in `error.preview` (the host owns the permission gate) instead of the MCP two-step token flow.
  - **Agent bootstrap / discovery (WS2)**: surface-aware instructions via `getEffectiveInstructions('cli')` — the CLI variant points agents at `rvr <cmd> --json` and `rvr manifest`, fixing the bug where the default instructions told a CLI-only agent to "PREFER MCP TOOLS" it cannot reach. `rvr config llm-instructions --surface cli` shows them. `rvr init` now also emits an agent-agnostic **`AGENTS.md`** describing the CLI workflow (skip with `--no-agents`). New **`rvr manifest [--json]`** command emits the command/flag tree plus the MCP-tool ↔ CLI-command map and the envelope contract (the `tools/list` analog).

### Changed

- :warning: **Breaking (decision D3, [#117](https://github.com/seabearDEV/reverie/issues/117))**: `--json` on read commands (`get`, `find`, `context`, `stale`, `lint`, `topology`, `stats`, `audit`) previously printed the **bare** value/object. It now prints the value inside the envelope's `result` field. Scripts parsing `rvr get --json <key>` must read `.result` instead of the top level.

### Fixed

- **Advertised error codes are now actually produced** ([#117](https://github.com/seabearDEV/reverie/issues/117)). `ENCRYPTED_NO_PASSWORD`, `DECRYPT_FAILED`, and `INPUT_REQUIRED` were in the frozen set and documented to agents, but no code path emitted them — encryption/decryption/missing-value failures surfaced as the generic `RUNTIME`. The `printError` sites across `run`/`get`/`edit`/`set`/`copy`/`rename`, `data import/export/reset`, and `config` now pass precise codes (`NOT_FOUND`, `INVALID_INPUT`, `ENCRYPTED_NO_PASSWORD`, `DECRYPT_FAILED`, `INPUT_REQUIRED`, `IO`). The error-code list in the CLI instructions and `AGENTS.md` is now interpolated from the single frozen set so the docs can't drift from the code.
- **`config get` / `config set` no longer drop their value in JSON mode.** They are instrumented (so their stdout is sunk) but never populated the envelope, so `rvr --json config get <key>` returned a result-less envelope. They now emit the value/change in `result`.
- **`config llm-instructions`, `config examples`, and `config completions bash|zsh` no longer pollute stdout** under `--json` — they emit their content inside the envelope (`completions install` refuses, being interactive).
- **`audit --follow` is refused in JSON mode** (`INVALID_INPUT`) instead of streaming non-envelope lines forever and never emitting an envelope — a continuous stream can't satisfy the single-envelope contract.
- **`run --json` no longer reports a failed spawn as success.** A `spawnSync` error (bad `$SHELL`, ENOENT) left both `status` and `signal` null, resolving to exit code 0 / `ok:true`; it now surfaces as `COMMAND_FAILED`.

## [1.0.0] - 2026-05-07

**Reverie 1.0.0 stable.** First public stable release of Reverie — bicameral memory for AI-assisted development. The product began life as codexCLI; the rebrand and Bun-runtime swap landed across v1.0.0-beta.0 → v1.0.0-beta.3, all in the days leading up to this stable cut. See those entries below for the full narrative; this entry summarizes what makes 1.0.0 itself.

### What's in 1.0.0

- **Brand**: Reverie. Binary: `rvr` (stable) / `rvr-beta` (beta channel) / `rvr-dev` (local dev). Repo: `seabearDEV/reverie`. NPM: `@seabear/reverie` (scoped). Homebrew tap: `seabearDEV/homebrew-reverie`. Store directory: `.reverie/`. MCP tools: `reverie_*`. Env vars: `RVR_*`.
- **Build pipeline**: `bun build --compile` produces single-file binaries for Linux x64, Linux arm64, macOS universal (arm64 + x64 fat binary), and Windows x64. Roughly 50% smaller and ~50× faster to build than the prior Node SEA pipeline.
- **MCP-first surface**: 19 tools exposed over the Model Context Protocol; `reverie_context` is the canonical bootstrap call for AI agents. Co-equal CLI surface for human inspection and editing.
- **Migration story**: existing `.codexcli/` project stores and `~/.codexcli/` global stores auto-migrate to `.reverie/` on first run via atomic same-filesystem rename. Pre-rebrand `$codexcli`-keyed export files import unchanged. CLAUDE.md files in dogfooded projects need a one-time `codex_*` → `reverie_*` swap.

### Since v1.0.0-beta.3

- **`fix(completions)`**: zsh completion script now emits `_` instead of `-` in `local`/parameter-name interpolations so hyphenated binary names (`rvr-beta`, `rvr-dev`) parse cleanly. Closes [#111](https://github.com/seabearDEV/reverie/issues/111). Removes the need for the sed-pipe workaround in shellrc files.

### Provenance

The `v1.0.0` git tag previously pointed at a pre-rebrand codexCLI placeholder release (2026-04-04, four `ccli-*` binaries with single-digit download counts). That release and its tag were deleted as part of the stable cut so `v1.0.0` now refers to the canonical Reverie launch. Anyone who downloaded the placeholder binaries should `brew install seabearDEV/homebrew-reverie/rvr` (stable) or `brew upgrade rvr-beta` (beta channel) to get a real Reverie binary.

## [1.0.0-beta.3] - 2026-05-07

**Hot-fix for v1.0.0-beta.2.** That release was functionally broken: the bun-compiled binary tried to write its data directory to a path baked in at build time (`/Users/runner/work/reverie/reverie/data`, the GitHub Actions runner's source path), causing every save to fail with `EACCES`. The MCP server was non-functional, and `--version` output was corrupted by a welcome banner that fired on every invocation. Three contributing causes, all in beta.2 → beta.3:

### Fixed

- **`isDev()` no longer trips under bun-compiled binaries**: Bun sets `NODE_ENV=development` at runtime in compiled binaries (despite `--compile` implying `--production` at build time). Combined with `__dirname` being baked at compile time, this routed `getDataDirectory()` to a build-host path that doesn't exist on user machines. New guard: detect bun-compile via `process.argv[1]?.startsWith('/$bunfs/')` and short-circuit before the `NODE_ENV` check.
- **First-run welcome banner now writes to stderr** (was stdout). Stdout is JSON-RPC framing for `mcp-server` and is consumed by pipes/scripts for other commands. Banner additionally short-circuits in `mcp-server` mode so even stderr noise stays minimal there.
- **`getBinaryName()` handles bun-compile correctly**: bun's compiled binaries report `argv[0] = "bun"` and `argv[1] = "/$bunfs/root/<build-time-outfile>"`. Both lose the runtime invocation name. Falls back to `process.execPath` (which IS the user-invoked path) when the bunfs prefix is detected. Beta.2's banner said `rvr-macos-arm64` instead of `rvr-beta`; beta.3 says `rvr-beta` (or whatever symlink name was used).

### Validation

End-to-end MCP probe against the beta.3-style local build: 19 tools, initialize handshake clean, `reverie_get` returns the right value. `--version` output is plain `1.0.0-beta.3`. The lessons from this miss are recorded in `context.bunCompileGotchas` (new) so future bun-runtime work doesn't re-trip them.

## [1.0.0-beta.2] - 2026-05-07

Build-system swap from Node SEA + esbuild + postject to `bun build --compile`. Toolchain change is internal — user-facing binaries behave identically (verified end-to-end via the release matrix on `v0.0.0-debug.1`). Smaller, faster, simpler. No source/runtime semantics change.

### Changed

- **Build pipeline**: `scripts/sea-build.js` now shells out to `bun build --compile`. Replaces ~140 lines of esbuild bundle → SEA blob → Node binary copy → postject inject → codesign with a thin wrapper. Auto-infers cross-compile target from output-name (`rvr-macos-x64` → `bun-darwin-x64`); accepts the legacy `--node-binary` flag with a deprecation warning so existing CI invocations don't break.
- **CI release workflow** (`.github/workflows/release.yml`): adds `oven-sh/setup-bun@v2`, drops the macOS x64 Node tarball download step (bun cross-compiles natively from arm64 runner). End-to-end release-matrix wall time dropped from ~3m to ~1m35s.
- **Binary size**: `rvr-linux-x64` 103 MB (was ~125 MB), `rvr-macos-universal` 134 MB (fat: arm64 + x64 in one). Bun runtime is more compact than the SEA-injected Node binary.
- **Build time per binary**: ~100ms (was multi-second).

### Removed

- **devDependencies**: `esbuild` and `postject` (-514 lines of `package-lock.json`). No longer used after the bun swap.

### Fixed

- **`src/storage.ts`**: `export { Scope }` → `export type { Scope }`. Required for raw-TS execution under Bun (`bun src/mcp-server.ts`); doesn't affect compiled output.

### Internal

- Codex (`.reverie/`) store residue swept: 33 entries refreshed to use post-rebrand names (`codex_*` → `reverie_*`, `CODEX_*` → `RVR_*`, `.codexcli/` → `.reverie/`, `ccli` → `rvr`, "the codex" → "Reverie"). The `project.storeResidueC` tracker entry is removed (workstream complete; methodology preserved in commit `b888cea`).
- Issue [#111](https://github.com/seabearDEV/reverie/issues/111) filed for a zsh-completion-script bug surfaced during shell cleanup (binary names containing `-` produce illegal shell variable identifiers). Workaround in user shellrc; source fix queued separately.

## [1.0.0-beta.1] - 2026-05-06

Deep rebrand of the data-layer surfaces that v1.0.0-beta.0 deliberately preserved. The Phase 3 carve-out for `codex_*` MCP tools, `.codexcli/` directory, `$codexcli` envelope, `CODEX_*` env vars, and "the codex" lowercase noun has been REVERSED. Every surface a developer or agent touches now uses the Reverie name. See `docs/design-rebrand-deep.md` for the full design rationale.

### Breaking Changes

1. **Project + global store directories renamed**: `.codexcli/` → `.reverie/`, `~/.codexcli/` → `~/.reverie/`, `<root>/.codexcli.backups/` → `<root>/.reverie.backups/`. **Auto-migrated on first access** via atomic same-filesystem rename — no user action needed for existing stores. Refuses if both old and new paths exist (surface and resolve manually rather than silently merge or overwrite).

2. **Env vars renamed (hard cutover, no shim)**: `CODEX_DATA_DIR` → `RVR_DATA_DIR`, `CODEX_PROJECT` → `RVR_PROJECT`, `CODEX_PROJECT_DIR` → `RVR_PROJECT_DIR`, `CODEX_NO_PROJECT` → `RVR_NO_PROJECT`, `CODEX_AGENT_NAME` → `RVR_AGENT_NAME`, `CODEX_DISABLE_LOCKING` → `RVR_DISABLE_LOCKING`, `CODEX_BOOTSTRAP_MAX_BYTES` → `RVR_BOOTSTRAP_MAX_BYTES`. Same precedent as the v1.0.0-beta.0 `CCLI_PASSWORD`/`CCLI_PAGER` cutovers.

3. **MCP tool names renamed (hard cutover, no shim)**: all 19 `codex_*` tools → `reverie_*` (`reverie_get`, `reverie_set`, `reverie_context`, `reverie_run`, `reverie_audit`, `reverie_stats`, `reverie_alias_set`, `reverie_config_set`, etc.). **CLAUDE.md files in dogfooded projects need a one-time update** — agents calling `codex_context` will get tool-not-found errors until updated.

4. **Generic noun "the codex" dropped from prose** in favor of "Reverie" used as a system name (pattern: Git, Docker, Make). README, CLAUDE.md template, llm-instructions, and docs sweep accordingly. Brand pull-through is now consistent at every developer touchpoint.

### Non-breaking changes

- **Export envelope** (`reverie_export` / `rvr data export` output) writes a `$reverie` wrapper key going forward. **Pre-rebrand `$codexcli`-keyed exports import unchanged** — `tryUnwrapImport` accepts either key indefinitely. Files in the wild stay round-trippable.

- **Pre-v1.10 single-file `.codexcli.json` migration path is preserved** — encountering this legacy format triggers conversion directly to `.reverie/` (skipping the intermediate `.codexcli/` directory format that v1.10–v1.0.0-beta.0 used).

- **`docs/design-rebrand-deep.md`** added — full design (D1–D6 decisions, migration algorithm, test plan, 15-step impl order).

### Migration

For most users, migration is automatic on first run of v1.0.0-beta.1+:

- **Existing `.codexcli/` project stores** auto-rename to `.reverie/` via atomic `fs.renameSync` on first walk-up resolution. Sibling `.codexcli.backups/` likewise renames to `.reverie.backups/`.
- **Existing `~/.codexcli/` global store** auto-renames to `~/.reverie/` on first store init. All sidecars (audit log, telemetry, config, miss-paths, backups) ride along.
- **Existing exports** (JSON files containing a `$codexcli` envelope) import unchanged. Re-exporting writes the new `$reverie` key.
- **Pre-rebrand env vars** (`CODEX_*`) stop being honored — set the new `RVR_*` equivalents in your shell/MCP config.
- **CLAUDE.md across dogfooded projects** must be updated by hand to call `reverie_context` instead of `codex_context`. (A future `rvr migrate-claude-md` command is candidate post-launch tooling but out of scope for v1.0.0-beta.1.)

### Verification (pre-tag)

- typecheck clean (`tsc --noEmit`)
- lint clean (`eslint src/`)
- 1392/1392 tests pass under vitest (Node)
- this repo's own project store auto-migrated `.codexcli/` → `.reverie/` cleanly via the new path resolver during the test run

## [1.0.0-beta.0] - 2026-05-06

First prerelease on the new brand. Ships under the beta channel — `brew install seabearDEV/reverie/rvr-beta` — so it can coexist with the legacy `ccli` install and validate the renamed release pipeline against `homebrew-reverie` end-to-end. Source-code-wise this is a rename, not a feature change; behavior matches v1.14.0. The Reverie v1.0.0 stable launch follows once Phase 2 (Bun commit-phase via Option A, short-flag audit) and Phase 4 (commercial infrastructure) land.

### Rebrand: codexCLI → Reverie

**The product has been renamed from codexCLI to Reverie.** Git history continues — this is a rename, not a fork — so existing dogfooding case studies and project memory are preserved.

What's changing:

- **Package name**: `codexcli` → `@seabear/reverie` (npm)
- **Binary name**: `ccli` → `rvr` (Homebrew / GitHub Releases binary). Dev binaries: `cclid` → `rvr-dev`, `cclid-mcp` → `rvr-dev-mcp` (npm `bin`)
- **Repository**: `seabearDEV/codexCLI` → `seabearDEV/reverie` (GitHub auto-redirects from the old URL)
- **Homebrew tap**: `seabearDEV/homebrew-ccli` → `seabearDEV/homebrew-reverie`
- **Brew formula**: `ccli.rb` / `ccli-beta.rb` → `rvr.rb` / `rvr-beta.rb`. Class names `Ccli` / `CcliBeta` → `Rvr` / `RvrBeta`
- **MCP server identifier**: `codexcli` → `reverie` in client config blocks (the key name in `mcpServers`)
- **Env var**: `CCLI_PASSWORD` → `RVR_PASSWORD` (CI/scripting password fallback — breaking)
- **Env var**: `CCLI_PAGER` → `RVR_PAGER` (pager override — breaking; falls through to `PAGER` and then `less -FRX` if unset)

What's **NOT** changing (load-bearing data-layer naming, per `project.identity` convention):

- **MCP tool names** keep the `codex_*` prefix — `codex_get`, `codex_set`, `codex_context`, `codex_run`, etc. They manipulate the codex data structure, not the product.
- **The codex** (lowercase) remains the generic noun for the data store / project knowledge layer. Agents talk to "the codex"; users invoke `rvr`.
- **`.codexcli/` directory** is the per-project store on disk. Existing project stores remain readable without migration. The data format is unchanged.
- **`~/.codexcli/`** is the global store / audit log location.
- **`$codexcli` envelope wrapper key** in exports — preserves round-trip compatibility with files exported from older versions.
- **`CODEX_*` env vars** (`CODEX_DATA_DIR`, `CODEX_PROJECT`, `CODEX_NO_PROJECT`, `CODEX_PROJECT_DIR`, `CODEX_AGENT_NAME`, `CODEX_BOOTSTRAP_MAX_BYTES`, `CODEX_DISABLE_LOCKING`).

### Migration

For most users, migration is automatic:

- **Existing `.codexcli/` project stores** keep working. Same file format, same on-disk layout. Bootstrap, get, set, run — all unchanged.
- **GitHub URLs** auto-redirect from `seabearDEV/codexCLI` → `seabearDEV/reverie`. Bookmarks and existing PR/issue links continue to resolve.
- **Brew installs**: this beta ships under `seabearDEV/reverie/rvr-beta` (new tap). Once v1.0.0 stable lands you can switch to `seabearDEV/reverie/rvr`. Existing `brew install seabeardev/ccli/ccli` users will continue to receive the legacy `ccli` binary from the auto-redirected old tap until they retap.
- **Removed**: the hidden `ccli completions <bash|zsh|install>` back-compat shim. v1.0.0 is a fresh product launch — re-run `rvr config completions install` to regenerate shell completions for the new binary name.

### Verification (pre-tag)

- typecheck clean (`tsc --noEmit`)
- lint clean (`eslint src/`)
- 1392/1392 tests pass under vitest (Node)
- `npm run build` succeeds (`@seabear/reverie@1.0.0-beta.0`)

### Phase status (private to project store)

Tracked in `project.releasePlan` in the repo's `.codexcli/`:

- **Phase 1** (pre-flight): COMPLETE — domain/trademark clearance, Bun runtime validate (PASS).
- **Phase 2** (technical foundation — Bun commit-phase, short-flag audit): pending.
- **Phase 3** (rebrand sweep — this release): COMPLETE.
- **Phase 4** (commercial infrastructure — SeaBear Studios product page, consulting tier): pending.
- **Phase 5** (launch announcement, Dogfooding Part Three blog): pending.

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
