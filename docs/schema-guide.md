# Schema Guide

How a `.reverie/` store is laid out — and why it's structured the way it is.

## The problem this solves

Every time an AI agent opens a project, it faces the same question: *what do I need to know?* Without stored context, agents burn tokens re-exploring the codebase, re-reading README files, and re-discovering architectural decisions. Developers switching between projects face the same problem — they grep, they read, they forget.

The `.reverie/` store solves this by giving every project a structured knowledge base that both humans and AI agents can read. But "structured" only works if the structure is consistent and intentional. This guide explains the design behind that structure.

## Store anatomy

A store is a directory. Every entry is its own file, named by its key, and a few `_`-prefixed sidecar files hold what is shared across entries:

```
.reverie/
├── project.name.json        one file per entry
├── commands.build.json
├── arch.api.json
├── _aliases.json            short names for entries
├── _confirm.json            entries that ask before they run
├── _README.md               "do not hand-edit" note
├── .gitignore               keeps _epoch.json out of git
└── _epoch.json              per-clone write counter, not committed
```

The project store lives in `.reverie/` at the project root and is meant to be committed. The global store has the same layout under `~/.reverie/store/`.

You never edit these files by hand — `rvr` and the MCP tools maintain them, along with the timestamps, alias integrity and audit log that hand edits would skip. This section describes the layout so that a diff or a merge makes sense when you see one.

### Entries — one file per key

All project knowledge lives in entries, addressed by dot notation: `project.name`, `commands.build`, `arch.api`. The first segment is the **namespace**. `rvr set arch.api "…"` writes `.reverie/arch.api.json`:

```json
{
  "value": "Express REST API with versioned routes under /api/v1",
  "meta": {
    "created": 1775347230199,
    "updated": 1775353132791
  }
}
```

The dots are for addressing; the tools present entries as a tree. `rvr get arch` returns everything under `arch.*`, and a key is either a leaf with a value or a parent of other keys, never both.

One file per entry is what makes a committed store workable for a team: two branches that add or change *different* entries merge without conflict. Two branches that write the *same* entry conflict in that entry's file, like any other file both sides edited.

### Timestamps

Each entry file records when it was created and last updated (Unix ms). They are maintained for you and power two features:
- **Staleness detection** — `rvr stale` surfaces entries not updated in N days
- **Age tags** — the bootstrap marks entries older than 30 days, so agents know what might be outdated

### `_aliases.json` — shortcuts for common lookups

Aliases map short names to full keys:

```json
{
  "chk": "commands.check",
  "dev": "context.devWorkflow",
  "mcp": "arch.mcp"
}
```

When you run `rvr get mcp`, the alias resolves to `arch.mcp`. This works in the CLI, MCP tools, and interpolation references. Aliases save keystrokes for entries you access frequently. An entry has at most one alias: giving it a second replaces the first.

**Important:** aliases always win in key resolution. If you have both an alias `mcp -> arch.mcp` and an entry at `mcp.something`, the alias takes precedence. Avoid naming aliases the same as top-level namespaces.

### `_confirm.json` — safety for dangerous commands

Marks commands that should prompt before execution:

```json
{
  "commands.release": true
}
```

When `rvr run commands.release` is called, the user gets a confirmation prompt before the command executes. This is useful for deploy scripts, destructive operations, or anything you don't want to fire accidentally. Set the flag with `rvr set <key> <value> --confirm` or `rvr confirm set <key>`.

### The other files

- **`_epoch.json`** — a counter the store bumps on every write so that a reader can tell it overlapped a writer. It is per-clone state: the seeded `.gitignore` keeps it out of commits, and a fresh clone starts without one.
- **`.gitignore`** and **`_README.md`** — written once when the store is created. Both are safe to extend.

## The namespace schema

Reverie recommends 8 namespaces. Each has a specific purpose — this matters because agents use namespace names to decide *where to look* and *what to store*.

### `project.*` — identity and goals

What is this project? Who is it for? What are we trying to achieve?

| Key | Purpose |
|---|---|
| `project.name` | Project name |
| `project.description` | One-line summary |
| `project.stack` | Tech stack overview |
| `project.vision` | Long-term direction |
| `project.goals` | Current priorities |

**Why it matters:** This is the first thing an agent reads. It sets the frame for everything else — a CLI tool requires different advice than a web app or a machine learning pipeline.

**Good:** `"Widget REST API serving mobile and web clients, backed by PostgreSQL"`
**Bad:** `"A project"` (too vague to be useful)

### `commands.*` — executable knowledge

Build, test, lint, deploy, and any other commands worth remembering.

| Key | Purpose |
|---|---|
| `commands.build` | Build the project |
| `commands.test` | Run tests |
| `commands.lint` | Run linters |
| `commands.deploy` | Deploy to production |
| `commands.check` | Full validation pipeline |

**Why it matters:** Agents can execute these via `reverie_run`. Developers can run them via `rvr run`. Having commands stored means nobody has to remember or look up the exact invocation.

**Good:** `"npm run build && npm run lint && npm test"` (the full pipeline, ready to execute)
**Bad:** `"run the build"` (not executable)

Commands support interpolation — `${commands.build} && ${commands.test}` composes commands from other entries.

### `arch.*` — architecture and design decisions

How the system is built, and *why* it's built that way.

| Key | Purpose |
|---|---|
| `arch.storage` | Data storage approach |
| `arch.api` | API design and patterns |
| `arch.auth` | Authentication/authorization |
| `arch.mcp` | MCP server design |
| `arch.scope` | Scoping and resolution logic |

**Why it matters:** Architecture entries prevent agents from suggesting changes that conflict with established design decisions. They're the difference between "why don't you just use SQLite?" and understanding that the project deliberately chose file-based storage for portability.

**Good:** `"Atomic writes via tmp file + rename with file locking. Prevents partial writes on crash."`
**Bad:** `"We use files"` (states the obvious without explaining the decision)

### `conventions.*` — coding patterns and rules

How code should be written in this project. Style, patterns, and non-obvious rules.

| Key | Purpose |
|---|---|
| `conventions.types` | Type system conventions |
| `conventions.tests` | Testing approach and tools |
| `conventions.errors` | Error handling patterns |
| `conventions.naming` | Naming conventions |
| `conventions.output` | User-facing output rules |

**Why it matters:** Conventions prevent agents from writing code that *works* but doesn't match the project's style. These are the rules that aren't in the linter config.

**Good:** `"exactOptionalPropertyTypes: true — optional interface fields need | undefined"` (specific, actionable)
**Bad:** `"Follow TypeScript best practices"` (every project says this; it means nothing)

### `context.*` — gotchas, edge cases, and historical decisions

Things that would surprise someone new to the project. The stuff that makes you say "oh, I wish someone had told me that."

| Key | Purpose |
|---|---|
| `context.migration` | Data migration history and caveats |
| `context.legacy` | Legacy code that can't be changed (and why) |
| `context.performance` | Performance constraints or known bottlenecks |
| `context.gotchas` | Non-obvious pitfalls |

**Why it matters:** Context entries prevent agents from making the same mistakes that humans already made. They capture institutional knowledge that lives in people's heads but not in the code.

**Good:** `"Alias always wins in resolveKey — no way to bypass and access an entry with the same name as an alias. Known limitation."` (specific, explains the consequence)
**Bad:** `"Be careful with aliases"` (careful how?)

### `files.*` — key file paths and their roles

A directory to the most important files in the project, with enough context to know *why* each matters.

| Key | Purpose |
|---|---|
| `files.entry` | Application entry point |
| `files.config` | Configuration file |
| `files.types` | Shared type definitions |
| `files.routes` | Route definitions |
| `files.store` | Data store implementation |

**Why it matters:** Agents spend significant tokens globbing and grepping to find the right file. A `files.*` entry short-circuits that search — one `reverie_get` call instead of ten file searches.

**Good:** `"src/store.ts — ScopedStore class, mtime caching, auto-migration, meta timestamps, atomic writes via file locking"` (path + what's in it + why it matters)
**Bad:** `"src/store.ts"` (the path alone isn't enough — agents need to know if this is the file they're looking for)

### `deps.*` — notable dependencies

Dependencies that are worth documenting because of *why* they were chosen, version constraints, or non-obvious usage.

| Key | Purpose |
|---|---|
| `deps.chalk` | Why this version? |
| `deps.zod` | What it's used for |
| `deps.esbuild` | Build tooling rationale |

**Why it matters:** Not every dependency needs an entry — only the ones with a story. If someone would ask "why are we on chalk v4 instead of v5?" or "what is postject for?", that's a deps entry.

**Good:** `"chalk ^4 (CJS) — terminal colors. Pinned to v4 for CommonJS compatibility; v5+ is ESM-only."` (version rationale)
**Bad:** `"chalk — colors"` (derivable from package.json)

### `system.*` — internal configuration

Reserved for Reverie's own configuration, like custom LLM instructions.

| Key | Purpose |
|---|---|
| `system.llm.instructions` | Custom instructions appended to the built-in MCP prompt |
| `system.bootstrap.pinned` | Namespaces the bootstrap renders in full, overriding the default (see [Pinned namespaces](#pinned-namespaces)) |

Most projects don't need entries here. The main use cases are appending project-specific agent guidance beyond what the built-in instructions cover, and choosing which namespaces lead the bootstrap.

## What makes a good entry

The guiding principle: **store what would otherwise be lost between sessions.**

### Store

- Architecture decisions and the reasoning behind them
- Non-obvious constraints, gotchas, and edge cases
- Conventions that aren't enforced by a linter
- File roles that aren't obvious from the filename
- Dependency choices that have a story
- Commands that are hard to remember or compose

### Don't store

- Anything derivable from `package.json`, `README.md`, or the code itself
- Obvious file paths (`files.readme = "README.md"`)
- Generic advice (`conventions.style = "Write clean code"`)
- Rapidly changing state (current sprint tasks, in-progress work)
- Large blobs of text (entries should be one sentence or a short command)

### The conciseness test

Every entry should pass this test: *Can an AI agent read this in one line and immediately act on it?*

If an entry needs multiple paragraphs, it's probably better as a doc file referenced by a shorter entry, or split into multiple entries under the same namespace.

## Putting it all together

Here's what a minimal store holds for a new project. `rvr init` creates `.reverie/` and fills in what it can detect from the codebase; entries like these are then added with `rvr set`:

```bash
rvr set project.name "myapp"
rvr set project.description "REST API for widget management"
rvr set commands.check "npm run build && npm run lint && npm test"
rvr set conventions.errors "All API errors return { error: string, code: number }. Never throw raw strings."
rvr set context.auth "Auth middleware reads JWT from Authorization header, not cookies. Mobile clients can't use cookies."
```

Each command writes one entry file.

Four namespaces, five entries, and an agent already knows: what the project is, how to build and test it, how errors should look, and why auth works the way it does. That's enough to be useful on day one. Add `arch.*`, `files.*`, and `deps.*` entries as you discover things worth keeping.

The Reverie project's own [`.reverie/`](../.reverie/) is the reference implementation — entries across all 7 namespaces, with aliases for common lookups and confirm metadata for the release command. Use it as a model for comprehensive coverage.

## Bootstrap tiers

`reverie_context` is the bootstrap entry point — agents call it at session start. Since [#188](https://github.com/seabearDEV/reverie/issues/188) it renders a **front page** rather than every value: pinned namespaces in full, and one index line for every other entry. The `tier` parameter picks how much to materialize.

### The three tiers

| Tier | Renders in full | Renders as index lines | When to use |
|---|---|---|---|
| `essential` | pinned namespaces | nothing | Focused work; or when even the standard tier would demote |
| `standard` (default) | pinned namespaces | every other entry — `arch.*` included | Typical session start: every key is visible, only unpinned values are gisted |
| `full` | everything | nothing | Refactoring a subsystem, onboarding, or any task where you would open most entries anyway |

`essential ⊂ standard ⊂ full` still holds: standard adds the index; full replaces gists with values.

### Pinned namespaces

Default: `project.*`, `commands.*`, `conventions.*`. Override per store with an entry:

```bash
rvr set system.bootstrap.pinned "conventions,commands"
```

The override travels with the repo (it is store content, not `config.json`) and applies to both surfaces. An unusable value falls back to the default with a warning.

### Index lines

```
context.releaseTagStaleLocal: Release-tag hazard hit 2026-06-09 during v1.2.1: a STALE LOCAL tag v1.2.1 already existed… [+1.0K] [88d]
```

The gist is the entry's first line, cut at a word boundary within `bootstrap_gist_chars` (default 160) — a maximum: the size budget can narrow it, see below. `[+1.0K]` is what opening the entry costs; the age tag is the usual one. An entry that fits on one line renders whole, exactly as before. Open an entry with `reverie_get <key>` / `rvr get <key>`, or a whole namespace with `rvr get context -v`. The footer repeats the hint: `[tier: standard (89 entries: 24 in full, 65 indexed) — open an entry with rvr get <key>, or use --tier full for everything]`.

Write entries so the first sentence stands alone — it *is* the gist. `rvr lint --seed-quality` flags entries that don't.

### Relationship to the size budget (#100, #188, #211)

When the projected response would exceed `bootstrap_max_response_bytes` (default 28KB):

1. **Demote** — pinned namespaces fall back to index lines, largest first, never `context.next_session`. Notice: `[demoted to index: project.* (21 entries, 21.7K → 4.1K) — open entries with reverie_get <key>]`. Nothing is lost.
2. **Narrow** — every index line's gist shrinks to one shared width, a step at a time: 80 characters, then 40, then keys only (`context.someKey: … [+1.6K] [88d]` — the key and what opening it costs). Only steps below `bootstrap_gist_chars` apply, and a line is never made longer, so a short value still renders whole. Every key stays on the front page. The footer names the width: `… 316 indexed, gists cut to 40 chars) — open an entry with rvr get <key> …` or `… keys only) …`.
3. **Drop** — only when keys-only still does not fit: the #100 order over what remains, `files.*` first, then `arch.*`, then large `context.*` largest-first. `project.*`, `conventions.*`, `commands.*`, `deps.*`, and `context.next_session` are never dropped. Notice: `[trimmed: …]`.
4. If the never-dropped namespaces still exceed the budget as keys-only lines you get the `[warning: reverie_context payload still exceeds budget …]` notice.

Output order on both surfaces is handoff banner, entries, aliases, notices, tier footer (#212): the banner leads so a harness that truncates a large result to a short preview still shows it, and the notices sit beside the footer that carries the fetch hint. The default budget (28KB) is sized to the Claude Code Bash tool's 30,000-character inline limit — output past it is saved to a file and the model sees a 2KB preview.

`tier: "full"` opts out of all of it. In JSON output the notices appear in `warnings[]` and as `result.degraded`, `result.demotedNamespaces`, `result.shedNamespaces`; `result.gistChars` is present when the gists were narrowed (0 = keys only); `result.entries` holds the values rendered in full and `result.index` the gists (`{ gist, bytes, truncated }`).

### Configuring the budget and gist length

```bash
rvr config get bootstrap_max_response_bytes
rvr config set bootstrap_max_response_bytes 102400   # hosts with larger tool-result limits
rvr config set bootstrap_gist_chars 120              # shorter index lines (the maximum; the budget may narrow further)
```

For test/integration workflows, `RVR_BOOTSTRAP_MAX_BYTES` and `RVR_BOOTSTRAP_GIST_CHARS` override the config.

## CLI agent sessions (`RVR_SESSION`, harness detection)

The CLI is one process per invocation, so session-scoped guardrails need an id that spans invocations. It is resolved in this order:

1. **`RVR_SESSION=<any-id>`** — explicit, always wins.
2. **The harness's own session id** ([#207](https://github.com/seabearDEV/reverie/issues/207)) — when the environment identifies a harness that exports one. Today that is Claude Code (`CLAUDE_CODE_SESSION_ID`, honored only alongside the Claude Code fingerprint). Nothing to configure; telemetry and audit rows carry `sessionDetected: true`.
3. **Otherwise** each invocation is its own session and no state files are written. Agents on a harness with no detected session variable (Codex, for now) should still export `RVR_SESSION` once at session start.

With a shared id (1 or 2), every invocation counts as one session, with state persisted to `~/.reverie/sessions/<id>.json` (TTL-pruned after 24h). This enables the same guardrails MCP sessions get ([#119](https://github.com/seabearDEV/reverie/issues/119)):

- **Write-amplification warnings** (#101): the 3rd+ write of the same key within 30 minutes adds a `WRITE_AMP` warning to the envelope's `warnings[]` (with `count`) and to stderr in human mode.
- **Miss-path tracking**: read misses open exploration windows that close on writeback/hit across invocations, feeding the same `reverie_stats` calibration as MCP sessions.

The write-amplification guard has no exempt keys: a handoff (`context.next_session`) rewritten three times inside 30 minutes warns like any other entry. The warning is advisory and never fails the write.

## Validation

Run `rvr lint` to check that all entries follow the namespace schema:

```bash
# Check project entries
rvr lint

# Check global entries
rvr lint -G

# JSON output for CI integration (envelope; lint payload is under `.result`)
rvr lint --json
```

In JSON mode the lint payload (`issues`, `allowed`, optional `seedQuality`) is nested inside the standard envelope's `result` field — parse `.result.issues`, and branch on the top-level `ok` / exit code. See the README's [Structured JSON Output](../README.md#structured-json-output) for the full envelope contract and error codes.

For namespaces, lint is guidance, not a gate: it lists entries outside the recommended set and still exits 0. Declaring extra namespaces is not supported for directory stores yet, so a project that genuinely needs one will see it listed — that is expected, not an error.
