# Schema Guide

How to structure a `.codexcli.json` file — and why it's structured the way it is.

## The problem this solves

Every time an AI agent opens a project, it faces the same question: *what do I need to know?* Without stored context, agents burn tokens re-exploring the codebase, re-reading README files, and re-discovering architectural decisions. Developers switching between projects face the same problem — they grep, they read, they forget.

`.codexcli.json` solves this by giving every project a structured knowledge file that both humans and AI agents can read. But "structured" only works if the structure is consistent and intentional. This guide explains the design behind that structure.

## File anatomy

A `.codexcli.json` file has five top-level sections:

```json
{
  "_meta": { ... },
  "_schema": { ... },
  "aliases": { ... },
  "confirm": { ... },
  "entries": { ... }
}
```

### `entries` — the knowledge base

This is the core of the file. All project knowledge lives here, organized into **namespaces** using dot notation:

```json
{
  "entries": {
    "project": {
      "name": "myapp",
      "description": "A web API for managing widgets"
    },
    "commands": {
      "build": "npm run build",
      "test": "npm test -- --coverage"
    },
    "arch": {
      "api": "Express REST API with versioned routes under /api/v1"
    }
  }
}
```

Entries are nested objects, but tools access them via flat dot notation: `project.name`, `commands.build`, `arch.api`. The nesting is for readability; the dots are for addressing.

### `_meta` — timestamps

Every entry gets an automatic timestamp (Unix ms) when created or updated:

```json
{
  "_meta": {
    "project.name": 1775347230199,
    "commands.build": 1775353132791
  }
}
```

You never edit `_meta` directly. It powers two features:
- **Staleness detection** — `rvr stale` surfaces entries not updated in N days
- **Age tags** — `codex_context` marks entries older than 30 days so agents know what might be outdated

### `aliases` — shortcuts for common lookups

Aliases map short names to full dot-notation paths:

```json
{
  "aliases": {
    "chk": "commands.check",
    "dev": "context.devWorkflow",
    "mcp": "arch.mcp"
  }
}
```

When you run `rvr get mcp`, the alias resolves to `arch.mcp`. This works in the CLI, MCP tools, and interpolation references. Aliases save keystrokes for entries you access frequently.

**Important:** aliases always win in key resolution. If you have both an alias `mcp -> arch.mcp` and an entry at `mcp.something`, the alias takes precedence. Avoid naming aliases the same as top-level namespaces.

### `confirm` — safety for dangerous commands

Mark commands that should prompt before execution:

```json
{
  "confirm": {
    "commands.release": true
  }
}
```

When `rvr run commands.release` is called, the user gets a confirmation prompt before the command executes. This is useful for deploy scripts, destructive operations, or anything you don't want to fire accidentally.

### `_schema` — custom namespace validation

By default, `rvr lint` validates that all entries use one of the 8 recommended namespaces. If your project needs additional namespaces, declare them here:

```json
{
  "_schema": {
    "namespaces": ["infra", "api", "frontend"]
  }
}
```

Custom namespaces are merged with the defaults — they extend, not replace. If you don't need custom namespaces, omit `_schema` entirely (the Reverie project's own file doesn't use it).

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

**Why it matters:** Agents can execute these via `codex_run`. Developers can run them via `rvr run`. Having commands stored means nobody has to remember or look up the exact invocation.

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

**Why it matters:** Agents spend significant tokens globbing and grepping to find the right file. A `files.*` entry short-circuits that search — one `codex_get` call instead of ten file searches.

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

Most projects don't need entries here. The main use case is appending project-specific agent guidance beyond what the built-in instructions cover.

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

Here's a minimal `.codexcli.json` for a new project:

```json
{
  "entries": {
    "project": {
      "name": "myapp",
      "description": "REST API for widget management"
    },
    "commands": {
      "build": "npm run build",
      "test": "npm test",
      "check": "npm run build && npm run lint && npm test"
    },
    "conventions": {
      "errors": "All API errors return { error: string, code: number }. Never throw raw strings."
    },
    "context": {
      "auth": "Auth middleware reads JWT from Authorization header, not cookies. Mobile clients can't use cookies."
    }
  }
}
```

Four namespaces, five entries, and an agent already knows: what the project is, how to build and test it, how errors should look, and why auth works the way it does. That's enough to be useful on day one. Add `arch.*`, `files.*`, and `deps.*` entries as you discover things worth keeping.

The Reverie project's own [.codexcli.json](../.codexcli.json) is the reference implementation — 53 entries across all 7 namespaces, with aliases for common lookups and confirm metadata for the release command. Use it as a model for comprehensive coverage.

## Bootstrap tiers

`codex_context` is the bootstrap entry point — agents call it at session start to load all stored knowledge in one tool result. But "all stored knowledge" can be larger than the agent's tool-result cap (~25k tokens on Claude Code / Desktop, sized similarly on most hosts). The `tier` parameter lets the caller pick how much detail to materialize.

### The three tiers

| Tier | Includes | Excludes | When to use |
|---|---|---|---|
| `essential` | `project.*`, `commands.*`, `conventions.*` | everything else | Cheap preliminary bootstrap; or when even the standard tier overflows |
| `standard` (default) | everything except `arch.*` | `arch.*` | Typical session start. Excludes architecture detail to keep payload compact |
| `full` | everything | nothing | Refactoring a subsystem, onboarding to the codebase, or any task where architecture context matters |

The tiers are inclusive cones: `essential ⊂ standard ⊂ full`. There's no way to ask for `arch.*` without also getting `project.*`/`commands.*`/`conventions.*`.

### Pick the right tier for the task

- **Answering a question, small fix, single-file edit** → `essential`. The agent rarely needs architecture context for a focused change.
- **Multi-file change, bug fix, new feature** → omit (gets `standard`). The default — most work doesn't touch architecture decisions.
- **Refactor, architectural change, learning the codebase** → `full`. You're going to read `arch.*` entries anyway; load them upfront.

### Relationship to the size budget (#100)

When the projected response would exceed `bootstrap_max_response_bytes` (default 50KB), `codex_context` automatically sheds entries by priority — `files.*` first, then `arch.*`, then large `context.*` (largest-first). `project.*`, `conventions.*`, `commands.*`, `deps.*`, and `context.next_session` are never shed. A `[trimmed: …]` notice at the top of the response names what was dropped and points at `codex_get <key>` or `tier:"full"` for retrieval.

`tier: "full"` opts out of degradation entirely. If you ask for the full payload, you get the full payload — even if that means hitting the host cap. The shed only fires for `essential` and `standard`.

If even after shedding everything sheddable the response still exceeds budget (because `project.*`, `conventions.*`, `commands.*`, `deps.*`, or `context.next_session` alone are over), you'll see a second notice: `[warning: codex_context payload still exceeds budget after shedding all sheddable namespaces. Increase bootstrap_max_response_bytes (codex_config_set) or audit project.*, conventions.*, commands.*, deps.*, and context.next_session for over-long entries.]`. That's the signal to either raise the budget or trim long never-shed entries.

### Configuring the budget

```bash
# Read current budget
rvr config get bootstrap_max_response_bytes

# Raise the cap (example: 100KB for hosts with larger tool-result limits)
rvr config set bootstrap_max_response_bytes 102400
```

For test/integration workflows, `CODEX_BOOTSTRAP_MAX_BYTES` env var overrides the config.

## Validation

Run `rvr lint` to check that all entries follow the namespace schema:

```bash
# Check project entries
rvr lint

# Check global entries
rvr lint -G

# JSON output for CI integration
rvr lint --json
```

Lint warns but doesn't block — it's guidance, not a gate. If your project genuinely needs namespaces outside the defaults, add them via `_schema.namespaces` rather than ignoring the warnings.
