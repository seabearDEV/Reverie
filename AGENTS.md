# Reverie — agent guide

## Reverie store

This project keeps durable, cross-session knowledge in a Reverie store (`.reverie/`). **Fleet policy: transport follows capability.**

- **`rvr` CLI** — the uniform surface for every shell-capable agent (Claude Code, Codex, …): `rvr context`, `rvr get`, `rvr set`, `rvr find`, … Pipe `--json` output (e.g. through `jq`) so only the distilled answer enters context. Run `rvr manifest --json` for the full command map and `rvr config llm-instructions --surface cli` for CLI specifics (the `--json` envelope, scope flags, confirm flow, `RVR_SESSION`).
- **MCP server** (`rvr mcp-server`) — for shell-less surfaces only (e.g. Claude Cowork/Desktop), registered at the app level. Do not add project-level MCP config (`.mcp.json`); shell agents use the CLI.

Attribution: each agent's harness sets `RVR_AGENT_NAME` (`sol` = Codex, `fable` = Claude Code) so audit/telemetry rows identify the writer.

CLI commands emit a single machine-readable envelope with `--json` (or `RVR_OUTPUT=json`): `{ "reverie": "1", "ok": true, "command": "…", "result": …, "error": { "code": … }, "warnings": [] }`. Branch on `error.code`, not on prose.

Never hand-edit `.reverie/*.json` directly — that bypasses audit logging, alias resolution, interpolation, and staleness metadata (see `conventions.editSurface` in the store). Use `rvr` (or, on shell-less surfaces, the MCP tools) only.

## Bootstrap

1. Load all stored project knowledge first — `rvr context`.
2. If this is a git repo, run `gh issue list --state open` and read any issue related to the user's request before coding.

## Before exploring code

Check the store before globbing/grepping or reading code — `rvr get <key>`:
- `files.<name>` before searching for a source file.
- `arch.<area>` before reading code to understand a subsystem.
- `conventions.<topic>` before making style/pattern decisions.

## Write back

When you discover something non-obvious (a gotcha, an architectural decision, a pattern), store it — `rvr set <key> <value>` — before the session ends. At session end, consider a `context.next_session` handoff note for the next session's bootstrap banner.

## Write seeds, not encyclopedias

Reverie entries are seeds — small inputs that select rich regions of the LLM's pretrained terrain, not stores that hold the terrain itself. Optimize for **activation per byte**, not completeness. Before writing an entry, ask: *does this seed land somewhere the LLM couldn't have reached on its own?* If no, skip it. If yes, the byte cost is justified. See `conventions.seedDensity` for the full principle and `project.seedRoadmap` for the development plan that follows from it.

## Do not store

Things derivable from package.json, README, or the code itself. Reverie is for insights that would otherwise be lost between sessions.

## First session (fresh project)

When the bootstrap (`rvr context`) returns only scaffold-level entries (no `arch.*`, no `context.*` beyond `context.initialized`), do a deep codebase analysis before the user's task:

1. Read key source files to understand the architecture.
2. Populate `arch.*` with architecture decisions and patterns.
3. Populate `context.*` with non-obvious gotchas and edge cases.
4. Enrich `files.*` with what each key file does.
5. Set `context.initialized` to "complete".

This runs once per project. Keep entries concise — insights, not code.
