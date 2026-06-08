# Reverie — agent guide

## Reverie store

This project keeps durable, cross-session knowledge in a Reverie store (`.reverie/`). Two interchangeable surfaces reach it with the **same functionality — prefer MCP, fall back to the CLI**:

- **MCP tools** — `reverie_context`, `reverie_get`, `reverie_set`, `reverie_find`, … Use these whenever an MCP server is connected.
- **`rvr` CLI** — `rvr context`, `rvr get`, `rvr set`, `rvr find`, … Use this when MCP is unavailable. Every MCP tool has an exact `rvr` equivalent: run `rvr manifest --json` for the full MCP-tool ↔ CLI-command map, and `rvr config llm-instructions --surface cli` for CLI specifics (the `--json` envelope, scope flags, confirm flow).

CLI commands emit a single machine-readable envelope with `--json` (or `RVR_OUTPUT=json`): `{ "reverie": "1", "ok": true, "command": "…", "result": …, "error": { "code": … }, "warnings": [] }`. Branch on `error.code`, not on prose.

Never hand-edit `.reverie/*.json` directly — that bypasses audit logging, alias resolution, interpolation, and staleness metadata. Use the MCP tools or `rvr` only.

## Bootstrap

1. Load all stored project knowledge first — `reverie_context` (MCP) or `rvr context` (CLI).
2. If this is a git repo, run `gh issue list --state open` and read any issue related to the user's request before coding.

## Before exploring code

Check the store before globbing/grepping or reading code — `reverie_get <key>` (MCP) or `rvr get <key>` (CLI):
- `files.<name>` before searching for a source file.
- `arch.<area>` before reading code to understand a subsystem.
- `conventions.<topic>` before making style/pattern decisions.

## Write back

When you discover something non-obvious (a gotcha, an architectural decision, a pattern), store it — `reverie_set` / `rvr set <key> <value>` — before the session ends. At session end, consider a `context.next_session` handoff note for the next session's bootstrap banner.

## Do not store

Things derivable from package.json, README, or the code itself. Reverie is for insights that would otherwise be lost between sessions.

## First session (fresh project)

When the bootstrap (`reverie_context` / `rvr context`) returns only scaffold-level entries (no `arch.*`, no `context.*` beyond `context.initialized`), do a deep codebase analysis before the user's task:

1. Read key source files to understand the architecture.
2. Populate `arch.*` with architecture decisions and patterns.
3. Populate `context.*` with non-obvious gotchas and edge cases.
4. Enrich `files.*` with what each key file does.
5. Set `context.initialized` to "complete".

This runs once per project. Keep entries concise — insights, not code.
