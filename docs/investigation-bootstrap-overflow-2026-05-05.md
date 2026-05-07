# Investigation: bootstrap context overflow

**Date:** 2026-05-05
**Triggered from:** FA-iOS session (`~/Projects/github.com/seabearDEV/sandbox/font-awesome/font-awesome-ios`)
**Status:** RESOLVED — fixes shipped in v1.14.0 (#99, #100, #101, #102, #103). See "Resolution" section at the bottom.

## Symptom

`codex_context` with default tier (`standard`) succeeded. `codex_context` with `tier: "full"` failed:

```
Error: result (68,222 characters) exceeds maximum allowed tokens.
Output has been saved to <tool-results>/...txt
```

The tool fell back to the file-spill path. The host (Claude Code) caps a single tool result around ~25k tokens, so a 68KB JSON payload blows past it. `tier: "essential"` (~6 entries) bootstrapped fine.

## Root cause: two contributing factors

### 1. Tool-level: no upper bound on bootstrap payload size

`codex_context` materializes every entry in scope into a single response. There is no:

- per-namespace size budget
- pagination/cursor
- preflight warning when the store is approaching the host's per-tool-result cap
- write-time nudge when total store size crosses a threshold

In a host with a per-tool-result token limit, a sufficiently populated store can become unbootstrappable via the documented entry point. The user is then forced to discover `tier: "essential"` (or read the spill file manually) to make progress.

### 2. Data-level: the FA-iOS store accumulated entries that violate CLAUDE.md guidance

Snapshot of the failing store:

| Namespace | Entries | Notes |
|---|---|---|
| `files.*` | 30 | Most describe what each source file does — derivable from reading the file. |
| `context.*` | 30 | Some are real load-bearing gotchas; others appear to be scan residue. |
| `commands.*` | 3 | Fine. |
| `conventions.*` | 2 | Fine. |
| `project.*` | 1 | Fine. |
| `deps.*` | 1 | Fine. |

**67 entries, ~68KB, ~1KB average per entry.**

CLAUDE.md (project) is explicit: *"Do not store: things derivable from package.json, README, or the code itself."* The 30 `files.*` entries directly violate this. The high `context.*` count for a single ~10k-line iOS app is implausible without scan residue.

`codex_stats --period all --detailed` corroborates the misuse pattern:

```
Namespace activity:
  files                  9 reads  123 writes  last write: 0d ago
  context                0 reads   73 writes  last write: 0d ago
  arch                   0 reads   24 writes  last write: 3d ago
  conventions            0 reads    6 writes  last write: 5d ago
  commands               0 reads    6 writes  last write: 5d ago
```

**Across 16 sessions, `files.*`/`context.*`/`arch.*`/`conventions.*` were written 226 times and read 9 times.** They are functioning as a write-only journal, not a knowledge base. The bootstrap dump is the only reader.

## Tool-improvement candidates

Ordered by leverage:

1. **Bootstrap size budget with graceful degradation.** When the projected response would exceed a configured byte budget (default ~20KB to leave host headroom), shed lower-priority namespaces (`files.*` first, then `arch.*`) and emit a one-line notice naming what was elided and how to retrieve it (`codex_context tier:"full"` + explicit namespace, or `codex_get`).
2. **Write-time guardrail.** On `codex_set`, if the store crosses (e.g.) 80% of a target bootstrap size, emit a warning in the response. Prevents silent drift into "unbootstrappable" territory.
3. **Stale-entry report.** Surface entries written N+ times with 0 reads as a candidate-for-pruning list. Could be its own tool (`codex_stale`) or a section in `codex_stats --detailed`. Pairs naturally with the existing audit log.
4. **Project-resolution failure handling.** Today the `[project: NONE — auto-scope writes will fall through to global]` banner is informational only. Consider: refuse `codex_set` when project resolution failed unless `scope` is explicit, OR walk ancestors looking for `.codexcli/` and auto-pin. Current behavior risks misrouted writes during repo moves (relevant: FA-iOS is mid-relocation).
5. **Tier semantics in docs.** `essential` / `standard` / `full` are documented in the tool description but the *operational* meaning ("use essential when full overflows") is folklore. Worth surfacing in `schema-guide.md` or `dogfooding.md`.

## Data-hygiene findings (FA-iOS specific — record-only)

The FA-iOS store needs an audit pass independent of any tool change:

- 30 `files.*` entries — almost certainly all should go (CLAUDE.md prohibits them).
- 30 `context.*` entries — keep the load-bearing ones (e.g. `ios26_accent_color_regression`, `swiftlint_config_strategy`, `sourcekit_recovery`, `uikit_canimport_pattern`, `next_session`); audit the rest.
- The pending FA-iOS repo move (mentioned in `context.next_session`) is a natural inflection point to do this cleanup before re-pinning to the new repo's `.codexcli/`.

This is FA-iOS work, not Reverie work — but it's evidence for improvement #1 above and worth re-checking after any tool changes land.

## Reproduction

```bash
# In any host that caps tool results at ~25k tokens (e.g. Claude Code)
cd ~/Projects/github.com/seabearDEV/sandbox/font-awesome/font-awesome-ios
# Then in-session:
#   codex_context tier:"full"
# → overflow + spill-to-file
```

The exact spill file from the triggering session (preserved as evidence):

```
~/.claude/projects/-Users-kh-Projects-github-com-seabearDEV-sandbox-font-awesome-font-awesome-ios/8a5be618-5ce4-44b9-89f3-f7fed469fd3e/tool-results/mcp-reverie-codex_context-1777990844599.txt
```

## Resolution

All five issues filed from this investigation shipped in v1.14.0:

- **#99** — projectResolution chokepoint refuses auto-scope writes on null project resolution (PR #104, merge `d9126b4`). Closes the silent-fallthrough cause directly.
- **#100** — `codex_context` size-budget shedding with priority order and pathological-overflow notice (PR #108, merge `d18923f`). Defense in depth — even an overgrown store no longer triggers spill-file.
- **#101** — `codex_set` write-amp warning on 3rd+ same-key write per session within 30 min (PR #108). Addresses the second stacked cause (write amplification accelerating overflow growth).
- **#102** — MCP audit `project` field absolutized via `setProjectRootOverride` (PRs #106/#107, merge `001ac9e`). Fixes the audit-log forensics gap that complicated this investigation.
- **#103** — Tier semantics + size-budget interaction documented in `schema-guide.md` (PR #109).

See design docs: `design-99-project-resolution-refusal.md`, `design-100-context-size-budget.md`, `design-101-write-amp-guard.md`.
