# Dataset findings: v1.13.0 soak audit (2026-05-05)

**Companion to:** `docs/investigation-bootstrap-overflow-2026-05-05.md`
**Window:** 2026-04-23 → 2026-05-05 (~12 days into Phase 1 soak)
**Sources:** audit.jsonl, telemetry.jsonl, miss-paths.jsonl from two machines

This doc records the numbers behind the v1.14.0 theme pick. The investigation doc named the symptoms; this names the mechanisms.

## Sample

| | Machine 01 (personal) | Machine 02 (work) |
|---|---|---|
| User | `kh`, seabearDEV repos incl. FA-iOS | `kh734385`, broadcom repos (CAS_robot, TIS_monitoring) |
| Audit window | 8 days | 7 days |
| Sessions | 21 | 5 |
| Audit rows | 302 | 72 |
| Write:read ratio | 240:58 (~4:1) | 37:33 (~1:1) |

## Key findings

### 1. Bootstrap overflow has two stacked causes, not one

The investigation framed the FA-iOS overflow as data-hygiene drift. The audit shows it's two compounding mechanisms:

**a. Project resolution silently failed.** Five m01 sessions logged `project: null` while writing FA-iOS-shaped keys (`context.uikit_canimport_pattern`, `files.icon_detail_view`, `arch.swift_dual_layout`, `deps.seabearkit`). With `scope: auto + project: null`, those writes fell through to the *global* store. The "FA-iOS store" the investigation calls overgrown is actually the user's global store accumulating FA-iOS content because resolution kept missing. The `[project: NONE — auto-scope writes will fall through to global]` banner was visible every time and never acted on.

**b. Write-amplification inflated byte count.** Same key rewritten 4–7× per session in undisciplined stores. Worst on m01:

| Key | Session | Rewrites |
|---|---|---|
| `files.font_awesome_content_view` | 4fc5ce9a | 7 |
| `files.icon_search_view` | 8b648fbf | 6 |
| `files.font_awesome_content_view` | 76b5638f | 6 |
| `files.icon_detail_view` | 8b648fbf | 5 |
| `files.fontawesome_swift` | 76b5638f | 5 |

This is the mechanism behind the 226-writes-vs-9-reads imbalance the investigation flagged. Agents are using `files.*` as session scratch, not durable seeds.

### 2. The store grew monotonically through the soak window

FA-iOS default-tier bootstrap timeline (m01):

| Date | Session | Entries | Bytes |
|---|---|---|---|
| 2026-04-29 | 76b5638f | 35 | 16,228 |
| 2026-04-30 | 4fc5ce9a | 46 | 28,574 |
| 2026-05-01 | e5b89393 | 56 | 48,472 |
| 2026-05-03 | 8b648fbf | 62 | 56,492 |
| 2026-05-04 | b0a40bbd | 63 | 60,927 |
| 2026-05-04 | 8079a025 | 66 | 65,463 |
| 2026-05-05 | 13cb2519 | 67 | 68,114 ← overflow + spill |

~4 entries/day, ~6KB/day. Linear, no pruning. The 2026-05-04 / 2026-05-05 sessions all degraded the same way: default-tier overflow → essential-tier retry. Three days of pain before the investigation was filed.

### 3. The bootstrap-overflow problem is not FA-iOS-specific

Machine 02's CAS_robot store is well-tended (write-amp capped at 2×, project resolution always succeeds, balanced read:write ratio). It still hit the cap edge: full-tier returned 89 entries / 26K bytes on session `6d163125`, after which the agent fell back to essential-tier for all five subsequent calls in the session. Same failure curve, earlier on it.

This means the size-budget improvement (investigation #1) is not optional; it's the difference between graceful degradation and `Output has been saved to <tool-results>/...txt` for any sufficiently populated store.

### 4. Miss-paths feedback loop is broken

54 miss events across both machines. Resolution mix:

- **35 moved_on** — agent gave up quickly (probably found via grep/file read)
- **17 timeout** — session ended without resolving the miss
- **2 writeback** — agent stored what they had to find the hard way

Writeback rate: **3.7%**. The miss-paths feature is supposed to surface "you should have stored this" moments. Below ~5KB exploration cost the writeback rate is effectively 0%; the only writeback over the whole window followed an 18-tool-call / 51KB exploration. Cost has to be very high before the loop closes.

Miss query shapes:
- 22 literal-key (agent inferred a plausible key, wasn't there) — most actionable
- 17 wildcard (`codex_get` with no key, store empty/sparse on the queried scope)
- 15 freetext/regex (`codex_find` queries like `"42/149"`, `"117 top"`, `"28%"` — agents searching by remembered fragments of values)

The freetext misses are interesting: m02's session `6d163125` searched for numeric value-fragments six times in a row, all moved_on. Agent stored a metric value and forgot the key.

### 5. Audit `project` field is unreliable for rollups

234 of 302 m01 audit rows logged `project: "."` (relative cwd literal) instead of the resolved absolute path. CLI rows logged the absolute path correctly; MCP rows logged `.`. This breaks per-project aggregation in `codex_stats` without joining on session→cwd. Small bug, low-severity, but worth fixing because the next dataset analysis will hit the same wall.

## Implications for v1.14.0 theme

These findings make a strong case for a fifth theme candidate beyond the four in `project.v114Plan`:

> **E. Guardrails / data hygiene** — anchored on project-resolution refusal, with bootstrap size budget + write-amp guard as supporting issues.

Argument for promoting E to the chosen theme:
- The data is unambiguous; #1 above is happening in production right now
- Each component is small enough to ship in one cycle
- Pairs naturally with #84 (entry health) which is already in the milestone
- Higher leverage than themes A/B/C/D given the actual usage patterns the soak revealed

Argument against:
- The soak is only 12/21 days in; more data could shift the picture
- Could pull soak forward and lose the validation window for v1.13.0's own promises (#92 empty-codex_get rate, #91 next_session adoption, etc.)

Decision: relax soak-only discipline given the strength of the evidence. File issues now, begin design conversations on the resolution-refusal change in parallel with the remaining soak window.

## Related issues filed (2026-05-05)

- **#99** — guardrail: refuse `codex_set` when project resolution fails *(highest leverage; root-cause fix)*
- **#100** — guardrail: `codex_context` size budget with graceful tier degradation
- **#101** — guardrail: detect same-key `codex_set` rewritten N+ times in one session
- **#102** — bug: MCP audit logs `project` as `.` instead of resolved cwd *(small, forward-looking)*
- **#103** — docs: surface tier semantics and overflow fallback path

All milestoned to v1.14.0 as candidates for the **E. Guardrails / data hygiene** theme. Phase 2 theme pick (~2026-05-14) decides anchor + final scope.

## Source files

Raw audit/telemetry/miss-paths preserved locally at `~/Projects/liminal/codexCLI_review/`. Not checked in — the derived counts above are what later sessions need.

## Resolution

All five issues filed from these findings shipped in v1.14.0 (theme E):

- **#99** project-resolution refusal — PR #104 (`d9126b4`)
- **#100** size-budget shedding — PR #108 (`d18923f`)
- **#101** write-amp guard — PR #108 (`d18923f`)
- **#102** audit `project=.` bug — PRs #106/#107 (`001ac9e`)
- **#103** tier semantics docs — PR #109

The miss-paths writeback rate (3.7%) and write-amp pattern (4-7× same-key rewrites on `files.*`) are the calibration anchor for whether the v1.15 dataset shows the guardrails moved behavior.
