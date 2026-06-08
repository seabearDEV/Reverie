## Reverie store

This project keeps durable, cross-session knowledge in a Reverie store (`.reverie/`). Two interchangeable surfaces reach it with the **same functionality — prefer MCP, fall back to the CLI**:

- **MCP tools** — `reverie_context`, `reverie_get`, `reverie_set`, `reverie_find`, … Use these whenever an MCP server is connected.
- **`rvr` CLI** — `rvr context`, `rvr get`, `rvr set`, `rvr find`, … Use this when MCP is unavailable. Every MCP tool has an exact `rvr` equivalent: run `rvr manifest --json` for the full MCP-tool ↔ CLI-command map, and `rvr config llm-instructions --surface cli` for CLI specifics (the `--json` envelope, scope flags, confirm flow).

CLI commands emit a single machine-readable envelope with `--json` (or `RVR_OUTPUT=json`): `{ "reverie": "1", "ok": true, "command": "…", "result": …, "error": { "code": … }, "warnings": [] }`. Branch on `error.code`, not on prose.

Never hand-edit `.reverie/*.json` directly — it desyncs per-entry meta and breaks staleness signals (see `conventions.editSurface` in the store). The supported edit paths are the MCP tools, the `rvr` CLI, and (eventually) a dedicated UI.

## Bootstrap

1. Load all stored project knowledge first — `reverie_context` (MCP) or `rvr context` (CLI).
2. Run `gh issue list --state open` to see in-flight work — if the user's request relates to an open issue, read its body for context before coding.

## Before exploring code

Check the store before globbing/grepping or reading code — `reverie_get <key>` (MCP) or `rvr get <key>` (CLI):
- `files.<name>` before searching for a source file.
- `arch.<area>` before reading code to understand a subsystem.
- `conventions.<topic>` before making style/pattern decisions.

## Write back

When you discover something non-obvious (a gotcha, an architectural decision, a pattern), store it — `reverie_set` / `rvr set <key> <value>` — before the session ends. Future sessions benefit from what you learn now.

## Write seeds, not encyclopedias

Reverie entries are seeds — small inputs that select rich regions of the LLM's pretrained terrain, not stores that hold the terrain itself. Optimize for **activation per byte**, not completeness. Before writing an entry, ask: *does this seed land somewhere the LLM couldn't have reached on its own?* If no, skip it. If yes, the byte cost is justified. See `conventions.seedDensity` for the full principle and `project.seedRoadmap` for the development plan that follows from it.

## Do not store

Things derivable from `package.json`, `README.md`, or the code itself. Reverie is for insights that would otherwise be lost between sessions.
