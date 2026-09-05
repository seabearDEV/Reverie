# Design: index-first bootstrap — pinned namespaces in full, one-line gists for the rest (#188)

**Issue:** [#188](https://github.com/seabearDEV/reverie/issues/188) · **Umbrella:** [#186](https://github.com/seabearDEV/reverie/issues/186) (Forum model, step 1)
**Status:** IMPLEMENTED 2026-09-04 (PR pending review)
**Driving evidence:** `design/reverie-design-notes-2026-09-04.md` (maintainer/Claude design session), store entry `project.multiAgentDesign` (claims verified against source), telemetry 2026-07-23 → 2026-09-04
**Playbook:** mirrors the #100 design-first treatment; #100's shed contract is extended, not replaced

## Problem

`reverie_context` / `rvr context` materializes every entry's full value into one response. The #100 size budget keeps the response under the host cap, but it does so by **dropping** entries and naming only the namespace they came from. Three consequences showed up in the record:

| Store | Standard-tier bytes | Since 2026-07-23 |
|---|---|---|
| Reverie (this repo) | 59 KB (72 KB full); top 20 entries = 50% of bytes | 0 of 18 bootstraps shed — because this machine raised the budget to 140 KB |
| Tesserae | 241 KB; `conventions.*` alone 54 KB, never-shed | 35 of 37 bootstraps shed |
| Taptory | 110 KB across 40 entries (2.7 KB/entry) | fits only because of the raised budget |

1. **The bootstrap is where the tokens go.** AGENTS.md is 3.5 KB; the bootstrap is 59 KB here and 241 KB in Tesserae. Every session pays it before the first useful token.
2. **Shedding loses facts silently.** A dropped `context.*` entry leaves no trace beyond `[trimmed: context.* (12 entries)]`. The agent cannot know whether one of the twelve was the one it needed.
3. **The bootstrap is opaque to the record.** One blob read per session means the audit log cannot tell which entries mattered. Entry health (#84), tier promotion, and every "is this seed pulling its weight" question has had no demand signal to work from.

The store is already a forum, informally: the largest entries are posts with dated replies grafted in (`project.inFlight`, `context.releaseTagNamespace`, `context.binaryName`). This issue does not add threads (that is #189); it makes the bootstrap a **front page** so threads have somewhere to be counted, and so the bootstrap stops being the place bloat is paid.

## Decisions locked (2026-09-04)

| | Decision |
|---|---|
| **D1** | **Tier semantics.** `full` is unchanged: every entry, full value, bypasses the budget. `standard` (default) = **pinned namespaces in full + one index line for every other entry** — including `arch.*`, which was invisible at standard tier before. `essential` = pinned namespaces in full, nothing else. |
| **D2** | **Pinned set.** Default `project.*`, `commands.*`, `conventions.*` — identical to the old `essential` set, so `essential` keeps its meaning and small stores render byte-for-byte as before. Per-store override via a `system.bootstrap.pinned` entry holding comma-separated namespaces (e.g. `conventions,commands`), following the `system.llm.instructions` precedent: it is project knowledge about how to bootstrap this store, it travels with the repo, and it is edited through `rvr set`. Not a `config.json` key — that is per machine. |
| **D3** | **Gist rule.** The gist is the value's first line, cut at the last word boundary within `bootstrap_gist_chars` (default 160, config key, `RVR_BOOTSTRAP_GIST_CHARS` env override for tests) with `…` appended when anything was cut. A value that fits in one line under the cap is shown whole — no marker, no change from today. Encrypted values render `[encrypted]`. No summary generation: the key is already the title, and the entries this store has accumulated already lead with a headline sentence. Quality is enforced by convention (`rvr lint --seed-quality`), not by a generator. |
| **D4** | **Index line format.** `key: gist… [+2.1K] [86d]` — the `[+N]` marker carries the bytes the agent would get by opening the entry, using the same `K` formatting as the `[trimmed: …]` notice; the age tag is the existing one. Plain and colored output share the shape. |
| **D5** | **Budget order.** Over budget at `standard`/`essential`: (1) **demote** pinned namespaces to index lines, largest namespace first, never `context.next_session`; (2) then the existing #100 **drop** order over what remains (`files.*` → `arch.*` → large `context.*`, never-shed list unchanged); (3) then the pathological notice. Demotion is reported as `[demoted to index: project.* (21 entries, 21.7K → 4.1K) — open entries with reverie_get <key>]`. With index lines at ~200 B each, step 3 is unreachable for any realistic store. |
| **D6** | **Footer carries the fetch hint.** `[tier: standard — 24 in full, 65 indexed; open an entry with rvr get <key>, or --tier full]` (MCP: `reverie_get <key>` / `tier:"full"`). When nothing is indexed the old footer renders unchanged. This is the in-band instruction: an agent that reads the bootstrap learns how to open a thread without a word added to AGENTS.md. |
| **D7** | **JSON shape.** `result.entries` keeps `key → value` for entries rendered in full. New `result.index` = `key → { gist, bytes, truncated }` for index lines. Additive; `--tier full` output is unchanged. `result.demotedNamespaces` joins `degraded` / `shedNamespaces`. |
| **D8** | **Telemetry.** `reverie_context` rows (telemetry + audit, both surfaces) gain `tier`, `pinned` (entries in full), `indexed`, and `demotedNamespaces`. CLI rows never carried `degraded` (only MCP rows did) — the CLI wrapper now consumes the same signals through a per-invocation channel in `output.ts`. |
| **D9** | **Instruction surface.** One clause changes in each blob ("loads pinned namespaces in full and a one-line gist for everything else; open any entry with `rvr get <key>`"). The MCP blob stays under its 2 KB cap by cutting elsewhere. No new verb, no new flag. |
| **D10** | **`--tier` validation.** An unknown tier was silently treated as standard while the footer echoed the bogus name. It now fails with `INVALID_INPUT` (CLI) — the MCP param was already a zod enum. |
| **D11** | **`--size-only` accounts for shape.** Per-namespace bytes are computed as they would render at the requested tier (full for pinned, index otherwise), and each row says which. `fitsBudget` answers the same question it did before. |

## Algorithm

```
compose(flat, tier, pinnedPrefixes, gistChars, budget, fixedOverhead):
  handoff  = banner(flat[context.next_session]); remove key from flat
  if tier == full:
      full = all entries; index = {}; skip budget
  else:
      full  = entries whose key starts with a pinned prefix
      index = (tier == standard) ? every other entry → gist(value) : {}

  display = { k: value for full } ∪ { k: gist… [+N] for index }

  if projected(display) > budget:
      // D5 step 1 — demote whole pinned namespaces, largest rendered first
      for ns in pinned namespaces sorted by rendered bytes desc:
          if projected <= budget: break
          for k in ns: display[k] = gistLine(value[k]); move k full → index
          record demoted segment (entries, bytes before → after)
      // D5 step 2 — #100 drop order, unchanged rules
      shedToFitBudget(display, …)        // never-shed prefixes still protected
      // D5 step 3 — pathological notice if still over

  render: [project header (MCP)] [demoted notice] [trimmed notice] [pathological notice]
          [handoff banner] [entry lines in store order] [aliases] [footer]
```

`gist(value)`:

```
line = value up to the first '\n', right-trimmed
if value has no newline and line.length <= cap → { gist: value, truncated: false }
cut = last whitespace in line[0..cap]; if cut < cap/2 → cut = cap   // no usable boundary
→ { gist: line[0..cut].trimEnd(), truncated: true }
```

Rendered index line: `${key}: ${gist}${truncated ? '…' : ''}${truncated ? ' [+' + fmt(valueBytes - gistBytes) + ']' : ''}${ageTag}`.

## Affected surfaces

| File | Change |
|---|---|
| `src/commands/context.ts` | `composeContext()` (partition → gist → demote → shed) shared by both surfaces; `renderContextLines()`; pinned-prefix resolution from the flat map; `--tier` validation; size report shape-aware |
| `src/utils/contextBudget.ts` | `gistOf()`, `formatIndexLine()`, `demoteToFitBudget()`; `shedToFitBudget()` unchanged (it already sizes whatever display text it is given) |
| `src/mcp-server.ts` | `reverie_context` handler consumes `composeContext()`; `GuardrailSignals` gains `tier`, `pinned`, `indexed`, `demotedNamespaces`; tool + param descriptions describe the front page |
| `src/utils/output.ts` | per-invocation signal channel (`recordSignals` / `takeSignals`, reset with the envelope state) so CLI telemetry sees what MCP telemetry sees |
| `src/utils/instrumentation.ts` | merges recorded signals into the CLI telemetry/audit rows (`degraded` reaches CLI rows for the first time) |
| `src/utils/telemetry.ts`, `src/utils/audit.ts` | new optional fields |
| `src/config.ts`, `src/commands/config-commands.ts`, `src/mcp-server.ts` (`reverie_config_set`), `src/completions.ts` | `bootstrap_gist_chars` |
| `src/llm-instructions.ts`, `src/commands/claude-md.ts`, `AGENTS.md` | one-clause bootstrap wording (D9) |
| `README.md`, `docs/schema-guide.md`, `CHANGELOG.md` | tiers table, front-page description, config key |

### CLI vs MCP

Both surfaces render from the same `composeContext()` result. The only differences are the MCP project header line, the wording of the fetch hint (`rvr get <key>` vs `reverie_get <key>`), and CLI colors. The v1.2.2 twin-implementation dedup found one divergence bug per copy; this change removes the last hand-maintained copy of the bootstrap render.

## Edge cases

| Case | Behavior |
|---|---|
| Store where every value is one short line | Standard-tier output is byte-identical to today apart from `arch.*` now appearing and the footer wording. |
| Multi-line value whose first line fits the cap | Index line shows the first line + `…` + `[+N]` — the newline is the truncation. |
| First line has no whitespace inside the cap (a URL, a hash) | Hard cut at the cap. |
| `system.bootstrap.pinned` set to an empty string or garbage | Falls back to the default pinned set; a warning names the entry. Unknown namespace names are accepted (they pin nothing). |
| `system.bootstrap.pinned` names `context` | `context.*` renders in full; `context.next_session` is still the banner. |
| `essential` over budget | Demotes pinned namespaces to index lines (was: pathological notice with no recourse). |
| `context.next_session` | Never indexed, never demoted, never shed — banner semantics unchanged (#91). |
| Encrypted values | `[encrypted]` in both shapes; never gisted. |
| `tier:"full"` | Byte-identical to today. No index, no demotion, no shed. |
| `--tier nonsense` | `INVALID_INPUT` (exit 1; envelope error in JSON mode). |
| Aliases, handoff, empty store | Unchanged. |

## Telemetry

Rows for `reverie_context` gain, on both surfaces:

```jsonl
{ "tool": "reverie_context", "tier": "standard", "pinned": 24, "indexed": 65,
  "degraded": true, "demotedNamespaces": ["project.*"], "shedNamespaces": [], "responseSize": 21873 }
```

Post-deploy questions:

- **Bytes:** `responseSize` distribution per `projectId` before vs after. Measured at implementation time (standard tier, plain output):

  | Store | Before | After, default 38 KB budget | After, 140 KB budget (this machine's config) |
  |---|---|---|---|
  | Reverie (110 entries) | 65 KB | 23 KB (`project.*` demoted, 23.6K → 3.8K) | 43 KB |
  | Tesserae (167 entries) | 139 KB, already shedding | 38 KB (`conventions.*` demoted, 53.3K → 4.6K) | 88 KB |
  | Taptory (54 entries) | 111 KB | 24 KB (`project.*` demoted, 61.1K → 2.6K) | 84 KB |

  `--tier full` output is byte-identical before and after (verified by hash on the Reverie store).
- **Demand:** `reverie_get` / `rvr get` calls per session after a context call — the first per-entry read signal. Feeds #84 coldness and the tier-promotion idea in `project.seedRoadmap` L3.
- **Gist quality:** entries opened often after bootstrap are working gists; keys that show up in `miss-paths.jsonl` while present in the index are gists that failed to land (#140 territory).
- **Cap calibration:** if demotion fires on >5% of standard bootstraps in stores with a default pinned set, the pinned default is too wide; if `[+N]` markers rarely exceed 1 KB, the cap can shrink.

## Out of scope

- **Batch fetch** (`rvr get a b c`). Prefix lookups (`rvr get context -v`) are the batch shape today; file separately if telemetry shows one-at-a-time opening.
- **Replies / threads** — #189.
- **Miss paths on the front page** — #140.
- **Compaction** — #186 step 4, on #84 signals.
- **Generated summaries.** Rejected: no LLM in the tool, and the author of an entry is already an LLM that can write a headline sentence.
- **Per-agent namespaces.** Rejected in #186: the namespace is a topic axis that drives tiers, shedding, lint, and telemetry; ownership belongs in meta (#45).

## Test plan

Unit (`contextBudget.test.ts`, new `contextIndex` cases):

- gist: short single line → whole value, not truncated; long line → word-boundary cut + truncated; multi-line short first line → truncated; no whitespace → hard cut; encrypted → `[encrypted]`.
- index line format: marker bytes = value bytes − gist bytes; age tag appended after the marker.
- demote: under budget → nothing demoted; over budget → largest pinned namespace demoted first; `context.next_session` never demoted; demoted keys move from `full` to `index`; drop phase still runs after demotion; never-shed prefixes survive as index lines.

Integration (`context-shed-integration.test.ts`, `mcp-server.test.ts`, `cli-restructure.test.ts`):

- standard tier: pinned entries in full, `arch.*` present as index lines, footer names counts and the fetch hint; JSON has `entries` + `index` + `tier`.
- essential tier: pinned only, no index lines.
- full tier: byte-identical to previous output (no `index`, no footer).
- pinned override via `system.bootstrap.pinned`; garbage value falls back with a warning.
- demote notice + `demotedNamespaces` in JSON and in CLI telemetry rows.
- `--tier bogus` → `INVALID_INPUT`.
- `--size-only`: shape column present, bytes reflect index rendering for unpinned namespaces.
- handshake-size: MCP instructions still ≤ 2 KB; `reverie_context` description ≤ 350 B.

Manual: run the built binary against this repo's store and Tesserae's; record standard-tier bytes before/after in the PR.

## Sequencing

1. `contextBudget.ts`: gist + index line + demote (pure functions, unit tests).
2. `context.ts`: `composeContext()` + render; CLI wired; `--tier` validation; size report.
3. `mcp-server.ts`: handler on the shared composer; signals.
4. `output.ts` / `instrumentation.ts` / telemetry types: CLI signal channel.
5. Config key + instructions + docs + CHANGELOG.
6. Tests updated/added; full suite; measurement on real stores.
7. Single PR against `main`, referencing #188 and #186.
