# Design: write-amp guard on codex_set (#101)

**Issue:** [#101](https://github.com/seabearDEV/codexCLI/issues/101)
**Status:** design — not yet implemented
**Driving evidence:** `docs/dataset-2026-05-05-findings.md` §1b, `context.writeAmpPattern` codex entry
**Playbook:** mirrors the #91 / #99 / #100 design-first treatment
**Bundling:** ships in the same PR as #100 (theme E guardrails)

## Problem

Agents in undisciplined sessions use `files.*` (and to a lesser extent `context.*`, `arch.*`) as scratch space rather than durable seeds. Same key gets `codex_set` 4-7× per session with mostly-identical content and small deltas — pure noise from the store's perspective. The audit data:

| Key | Session | Rewrites |
|---|---|---|
| `files.font_awesome_content_view` | 4fc5ce9a | 7 |
| `files.icon_search_view` | 8b648fbf | 6 |
| `files.font_awesome_content_view` | 76b5638f | 6 |
| `files.icon_detail_view` | 8b648fbf | 5 |
| `files.fontawesome_swift` | 76b5638f | 5 |

This is the mechanism behind the `files.*` 123-writes-vs-9-reads imbalance. Disciplined stores (machine 02 `CAS_robot`) cap at 2× and have balanced read:write ratios — the pattern is **agent-discipline-specific**, not store-specific.

There's no signal back to the agent today. The store accepts the 7th write as readily as the 1st. Nudging on the 3rd write gives the agent a chance to ask "has this entry stabilized?" before continuing the iterate-and-store loop.

## Decisions locked (2026-05-05 design conversation)

| | Decision |
|---|---|
| **D1** | Warning fires on the **3rd write** of the same key within the same session AND within a **30-min sliding window**. Distinguishes the pattern (4-7× per session) from disciplined iterate-and-store (1-2×). |
| **D2** | Warn-only on trip, no hard refusal in v1.14. Hard-blocking would break legitimate iterate-and-store workflows. Telemetry measures whether the soft signal changes behavior; v1.15 revisits a stricter `--no-amp` mode if telemetry shows the warning is ignored. |
| **D3** | **MCP-only scope.** CLI invocations are per-process and have no multi-call session for the guard to attach to. Cross-process detection via audit-log reads is more complex than needed (`context.logQueryOnCost` flags audit-read cost as a perf concern). Document the CLI limitation; revisit if CLI users hit the pattern. |
| **D4** | **In-memory session counters** (per-MCP-server-process Map). Cleared on server restart. No on-disk persistence — write-amp is a within-session phenomenon, and the audit log already records the underlying writes for offline analysis. |
| **D5** | Triggering tool: **`codex_set` only.** `codex_rename` (key move, not value churn), `codex_alias_set` (alias plumbing), `codex_import` (bulk path) are all out of scope — none match the iterate-and-store pattern. |
| **D6** | Telemetry: `codex_set` audit/telemetry rows gain `writeAmpWarning: true` and `writeAmpCount: N` when the warning fired. Lets us measure post-deploy how often the trip happens, on which keys, and whether agents change behavior after seeing it. |

## Warning content

When the guard trips, the MCP `codex_set` response keeps its normal success body and gains a `warning` field:

```
warning: "this key has been written 3 times in this session (first write: 12m ago) — consider whether the entry has stabilized. See conventions.seedDensity for the seed-vs-scratch distinction."
```

Format goal: name the count, name the time-since-first-write, point at the relevant convention. Three pieces of information, one short sentence, no command suggestions (the agent already knows what to do — the guard is a nudge, not a fix-recipe).

## Algorithm

```
// Per-process state, MCP-server-scoped
sessionWrites: Map<sessionId, Map<key, timestamps[]>> = new Map()

const WINDOW_MS = 30 * 60 * 1000  // 30 minutes
const THRESHOLD = 3

function recordWrite(sessionId, key, now) -> { warning, count } | null:
  perSession = sessionWrites.get(sessionId) ?? new Map()
  timestamps = perSession.get(key) ?? []

  // Drop entries older than the sliding window.
  cutoff = now - WINDOW_MS
  timestamps = timestamps.filter(ts -> ts > cutoff)
  timestamps.push(now)

  perSession.set(key, timestamps)
  sessionWrites.set(sessionId, perSession)

  if timestamps.length >= THRESHOLD:
    firstWriteMs = now - timestamps[0]
    return { count: timestamps.length, firstWriteMs }

  return null
```

Memory: `O(active sessions × distinct keys per session × writes-in-window)`. For a typical MCP server with 1 active session and ~50 distinct keys touched, this is bounded — the 30-min trim caps timestamps[] at the rate of writes that fit in the window. Long-lived servers running for days don't accumulate state because old sessions stop writing and their counters age out (mechanism: when a sessionId stops appearing, its entry stays in the map forever — this is a memory leak in theory, but at typical session rates and key counts, the leak is bounded by the host's MCP-server lifetime in practice).

If long-lived MCP-server memory becomes a concern (>1MB of sessionWrites state observed), add an LRU eviction in a follow-up. Not v1.14 scope.

## Affected surfaces

| File | Function | Change |
|---|---|---|
| `src/utils/writeAmp.ts` (new) | `recordWrite(sessionId, key, now)` | Pure function: returns `{ count, firstWriteMs } \| null`. |
| `src/mcp-server.ts` | `codex_set` handler | After successful write, call `recordWrite`; if non-null, append `warning` line to response and set telemetry fields. |
| `src/utils/telemetry.ts` | `TelemetryExtras` | Add `writeAmpWarning?: boolean`, `writeAmpCount?: number` (alongside `#100`'s `degraded` / `shedNamespaces`). |
| `src/utils/audit.ts` | `AuditEntry` | Same two fields, optional. |

`writeAmp.ts` lives outside `mcp-server.ts` so it's testable in isolation and so `recordWrite` can be reset between tests (small `clearWriteAmpState()` helper for vitest).

## Edge cases

| Case | Behavior |
|---|---|
| 1st or 2nd write | No warning, no telemetry fields. |
| 3rd write within 30 min | Warning fires. `writeAmpCount: 3`. |
| 5th, 6th, 7th writes within 30 min | Warning fires every time. `writeAmpCount` reflects current count. |
| 4th write *outside* 30 min from 1st but inside from 2nd/3rd | Window slide drops the 1st; effective count is 3 (current + 2 prior in-window). Warning still fires. |
| Different sessions writing the same key | Each session has its own counter. No warning until that session itself trips ≥3. |
| `codex_set` with same key + same value (true no-op redundant write) | Still counts toward write-amp. The amplification is "this key keeps getting touched"; whether the value changed is captured separately by the existing `redundant` telemetry field. |
| `codex_rename` from `a` → `b` | Out of scope. The rename is a key move, not value churn. The new key `b` starts with a fresh counter (it's a different key). |
| `codex_set` while `tier:"essential"` codex_context is active | Unrelated — tier is a read concept, write-amp is a write concept. No interaction. |
| Server restart mid-session | Counter resets (in-memory). Subsequent writes start from 1. Acceptable: a fresh process has no memory of prior writes, and the audit log preserves the underlying signal. |
| Client doesn't pass / doesn't have a `sessionId` | Use the MCP server's own per-connection ID. Already tracked by `getSessionId()`. |
| `codex_set` errors before reaching `recordWrite` | No counter increment. Only successful writes count toward write-amp. |

## Telemetry

`codex_set` audit/telemetry rows gain (when guard fired):

```jsonl
{
  ...,
  "tool": "codex_set",
  "key": "files.font_awesome_content_view",
  "op": "write",
  "writeAmpWarning": true,
  "writeAmpCount": 3,
  "session": "4fc5ce9a"
}
```

Post-deploy questions this lets us answer:

- **Frequency.** What % of `codex_set` calls trip the warning? (numerator: rows with `writeAmpWarning: true`; denominator: all `codex_set` rows.)
- **Effectiveness.** After a warning fires on session S key K, does session S continue writing K? Telemetry can join `writeAmpWarning: true` rows back to subsequent writes of the same key+session and measure whether agents back off.
- **Key concentration.** Which keys most often trip the warning? Confirms the `files.*` hypothesis (or surfaces a different namespace as the worst offender).
- **Threshold validation.** Is 3 the right N? Look at the distribution of `writeAmpCount` in tripped rows — if most rows show count=3 and few escalate to 5+, the warning is working. If many rows show count=10+, the warning isn't moving behavior and v1.15 should consider the stricter mode.

## Out of scope

- **`--no-amp` strict mode** that converts warning into refusal. v1.15 candidate, conditional on telemetry showing the soft warning is ineffective.
- **Content-diffing** to detect "actually identical" rewrites. The existing `redundant` field already captures value-equality on writes; combining it with `writeAmpWarning` post-hoc is enough analysis. Not needed at write time.
- **CLI write-amp detection** via audit-log reads. Different surface, different problem; revisit only if CLI users start hitting the pattern.
- **Auto-rejecting** rewrites where new content ≈ old content. Out of scope at this layer; that's an editor problem, not a guard problem.
- **Cross-MCP-server-process state** (e.g. file-backed counters surviving restart). Not needed: the audit log preserves the signal for offline analysis, and the within-session pattern is what matters for the live nudge.
- **Backfill** of historical telemetry. Forward-only; new fields appear on rows from this version onward.

## Test plan

Unit tests on `recordWrite` (pure function):

- 1×, 2× rewrites in same session+window → returns null both times.
- 3× rewrites in same session+window → returns `{ count: 3, firstWriteMs: <small> }` on the 3rd.
- 5× rewrites in same session+window → returns non-null on writes 3, 4, 5 with increasing count.
- 3× rewrites where the 1st is outside the 30-min window → returns null on the 3rd (effective count is 2 after window slide).
- Same key, two different sessions, 2 writes each → no warning either session.
- Same key, two different sessions, 3 writes in session A → A trips, B unaffected.
- Same session, two different keys, 2 writes each → no warning.

Integration tests on `codex_set` MCP handler:

- 1st `codex_set` to `test.key` → response has no `warning` field; audit row has no `writeAmpWarning`.
- 3rd `codex_set` to `test.key` in same session → response has `warning` line containing the count and time-since-first-write; audit row has `writeAmpWarning: true`, `writeAmpCount: 3`.
- 3rd `codex_set` to `test.key` from a fresh session → no warning (different session counter).
- 3rd `codex_rename` of `test.key` → no warning (rename is out of scope).

Manual verification:
- Reproduce a 5-rewrite sequence on a development store. Inspect the response on writes 3-5 to confirm the warning text reads cleanly and points at `conventions.seedDensity`.

## Implementation sequencing (combined #100 + #101 PR)

These ship in one PR because they share the telemetry/audit field extension surface, both belong to theme E (guardrails), and reviewing them together gives the user the full v1.14 guardrail story in one diff.

1. **Schema + config.** `bootstrap.maxResponseBytes` config knob (#100). No config for #101 (in-memory only).
2. **Pure functions.** `(entries, budget, tier) → { kept, shedSummary }` (#100); `recordWrite(sessionId, key, now) → result` (#101). Both testable in isolation, no MCP/CLI plumbing required.
3. **Telemetry/audit field additions.** Both `degraded`/`shedNamespaces` and `writeAmpWarning`/`writeAmpCount` land in one schema commit so `TelemetryExtras` and `AuditEntry` change once.
4. **Wire #100** into `codex_context` MCP handler + `ccli context` CLI command. Notice rendering, telemetry capture.
5. **Wire #101** into `codex_set` MCP handler. Warning rendering, telemetry capture.
6. **Tests** for both, mirroring the test plans above.
7. **CHANGELOG** with two entries under `### Added` (or `### Changed` for #100 if degraded responses count as a behavior change for `tier: "standard"`/`"essential"`).
8. **LLM_INSTRUCTIONS** update — point at both new behaviors so agents understand the warning surface and the trimmed-payload notice. (Mirrors what #99 did for refusal.)

After this lands, **#103** (tier semantics docs) becomes unblocked — both #100's budget contract and the unchanged `tier: "full"` semantics are documented, and the docs can describe the relationship between tiers, the budget knob, and the write-amp warning.
