# Design: codex_context size budget with graceful tier degradation (#100)

**Issue:** [#100](https://github.com/seabearDEV/codexCLI/issues/100)
**Status:** SHIPPED 2026-05-05 via [PR #108](https://github.com/seabearDEV/codexCLI/pull/108) (merge `d18923f`)
**Driving evidence:** `docs/investigation-bootstrap-overflow-2026-05-05.md` §1, `docs/dataset-2026-05-05-findings.md` §3
**Playbook:** mirrors the #91 / #99 design-first treatment

## Problem

`codex_context` materializes every entry in the resolved scope into a single response. Hosts (Claude Code, Claude Desktop) cap a single tool result around ~25k tokens (≈68KB at the 2.7 bytes/token rate observed for technical text). Once the projected response exceeds the cap, the host falls back to writing the response to a spill file, breaking the documented bootstrap entry point — agents that learned `codex_context → read entries inline` instead get an opaque file reference and have to context-shift into reading it.

This is **not** a data-hygiene problem confined to undisciplined stores. The 2026-05-05 audit shows machine 02's `CAS_robot` store (well-tended, balanced read:write, no resolution failures) hit `tier: full` = 89 entries / 26K bytes on session `6d163125`, then degraded to `tier: essential` for all five subsequent calls in that session. Same failure curve as FA-iOS, just earlier on the growth curve. Any store that accumulates entries over time will eventually hit it.

Today the only escape is the agent inferring (from spill-file behavior) that `tier: "essential"` exists and switching to it. That folklore is unreliable, scope-blind (essential drops everything in `arch.*` regardless of size), and doesn't fix the root cause: oversized payloads.

## Decisions locked (2026-05-05 design conversation)

| | Decision |
|---|---|
| **D1** | Default `bootstrap.maxResponseBytes = 50 * 1024` (~50KB, ≈18.5k tokens, ~75% of host cap). Leaves headroom for the next_session banner, instruction block, and agent prompt overhead. |
| **D2** | Shed order is an explicit priority list, not naive prefix sort: `files.*` → `arch.*` → large `context.*` (largest-first, never `context.next_session`). Never-shed: `project.*`, `conventions.*`, `commands.*`, `deps.*`. |
| **D3** | Hard-cut on overflow + inline notice naming what was shed. Warn-only would let the spill-file failure mode persist. `tier: "full"` opts out of degradation entirely. |
| **D4** | Configuration: single knob `bootstrap.maxResponseBytes` in `config.json`. `CODEX_BOOTSTRAP_MAX_BYTES` env override for tests. No CLI flag — this is a per-environment cap, not a per-call choice. |
| **D5** | Telemetry: `codex_context` audit/telemetry rows gain `degraded: true` and `shedNamespaces: ["files.*", "arch.*"]` when shedding fired. Lets us measure post-deploy whether 50KB is the right threshold and whether shed order matches what stores actually carry. |

## Shed algorithm

```
budget = config.bootstrap.maxResponseBytes ?? 50 * 1024
if tier === "full" or projected_size <= budget:
  return full payload, no shedding

shed_in_order = [
  ("files.*",        all entries matching files.*),
  ("arch.*",         all entries matching arch.* — already gated by standard tier),
  ("context.large",  context.* entries sorted by byte size descending,
                     EXCLUDING context.next_session),
]

shed_summary = []
for (label, candidates) in shed_in_order:
  while projected_size > budget and candidates not empty:
    entry = candidates.pop()
    payload.remove(entry)
    shed_summary.add(entry)
  if projected_size <= budget:
    break

if projected_size > budget:
  // Pathological case: even after shedding all sheddables, still over budget.
  // Means project.*/conventions.*/commands.*/deps.* alone exceed 50KB.
  // Surface explicitly rather than silently truncating a never-shed namespace.
  emit warning: "codex_context payload exceeds budget after shedding all
                 sheddable namespaces. Increase bootstrap.maxResponseBytes
                 or audit project.*/conventions.* for over-long entries."
  // Still return the post-shed payload — better than a spill file.

prepend notice: "[trimmed: files.* (12 entries, 8.2K), arch.* (5 entries,
                 2.1K) — fetch via codex_get <key> or codex_context tier:\"full\"]"
return shed payload
```

Notice format goal: the agent can read the notice and know (a) what was dropped, (b) the size impact, (c) two recovery actions. The two-action format mirrors `#99`'s recovery-actions-named-explicitly approach.

## Affected surfaces

### Code paths

| File | Function | Change |
|---|---|---|
| `src/commands/context.ts` (or wherever `formatContext` lives) | `formatContextForBootstrap` | Inject shed step between entry collection and rendering |
| `src/mcp-server.ts` | `codex_context` handler | Pass through `tier`, capture shed result for telemetry |
| `src/config.ts` | config schema | Add `bootstrap.maxResponseBytes: number` (optional, default 50KB) |
| `src/utils/telemetry.ts` | `TelemetryExtras` | Add `degraded?: boolean`, `shedNamespaces?: string[]` |
| `src/utils/audit.ts` | `AuditEntry` | Add same two fields, optional |

(Exact file/function names to be confirmed during implementation — `codex_get` with `files.*` for the targets.)

### CLI vs MCP behavior

Both surfaces apply the same shed algorithm. The CLI's `ccli context` command honors the same budget — agents that pipe the CLI output into a model via tools (`gh copilot`, the OpenAI Codex CLI, etc.) hit the same host caps. No CLI-only escape hatch.

`tier: "full"` honors user intent on both surfaces — it skips degradation entirely. If a `tier: "full"` payload exceeds the host cap, that is the user's choice and the spill file is the appropriate failure mode (the user explicitly opted in).

## Edge cases

| Case | Behavior |
|---|---|
| Empty store | No shedding, identical to today. |
| Store at exactly budget | No shedding. |
| Store at 1.001× budget, smallest sheddable namespace is `arch.*` (5KB) | Sheds all of `arch.*`, payload now well under budget. Notice lists `arch.*`. |
| Store at 3× budget, `files.*` alone is 100KB | Sheds all of `files.*`. If still over, sheds `arch.*`. If still over, sheds large `context.*` largest-first. Notice lists each shed namespace. |
| `tier: "essential"` already small enough | No shedding (essential excludes `files.*`, `arch.*`, large `context.*` already). |
| `context.next_session` is large (>10KB) | Never shed. Cross-session handoff is critical and the user owns its size. If this becomes a problem, file separately — not a v1.14 concern. |
| `bootstrap.maxResponseBytes` set to 0 or negative in config | Treat as "default" — log a config warning at load, don't crash. |
| `bootstrap.maxResponseBytes` set absurdly low (e.g. 1KB) | Sheds everything sheddable. Pathological-case warning fires. Behavior is correct; user gets what they asked for. |
| `CODEX_BOOTSTRAP_MAX_BYTES` env override | Wins over config file value. Test/integration use case. |

## Telemetry

`codex_context` audit/telemetry rows gain (when shedding fired):

```jsonl
{
  ...,
  "tool": "codex_context",
  "tier": "standard",
  "degraded": true,
  "shedNamespaces": ["files.*", "arch.*"],
  "responseSize": 47821
}
```

Post-deploy questions this lets us answer:
- How often does shedding fire? (denominator: all `codex_context` calls; numerator: rows with `degraded: true`)
- Which stores hit it most? (group by `project`)
- Is the default 50KB threshold right? (look at `responseSize` distribution on rows that almost-but-didn't trigger)
- Does the shed order match what stores actually carry? (cross-reference `shedNamespaces` against entry-count breakdowns)

If the v1.15 dataset shows shedding firing on >5% of `codex_context` calls in healthy stores, the threshold is too tight and we revise the default. If <0.5%, possibly too loose.

## Out of scope

- **Pagination / cursor.** A separate issue if size-budget shedding proves insufficient. v1.14 ships the simpler approach first.
- **Smart entry-level shedding inside a namespace** (e.g. drop the 7 largest `files.*` keeping the rest). The bytes-per-namespace heuristic is good enough; per-entry within a namespace adds complexity for marginal gain.
- **Write-time guardrail** (`#101`). Different surface, separate issue.
- **Tier auto-promotion** (e.g. `tier: "standard"` automatically downgrades to `essential` when over budget). Considered and rejected — shed-by-priority preserves more useful content than tier downgrade. `essential` excludes things shed-by-priority would keep (e.g. small `arch.*` entries below the shed budget).
- **Backfill of historical telemetry rows.** Forward-only; the new fields appear on rows from this version onward.

## Test plan

Unit tests with synthetic stores:

- **0.5× budget** (small store) → identical output to today, no `degraded` field.
- **1.0× budget** (exactly at) → no shedding, no `degraded` field.
- **1.5× budget** → sheds `files.*` first (assuming `files.*` is sized to push it under), notice lists `files.*` only with byte count, `degraded: true`.
- **3× budget** → sheds `files.*`, `arch.*`, and largest `context.*` until under; notice lists all three with byte counts.
- **3× budget but `files.*` alone is 5× budget** → sheds all of `files.*` and stops (notice lists only `files.*`).
- **Pathological: never-shed namespaces alone exceed budget** → emits the warning, returns post-shed payload anyway.
- **`tier: "full"` at 3× budget** → no shedding, full payload, no `degraded` field.
- **`context.next_session` of 20KB at 1.5× budget** → preserved; other `context.*` shed largest-first instead.
- **Config absent** → uses 50KB default.
- **`CODEX_BOOTSTRAP_MAX_BYTES` env set** → overrides config.

Manual verification:
- Reproduce the FA-iOS bootstrap-overflow scenario in a synthetic store. Default-tier `codex_context` produces a payload under 50KB with the shed notice, no spill file triggered.

## Implementation sequencing

1. Schema + config plumbing (`bootstrap.maxResponseBytes`, env override).
2. Shed algorithm in isolation (pure function: `(entries, budget, tier) → { kept, shed_summary }`).
3. Wire into both `codex_context` MCP handler and `ccli context` CLI command.
4. Telemetry/audit field additions.
5. Tests for all rows in the test plan above.
6. CHANGELOG entry under `### Added` (or `### Changed` if it counts as behavior change for `tier: "standard"` / `"essential"`).
7. Single PR, mirrors the #99 / #91 bundling pattern.

After this lands, **#103** (tier semantics docs) becomes unblocked — `tier: "full"` semantics are now locked, the budget contract is documented, and the docs can describe the relationship between tiers and the new `bootstrap.maxResponseBytes` knob.
