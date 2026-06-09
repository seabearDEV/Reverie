# Design: CLI as a first-class agent target (MCP-equivalent, without MCP)

**Issue:** [#117](https://github.com/seabearDEV/reverie/issues/117) (umbrella, milestone v1.1.0)
**Status:** **COMPLETE** — WS1 + WS2 IMPLEMENTED 2026-06-08 (v1.1.0/v1.1.1) · WS3 IMPLEMENTED 2026-06-09 (v1.2.0, [#119](https://github.com/seabearDEV/reverie/issues/119)/PR #129) · design PROPOSED 2026-05-27

> **Implementation note (2026-06-09, WS3).** Shipped per D8 in v1.2.0:
> `RVR_SESSION` adopts a shared session id (sanitized — it names the state
> file), with per-session state at `~/.reverie/store/sessions/<id>.json`
> (atomic + lock-guarded read-modify-write, 24h TTL prune, corrupt files
> degrade to empty). Write-amp warnings land in the envelope's `warnings[]`
> as `{code:"WRITE_AMP", message, count}` (stderr in human mode) with the
> same window math as MCP (shared `pruneAndRecord`, not a re-implementation);
> miss-path windows persist across invocations; `confirm set`/`remove` were
> the last `aliasResolved`-dropping callsites, fixed. Two-step confirm tokens
> stayed out per D9 — the stateless `REQUIRES_CONFIRMATION` envelope is the
> CLI contract. Code: `src/utils/session.ts`, `src/utils/sessionState.ts`,
> `src/utils/instrumentation.ts`.

> **Implementation note (2026-06-08).** WS1 and WS2 shipped per this design.
> The envelope contract is exactly as specified here: `reverie:"1"` (string
> schema version), MCP-parity `error.code` names with **no `E_` prefix**
> (`PROJECT_UNRESOLVED`, `NOT_FOUND`, `INVALID_INPUT`, `REQUIRES_CONFIRMATION`,
> `ENCRYPTED_NO_PASSWORD`, `DECRYPT_FAILED`, `COMMAND_FAILED`, `INPUT_REQUIRED`,
> `IO`, `RUNTIME`), `warnings[]` as `{code,message}` objects, and the confirm
> preview in `error.preview` (D9). Code: `src/utils/output.ts` (envelope +
> frozen `ERROR_CODES`), `src/commands/manifest.ts` (D7), surface-aware
> `getEffectiveInstructions('cli'|'mcp')` (D5), AGENTS.md from `init` (D6).
> **WS3 was moved back out of scope**: issue #117 supersedes D8 and re-gates the
> session-state / write-amp / `aliasResolved` parity work on telemetry signal
> rather than the first v1.1.0 cut. The D8 rationale below is retained as the
> argument for picking it up when that signal arrives. (This doc absorbed a
> second, leaner design draft written during implementation; it is the single
> canonical design for #117.)

**Driving constraint:** Real deployment blocker — at least one user's employer prohibits MCP servers entirely. For those users the CLI is not a convenience surface, it is the *only* way an AI agent can touch Reverie. This moves CLI/agent parity from "polish" to "table stakes for a whole class of users."
**Goal alignment:** `project.goals` #4 (agent-agnostic — Claude/Copilot/Gemini/Cursor) and #1 (token efficiency). The MCP ban makes #4 concrete: the on-ramp can't assume MCP.

## Problem

"100% CLI parity with MCP" is, read literally, already done: all 19 MCP tools have a CLI command (`reverie_set`→`set`, `reverie_context`→`context`, … — see the parity matrix in the investigation notes). Functional capability is not the gap.

What MCP gives an *agent* that the CLI does not is three **protocol affordances**, not tools:

1. **Structured I/O.** MCP returns structured payloads on every call. The CLI returns human-formatted, color-coded text for every *mutation* (`set`, `remove`, `copy`, `rename`, `alias *`, `confirm *`, `run`). Only the read commands (`get`, `find`, `context`, `stale`, `lint`, `topology`, `stats`, `audit`) have `--json`, and even those emit *bare* JSON with no stable envelope. An agent driving mutations has to scrape `"Set arch.foo ✓"` strings that change whenever we touch wording.

2. **The handshake.** On connect, an MCP client is *handed* the tool list, every input schema, and the instructions block — before it does anything. A CLI-only agent gets none of this. Worse: the instructions it *can* fetch (`rvr config llm-instructions`) are written for MCP — they say "you are connected via MCP," "call `reverie_context`," "PREFER MCP TOOLS." A CLI agent following them is told to use tools it cannot reach.

3. **Session statefulness.** The MCP server is one long-lived process, so it holds session state: the write-amp 30-min sliding window (#101), `reverie_run`'s single-use confirm tokens, and miss-path windows. The CLI is one process per invocation with no session to attach any of that to. The guardrails and the telemetry signals they emit (`writeAmpWarning`, miss-path exploration cost, `aliasResolved`) are therefore MCP-only today.

Close these three and the CLI becomes an agent target as good as MCP. Leave them and a corporate-MCP-banned user gets a degraded, string-scraping, mis-instructed experience.

## Decisions to lock

| | Decision | Status |
|---|---|---|
| **D1** | Structured output is opt-in via **both** a global `--json` flag (per-call, mirrors existing `--debug` root option) and an `RVR_OUTPUT=json` env var (session-wide, the agent sets it once). Env is the agent-ergonomic path; flag is the override. | proposed |
| **D2** | In JSON mode, **stdout carries exactly one envelope document and nothing else** — no colors, no decorative lines, no progress text. Human/diagnostic output (debug, prompts) goes to stderr. This is non-negotiable for parseability. | proposed |
| **D3** | One **stable, versioned envelope** for every command (read and write). Existing bare-JSON read output moves *inside* the envelope's `result` field. This is a deliberate, documented break of the current `--json` shape — taken now, while adoption is narrow, to buy a contract agents can rely on. | **LOCKED 2026-05-27** (break accepted) |
| **D4** | Errors in JSON mode are returned **as the envelope** (`ok:false`, `error:{code,message}`) on **stdout**, with a non-zero exit code. Agents get structured failures, not stderr text they'd have to parse. Mirrors MCP's `PROJECT_UNRESOLVED` structured error. | proposed |
| **D5** | LLM instructions become **surface-aware**: `getEffectiveInstructions(surface: 'mcp' \| 'cli')`. The CLI variant references `rvr context` / `rvr get` / `rvr set`, drops "PREFER MCP TOOLS," and keeps the unsupported-hand-edit and seed-density guidance. MCP variant unchanged. | proposed |
| **D6** | `rvr init` also writes an **`AGENTS.md`** (the emerging cross-agent convention) describing the CLI-driven workflow, so non-Claude agents discover Reverie without MCP and without `CLAUDE.md`. `CLAUDE.md` stays Claude-specific and may point at `AGENTS.md`. | proposed |
| **D7** | A machine-readable **command manifest** (`rvr manifest --json`, or always-JSON `rvr manifest`) emits the full command/flag tree + the MCP-tool↔CLI-command mapping — the CLI analog of MCP `tools/list`. Generated from the Commander tree, not hand-maintained. | proposed (lower priority) |
| **D8** | Session-scoped guardrails are bridged via **`RVR_SESSION`**: when set, CLI invocations share one session id (instead of per-process) and persist the write-amp window + miss-path state to `~/.reverie/store/sessions/<id>.json` (TTL-pruned). **In scope for v1.1.0** — the MCP-banned cohort *is* the usage signal the gate was waiting for; ships as the last PR, after WS1/WS2. | LOCKED 2026-05-27 (in scope) |
| **D9** | The two-step confirm-**token** flow is **not** ported (it's MCP-protocol-shaped; the host owns the permission gate). Instead, in JSON mode a `run` on a `--confirm` entry *without* `--yes` returns `ok:false, error.code:"REQUIRES_CONFIRMATION"` plus the command preview, exit non-zero — never blocks on stdin. The agent shows the preview, the host approves, the agent re-runs with `--yes`. Confirm *semantics* survive without the stateful token. | proposed |

## Workstreams

Three independently shippable pieces sharing one design. Ship in order; each stands alone.

### WS1 — Universal structured output (highest leverage, ship first)

The envelope (version pinned by `reverie`):

```jsonc
{
  "reverie": "1",            // envelope schema version — bump only on breaking change
  "ok": true,                // false on any failure
  "command": "set",          // canonical command name (not the alias used)
  "result": { ... },         // command-specific payload; for reads, what bare --json emits today
  "warnings": [              // non-fatal nudges, parity with MCP guardrail lines
    { "code": "WRITE_AMP", "message": "...", "count": 3 }
  ],
  "error": null              // on failure: { "code": "REQUIRES_CONFIRMATION", "message": "...", "preview": "..." }
}
```

- `error.code` values reuse existing MCP codes where they exist (`PROJECT_UNRESOLVED`) and add CLI-relevant ones (`REQUIRES_CONFIRMATION`, `NOT_FOUND`, `ENCRYPTED_NO_PASSWORD`, …). Enumerate and freeze the set in the schema-guide.
- `warnings[]` is where the write-amp nudge and the context `[trimmed: …]` notice land in structured form — so a JSON-mode agent gets the same signals an MCP agent gets inline.
- Every command gets coverage, including the mutations that have none today. `info` and `init` included; `mcp-server` excluded (it *is* the server).

Reuse the existing `-j/--json` short — do **not** invent new short flags (respects the pending holistic short-flag audit, `context.shortFlagAudit`).

### WS2 — Agent bootstrap / discovery surface

The CLI analog of the MCP handshake, in three parts:

1. **Surface-aware instructions (D5).** Fix the MCP-only text. A CLI agent that runs `rvr config llm-instructions` (or the manifest) must get instructions that name CLI commands and don't tell it to use MCP. This is the single most important correctness fix in the doc — the current text actively misdirects the exact users this feature targets.
2. **`AGENTS.md` from `init` (D6).** The "how does a CLI agent even learn Reverie exists" answer. Documents: bootstrap with `rvr context --json`, write back with `rvr set`, the seed-density principle, the unsupported-hand-edit rule. Agent-agnostic wording.
3. **Command manifest (D7).** `rvr manifest --json` → the full command tree (names, aliases, flags + descriptions, arg arity) plus the MCP↔CLI mapping. One read gives an agent the whole surface, structured — parity with `tools/list`.

### WS3 — Session-state & observability parity (in scope for v1.1.0, ships last)

Makes CLI-agent usage *measurable and guard-railed*, closing the telemetry blind spot. Without this, the dogfooding/`soakPolicy` loop under-counts every MCP-banned user — and those are now a known, named cohort, which is exactly why this is in scope rather than deferred: the signal the original gate waited for already exists.

- **`RVR_SESSION` (D8):** shared session id across invocations; on-disk per-session state file (TTL-pruned).
- **Write-amp guard on CLI `set`:** read/update the session file's per-key write timestamps; emit the same `WRITE_AMP` warning + `writeAmpWarning`/`writeAmpCount` telemetry as MCP.
- **Miss-path tracking on CLI reads:** persist the miss window to the session file; feed the same exploration-cost calibration.
- **`aliasResolved` capture:** fix the CLI callsites that drop `rawKey` on pre-resolve (`context.aliasResolvedCapture`) so CLI audit records alias→canonical like MCP.

## Affected surfaces

| File | Change | WS |
|---|---|---|
| `src/index.ts` | Global `--json` root option (beside `--debug`); thread `RVR_OUTPUT` env; per-command envelope wiring | WS1 |
| `src/utils/output.ts` (new) | `emitJson(envelope)` / `emitResult(command, result, warnings)` / `emitError(command, code, message, extra)` — single chokepoint; suppresses color/decoration in JSON mode | WS1 |
| `src/commands/*.ts` | Each command routes its result through the output helper instead of `console.log`-ing formatted text | WS1 |
| `src/commands/entries.ts`, `search.ts`, `context.ts`, `lint.ts`, `audit.ts`, `data-management.ts` | Existing bare-`--json` output moves inside `result` (D3 break) | WS1 |
| `src/llm-instructions.ts` | `DEFAULT_LLM_INSTRUCTIONS_CLI` variant; `getEffectiveInstructions(surface)` param | WS2 |
| `src/mcp-server.ts` | Pass `surface:'mcp'` to `getEffectiveInstructions` (no behavior change) | WS2 |
| `src/commands/claude-md.ts` (+ new `agents-md.ts`) | Emit `AGENTS.md` in `init` | WS2 |
| `src/commands/manifest.ts` (new) | Walk Commander tree → JSON manifest + MCP↔CLI map | WS2 |
| `src/utils/session.ts` | Honor `RVR_SESSION` when present | WS3 |
| `src/utils/sessionState.ts` (new) | On-disk per-session write-amp + miss-path state, TTL prune | WS3 |
| `src/utils/instrumentation.ts` | Wire write-amp/miss-path/`aliasResolved` for CLI parity | WS3 |
| `docs/schema-guide.md` | Document the envelope, the frozen `error.code` set, the manifest shape | WS1/WS2 |

## Out of scope

- **Two-step confirm tokens** (D9 — replaced by the stateless `REQUIRES_CONFIRMATION` envelope).
- **Interactive TUI / fzf** (#13) — orthogonal.
- **Porting MCP's long-lived in-memory caches** (audit tail cache, dir-mtime skip) to the CLI — those are server-lifetime optimizations; a per-invocation CLI doesn't benefit and shouldn't carry the complexity.
- **Backfill** of historical telemetry — forward-only, as with #100/#101.

## Edge cases

| Case | Behavior |
|---|---|
| `--json` *and* `--plain`/`--tree` together | `--json` wins; document precedence. |
| `RVR_OUTPUT=json` env + a command with no `--json` today (e.g. `set`) | Emits envelope (that's the whole point). |
| JSON-mode command that prompts (e.g. `set --prompt`, decrypt password) | Prompt to **stderr**; stdout stays a single clean envelope. If no TTY, fail with `ok:false, error.code:"INPUT_REQUIRED"` rather than hang. |
| `run --confirm` entry, JSON mode, no `--yes` | `ok:false, REQUIRES_CONFIRMATION`, preview in `error.preview`, non-zero exit (D9). |
| `run --confirm` entry, JSON mode, `--yes` | Executes; `result` carries captured output if `--capture`. |
| Command fails mid-run (`run` non-zero exit) | `ok:false`, `error.code:"COMMAND_FAILED"`, `result.exitCode`, captured stderr — never lose the child's exit info. |
| `RVR_SESSION` unset (WS3) | Falls back to per-process session id — today's behavior, no guard persistence. |
| `RVR_SESSION` set but state file corrupt | Treat as empty session, log a debug warning, never crash a `set`. |

## Test plan

WS1:
- Every command in JSON mode emits a single valid JSON document, schema-validated against the envelope, nothing else on stdout.
- Mutations (`set`/`remove`/`copy`/`rename`/`alias`/`confirm`) populate `result` meaningfully.
- Errors produce `ok:false` envelope on stdout + non-zero exit (project-unresolved, not-found, encrypted-no-password).
- `RVR_OUTPUT=json` env produces identical output to `--json` flag.
- Write-amp/`[trimmed]` notices appear in `warnings[]` (MCP parity), not as loose text.

WS2:
- `rvr config llm-instructions` (CLI surface) contains zero "MCP" tool references and names CLI commands.
- MCP server instructions unchanged (snapshot test).
- `rvr init` writes `AGENTS.md`; idempotent re-run doesn't clobber edits.
- `rvr manifest --json` lists every registered command + alias; round-trips through schema validation; MCP↔CLI map covers all 19 tools.

WS3:
- Two `set` invocations sharing `RVR_SESSION`, third within 30 min → `WRITE_AMP` warning + telemetry, matching MCP guard.
- Same three without `RVR_SESSION` → no warning (per-process, today's behavior).
- CLI read miss → writeback persists a miss-path window keyed by session.
- CLI call via an alias → audit row carries `aliasResolved`.

## Sequencing

1. **WS1** — envelope + output chokepoint + per-command wiring + schema-guide. The unblocking piece; an MCP-banned agent can drive Reverie reliably the moment this ships.
2. **WS2** — instructions fix (do the surface-aware split *first within WS2*; it's a correctness bug), then `AGENTS.md`, then manifest.
3. **WS3** — ships last (depends on WS1's envelope for `warnings[]` and on the instrumentation touched in all three), but is in v1.1.0 scope. The MCP-banned cohort is the body to measure.

Each workstream is its own PR with a CHANGELOG entry. WS1 is `### Changed` (envelope break on existing `--json`) + `### Added` (json on mutations). WS2/WS3 are `### Added`/`### Fixed`.

## Open questions

- ~~**D3 break:**~~ **RESOLVED 2026-05-27** — take the break. Unify everything under the envelope; a split contract is worse than a one-time migration and adoption is still narrow.
- ~~**WS3 trigger:**~~ **RESOLVED 2026-05-27** — WS3 is in v1.1.0 scope. The known corporate-MCP-ban cohort is sufficient signal; no telemetry threshold needed to start.
- **Manifest necessity (D7):** still open — is `--help` text + the instructions block enough for real agents, or is the structured manifest worth the build? (Lean: build it, cheap to generate from Commander, and it's the truest `tools/list` analog. Decide at WS2 implementation time.)
