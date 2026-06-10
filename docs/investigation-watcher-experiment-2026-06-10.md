# Investigation: the audit-watcher experiment (2026-06-10)

A thought experiment made real: one Claude instance ("watcher") tailed `~/.reverie/audit.jsonl`
live while a second instance ("worker") interacted with the store via MCP. Question under test:
*what happens when an LLM — rather than a threshold script — observes the behavioral record?*

## Setup

- Watcher read the raw JSONL by byte offset (state in a tmp file), **never through `rvr audit`** —
  so observation left no trace in the record being observed. Wake signal: a background monitor
  polling file size every 5s with a 15s debounce; fallback heartbeat 30min.
- Worker was a stock Claude Code session on this repo, told to run a deliberate op-class sampler.
- Total experiment time: ~40 minutes, of which the worker was active for ~2.

## Timeline

1. Watcher baselined at 1,300,360 bytes; last event was its own bootstrap (observer effect, literal).
2. Worker session `dbf61e62` bootstrapped (`reverie_context`, standard tier) — visible within 20s.
3. Worker burst: hit read (`files.interpolate`), deliberate miss (`context.thisKeyDoesNotExist`),
   find, a write addressed *to the watcher* ("Hello, observer…" in `context.dualAgentExperiment`),
   remove of that key 10.6s later.
4. Watcher cross-checked the worker's *stated* plan against the *logged* ops and found one item
   missing: the promised `reverie_stats`/`reverie_audit` calls. Investigation followed.

## Findings

### 1. SKIP_AUDIT blind spot — the observability tools are invisible to observability

`SKIP_AUDIT = new Set(['reverie_stats', 'reverie_audit'])` (`src/utils/instrumentation.ts:18`,
honored by both the MCP wrapper at `mcp-server.ts:225` and the CLI path at `instrumentation.ts:142`)
short-circuits instrumentation entirely for those tools. Consequences:

- **Zero `op:"meta"` rows exist** across all of audit.jsonl + telemetry.jsonl (~1.3 MB of history),
  even though the op class is documented in the schema (#93 / `context.opClassification`) and stats
  runs demonstrably happened (every soak checkpoint). `classifyOp`'s `default: return 'meta'` is
  reachable only by tools missing from its switch — today it is a silent catch-all for future
  unclassified tools, not a real op class.
- Claims about stats/audit usage are **unverifiable from the record by design** — the watcher could
  not determine whether the worker ran them. The exclusion is presumably deliberate (self-reference
  pollution: a stats call shouldn't distort the stats it computes) but carries no comment and no
  mention in schema-guide.

**Proposed fix (drafted as an issue, not yet filed):** either *document* (comment at the definition,
schema-guide note, fix the 'meta' doc claim) or *instrument with a `selfRef:true` flag* that
`computeStats`/`queryAuditLog` exclude by default — complete record, clean aggregates. Trust-themed;
v1.3.0 candidate.

### 2. The #130 leak dominates, not just pollutes, the record

Telemetry census: `reverie_init` is the single most frequent op in history — **451 writes vs 387
real `reverie_set`s** (codex-era init total: 3; init should fire ~once per project). The all-time
figures cited in `project.surfaceStrategy` (944/1266 calls, 75% MCP) are skewed by leaked init
bursts. Posted as evidence on #130.

### 3. Removal is not erasure

The worker's "scratch" entry survives permanently in the append-only log — twice (write `after`,
remove `before`). Anything an agent writes to the store, however briefly, is immortal in
audit.jsonl. Security shading: secrets or injection payloads "cleaned up" from the store remain in
the record.

### 4. The audit log does not sanitize values

Write/remove rows carry full `before`/`after`/`params` content. (Prior in-session belief that
values were sanitized — seeded by `files.audit`'s mention of `sanitizeValue` — was wrong; whatever
sanitize covers, it is not value capture.) A watcher sees content, not just behavior, and the log
is a second, unguarded copy of every value ever stored.

### 5. The pattern that produced every finding: claim ⟂ record

Each discovery came from diffing a *declarative* statement against the *behavioral* record:

| Claim | Record | Divergence |
|---|---|---|
| Worker's stated op plan | Logged ops | Missing meta calls → finding 1 |
| Schema documents `op:"meta"` | Zero meta rows ever | Finding 1 |
| `surfaceStrategy` usage stats | Census of raw telemetry | Finding 2 |
| Watcher's own "log is sanitized" belief | First write row read | Finding 4 |

A threshold script sees six well-formed ops and stays green; the LLM noticed an *absence* relative
to a stated intent and went investigating. The right model for an LLM watcher is **analyst with a
live feed**, not alarm.

## The bigger thing

Reverie maintains two records of a project:

- **The store** — what agents *claim*: curated, mutable, forward-looking. Memory.
- **The audit log** — what agents *did*: append-only, immutable, backward-looking. Evidence.

Every finding above is the same operation: **reconcile the two records; each divergence is a bug, a
doc gap, or a false belief — all three valuable.** Trust in agent-maintained knowledge cannot come
from the knowledge itself (entries asserting their own freshness is circular); it can only come
from checking claims against behavior. Reverie is unusual in *owning both sides of that check*.

This reframes existing roadmap items as one program rather than separate features: #42 (verify
entries against source), #45 (who wrote this), #84 (entry health), #130 (clean record), the
seed-roadmap L2/L3 items (`rvr topology`, telemetry-driven tier promotion, `meta.testedWith`), and
the runtime complement to #131/#132's static scanning. They are all reconciliation loops between
store and log. The watcher experiment was the first time an intelligence actively closed that loop
— and it generated two concrete findings in forty minutes on a store this small.

The bicameral metaphor completes itself: entries are the voice; the audit log is the lived loop;
the reverie — the thing that produced insight — was neither record alone but the *diff* between them.

## Follow-ups

- [ ] File the SKIP_AUDIT issue (body drafted above) — user decision.
- [x] #130 comment with census evidence.
- [x] Store seeds: `context.auditRecordProperties`, `project.twoRecordsThesis`.
- [ ] Someday: a `rvr watch`-style follow primitive would make watcher agents first-class
      (today requires raw-file tailing to stay out of the record).
