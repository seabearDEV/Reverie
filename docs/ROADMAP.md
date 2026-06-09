# Reverie Roadmap

## Vision

Reverie is a structured, persistent knowledge base for software projects — accessible to both humans via CLI and AI agents via MCP. The goal is to make AI agents more efficient by giving them a way to learn, record, and share project knowledge across sessions.

**Planned work is tracked in [GitHub Issues](https://github.com/seabearDEV/reverie/issues).** This document provides the high-level vision and release history.

Reverie 1.0.0 stable shipped 2026-05-07, following a rebrand from codexCLI. See [CHANGELOG.md](../CHANGELOG.md) for full provenance.

---

## What's Next

### Next Release — v1.2.0: Surface Token Diet & Agent-Surface Parity

Data-picked 2026-06-09 from measured MCP/CLI token economics (`context.surfaceTokenEconomics` in the store). Brings the MCP surface to token parity with the CLI, the CLI to statefulness parity with MCP, and closes the [#117](https://github.com/seabearDEV/reverie/issues/117) arc.

- **Lower default bootstrap budget** below MCP-client large-response warnings ([#124](https://github.com/seabearDEV/reverie/issues/124))
- **Quiet `reverie_set` confirmation** — drop the full-value echo ([#125](https://github.com/seabearDEV/reverie/issues/125))
- **Handshake diet** — `DEFAULT_LLM_INSTRUCTIONS` ≤2KB, tools/list trimmed, size regression check ([#126](https://github.com/seabearDEV/reverie/issues/126))
- **Projection params** for MCP read tools — keys-only, size-only ([#127](https://github.com/seabearDEV/reverie/issues/127))
- **CLI session-state & observability parity** — WS3 of #117 ([#119](https://github.com/seabearDEV/reverie/issues/119))
- **Envelope from handler return** — refactor away scattered `setResult` calls ([#120](https://github.com/seabearDEV/reverie/issues/120))

Themes beyond v1.2.0 are picked from soak telemetry per the soak-exit policy (day-7 checkpoint for the current cycle: 2026-06-15) — leading candidates below.

### Smarter Knowledge Management

Make the knowledge base aware of the code it describes, and easier to navigate.

- **Git-aware freshness** — link entries to source files, flag staleness on code changes ([#42](https://github.com/seabearDEV/reverie/issues/42))
- **Entry health** — unified lifecycle, coldness, and staleness check ([#84](https://github.com/seabearDEV/reverie/issues/84))
- **Fuzzy finder** — interactive search via fzf ([#13](https://github.com/seabearDEV/reverie/issues/13)) · leading next-theme candidate
- **Boolean search** — AND, OR, NOT operators ([#43](https://github.com/seabearDEV/reverie/issues/43)) · leading next-theme candidate
- **Richer data types** — lists, multi-line values, typed JSON ([#44](https://github.com/seabearDEV/reverie/issues/44))

### Team & Collaboration

Make the knowledge base useful for teams, not just solo developers.

- **Entry attribution** — track who/what last modified each entry ([#45](https://github.com/seabearDEV/reverie/issues/45))
- **`rvr diff`** — compare local vs committed entries ([#47](https://github.com/seabearDEV/reverie/issues/47))

### Knowledge Reuse Across Projects

- **`rvr pack install`** — share curated knowledge across projects via git URLs ([#115](https://github.com/seabearDEV/reverie/issues/115))

### Platform & Distribution

- **Fish/PowerShell completion** ([#6](https://github.com/seabearDEV/reverie/issues/6))
- **Windows support** ([#49](https://github.com/seabearDEV/reverie/issues/49))
- **`npx reverie`** zero-install usage ([#50](https://github.com/seabearDEV/reverie/issues/50))
- **IDE extensions** — VS Code and JetBrains ([#51](https://github.com/seabearDEV/reverie/issues/51))
- **Performance at scale** — benchmarks, lazy loading, indexing ([#48](https://github.com/seabearDEV/reverie/issues/48))

---

## Release History

v1.0.0 and forward are Reverie. The v0.1.0 → v1.14.0 entries below are codexCLI-era, preserved here for continuity. (Those codexCLI git tags were retired during the v1.1.0 cut so Reverie's v1.x line is collision-free; the history lives on in this document and in `git log`.)

### v1.1.0 — CLI as a First-Class Agent Target
Closes [#117](https://github.com/seabearDEV/reverie/issues/117) (WS1 + WS2). For the cohort that **can't run an MCP server**, the CLI becomes an equivalent agent target. **WS1 — universal structured output:** a global `--json` flag and a session-wide `RVR_OUTPUT=json` wrap *every* command (reads and mutations) in one versioned envelope (`reverie`/`ok`/`command`/`result`/`warnings`/`error`) with a frozen, MCP-parity `error.code` set and non-zero exit on failure. **WS2 — agent bootstrap:** surface-aware instructions (`config llm-instructions --surface cli`, fixing the bug that told CLI agents to "PREFER MCP TOOLS"), an agent-agnostic `AGENTS.md` emitted by `rvr init`, and a new `rvr manifest --json` (command/flag tree + MCP↔CLI map). Breaking change (D3): `--json` reads now nest the value under `result`. WS3 (session-state parity) deferred to [#119](https://github.com/seabearDEV/reverie/issues/119). Tests 1394 → 1430. See [CHANGELOG](../CHANGELOG.md) and `docs/design-117-cli-agent-parity.md`.

### v1.0.0 — Reverie Stable Launch
First Reverie stable release (2026-05-07). SemVer re-baselined under the new product name; the prior codexCLI line ended at v1.14.0. Bun-runtime build pipeline (`bun build --compile`) shipped with the rebrand — ~50% smaller binaries, ~50× faster builds. End-to-end auto-migration from `.codexcli/` → `.reverie/` on first run. 19 MCP tools verified end-to-end against the stable binary. See [CHANGELOG](../CHANGELOG.md).

### v1.14.0 — Guardrails / Data Hygiene
Theme E, picked mid-soak after the 2026-05-05 dataset surfaced bootstrap-overflow as the strongest signal. Five issues closed: project-resolution chokepoint refuses auto-scope writes when no `.reverie/` resolves (#99, breaking change), `reverie_context` size-budget shedding with priority order and pathological-overflow notice (#100), `reverie_set` write-amp warning on 3rd+ same-key write per session (#101), MCP audit `project` field absolutized (#102), tier semantics + size-budget interaction documented in schema-guide.md (#103). New telemetry/audit fields: `refusedReason`, `rescuedByExplicitGlobal`, `degraded`, `shedNamespaces`, `writeAmpWarning`, `writeAmpCount`. Tests 1325 → 1394 (+69).

### v1.13.0 — Agent-First, Dataset-Driven
Shaped by mining a 584-call, 15-day real-usage dataset (see `docs/dogfooding-real-usage.md`). Eleven issues closed: cross-session handoff banner in `reverie_context` (#91), MCP tool description audit to cut agent tool-selection errors (#92), audit log data-quality cleanup (#93, #94), non-interactive password support for CI/scripting (#88), seed-quality lint heuristic (#82), co-occurrence topology command (#83), plus small cleanups and a CI runtime bump.

### v1.12.x — Export/Import Integrity Chain
Transactional multi-section imports, export integrity envelope with sha256, auto-backup project scope, encrypted-roundtrip preservation.

### v1.9.0 — Observed Token Savings
Net token savings, miss-path tracking, self-calibrating exploration costs per namespace.

### v1.8.0 — CLI Restructure
`alias`/`confirm` subcommand groups, `context` command, enhanced `rvr init` with codebase scanning, stored command chains (`--chain`).

### v1.7.0 — Staleness & Testing
Inline staleness tags in `reverie_context`/`reverie_get`, exploration-weighted token savings, test suite overhaul (633 → 1048 tests).

### v1.5.0 — v1.6.0 — Enriched Telemetry
Audit/telemetry metrics (duration, hit/miss, redundant), two-step MCP confirmation, namespace-weighted token savings, import flat-key expansion.

### v1.0.0 — v1.4.0 — Production Ready
Staleness detection, schema validation (`rvr lint`), regex search, audit log, tiered `reverie_context`, agent-agnostic optimizations.

### v0.9.0 — Conditional Interpolation & Telemetry
`${key:-default}`/`${key:?error}`, MCP telemetry, backup rotation, init scaffolding.

### v0.8.0 — GenAI Knowledge Base
`reverie_context` for one-call bootstrap, recommended schema, project-scoped `.reverie/`.

### v0.6.0 — v0.7.0 — Unified Store
Consolidated data format, project/global scope resolution, auto-migration.

### v0.1.0 — v0.5.0 — Core CLI
Hierarchical storage, interpolation, aliases, encryption, MCP server, shell completion.
