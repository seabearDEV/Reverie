# Reverie Roadmap

## Vision

Reverie is a structured, persistent knowledge base for software projects — accessible to both humans via CLI and AI agents via MCP. The goal is to make AI agents more efficient by giving them a way to learn, record, and share project knowledge across sessions.

**Planned work is tracked in [GitHub Issues](https://github.com/seabearDEV/reverie/issues).** This document provides the high-level vision and release history.

---

## What's Next

### Smarter Knowledge Management

Make the knowledge base aware of the code it describes, and easier to navigate.

- **Git-aware freshness** — link entries to source files, flag staleness on code changes ([#42](https://github.com/seabearDEV/reverie/issues/42))
- **Live audit streaming** — `rvr audit --follow` for real-time formatted output ([#41](https://github.com/seabearDEV/reverie/issues/41))
- **Fuzzy finder** — interactive search via fzf ([#13](https://github.com/seabearDEV/reverie/issues/13))
- **Boolean search** — AND, OR, NOT operators ([#43](https://github.com/seabearDEV/reverie/issues/43))
- **Richer data types** — lists, multi-line values, typed JSON ([#44](https://github.com/seabearDEV/reverie/issues/44))

### Team & Collaboration

Make the knowledge base useful for teams, not just solo developers.

- **Entry attribution** — track who/what last modified each entry ([#45](https://github.com/seabearDEV/reverie/issues/45))
- **Merge conflict handling** — custom merge driver or tooling for `.codexcli.json` ([#46](https://github.com/seabearDEV/reverie/issues/46))
- **`rvr diff`** — compare local vs committed entries ([#47](https://github.com/seabearDEV/reverie/issues/47))

### Platform & Distribution

- **Fish/PowerShell completion** ([#6](https://github.com/seabearDEV/reverie/issues/6))
- **Windows support** ([#49](https://github.com/seabearDEV/reverie/issues/49))
- **`npx reverie`** zero-install usage ([#50](https://github.com/seabearDEV/reverie/issues/50))
- **IDE extensions** — VS Code and JetBrains ([#51](https://github.com/seabearDEV/reverie/issues/51))
- **Performance at scale** — benchmarks, lazy loading, indexing ([#48](https://github.com/seabearDEV/reverie/issues/48))

### Long-term: Go Rewrite

A Go rewrite is planned for better performance and single-binary distribution without Node.js. Port core operations, MCP server, and data format compatibility. No issue yet — this is a future initiative.

---

## Release History

### v1.14.0 — Guardrails / Data Hygiene
Theme E, picked mid-soak after the 2026-05-05 dataset surfaced bootstrap-overflow as the strongest signal. Five issues closed: project-resolution chokepoint refuses auto-scope writes when no `.codexcli/` resolves (#99, breaking change), `codex_context` size-budget shedding with priority order and pathological-overflow notice (#100), `codex_set` write-amp warning on 3rd+ same-key write per session (#101), MCP audit `project` field absolutized (#102), tier semantics + size-budget interaction documented in schema-guide.md (#103). New telemetry/audit fields: `refusedReason`, `rescuedByExplicitGlobal`, `degraded`, `shedNamespaces`, `writeAmpWarning`, `writeAmpCount`. Tests 1325 → 1394 (+69).

### v1.13.0 — Agent-First, Dataset-Driven
Shaped by mining a 584-call, 15-day real-usage dataset (see `docs/dogfooding-real-usage.md`). Eleven issues closed: cross-session handoff banner in `codex_context` (#91), MCP tool description audit to cut agent tool-selection errors (#92), audit log data-quality cleanup (#93, #94), non-interactive password support for CI/scripting (#88), seed-quality lint heuristic (#82), co-occurrence topology command (#83), plus small cleanups and a CI runtime bump.

### v1.12.x — Export/Import Integrity Chain
Transactional multi-section imports, export integrity envelope with sha256, auto-backup project scope, encrypted-roundtrip preservation.

### v1.9.0 — Observed Token Savings
Net token savings, miss-path tracking, self-calibrating exploration costs per namespace.

### v1.8.0 — CLI Restructure
`alias`/`confirm` subcommand groups, `context` command, enhanced `rvr init` with codebase scanning, stored command chains (`--chain`).

### v1.7.0 — Staleness & Testing
Inline staleness tags in `codex_context`/`codex_get`, exploration-weighted token savings, test suite overhaul (633 → 1048 tests).

### v1.5.0 — v1.6.0 — Enriched Telemetry
Audit/telemetry metrics (duration, hit/miss, redundant), two-step MCP confirmation, namespace-weighted token savings, import flat-key expansion.

### v1.0.0 — v1.4.0 — Production Ready
Staleness detection, schema validation (`rvr lint`), regex search, audit log, tiered `codex_context`, agent-agnostic optimizations.

### v0.9.0 — Conditional Interpolation & Telemetry
`${key:-default}`/`${key:?error}`, MCP telemetry, backup rotation, init scaffolding.

### v0.8.0 — GenAI Knowledge Base
`codex_context` for one-call bootstrap, recommended schema, project-scoped `.codexcli.json`.

### v0.6.0 — v0.7.0 — Unified Store
Consolidated data format, project/global scope resolution, auto-migration.

### v0.1.0 — v0.5.0 — Core CLI
Hierarchical storage, interpolation, aliases, encryption, MCP server, shell completion.
