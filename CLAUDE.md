## Bootstrap

Call `codex_context` as your first tool call to load all stored project knowledge. Then run `gh issue list --state open` to see in-flight work — if the user's request relates to an open issue, read its body for context before coding.

## Prefer MCP tools over direct file reads

Always use Reverie MCP tools (`codex_get`, `codex_set`, `codex_search`, etc.) to interact with the project store at `.codexcli/`. Direct file reads bypass audit logging, alias resolution, interpolation, and staleness metadata, and hand-editing `.codexcli/*.json` is **unsupported** — it desyncs per-entry meta and breaks staleness signals (see `conventions.editSurface` in the codex). The supported edit paths are CLI, MCP tools, and (eventually) a dedicated UI.

## Before exploring code

- Check `codex_get` with key `files.<name>` before globbing/grepping for a source file.
- Check `codex_get` with key `arch.<area>` before reading code to understand a subsystem.
- Check `codex_get` with key `conventions.<topic>` before making style/pattern decisions.

## Write back

When you discover something non-obvious (a gotcha, an architectural decision, a pattern), store it with `codex_set` before the session ends. Future sessions benefit from what you learn now.

## Write seeds, not encyclopedias

Codex entries are seeds — small inputs that select rich regions of the LLM's pretrained terrain, not stores that hold the terrain itself. Optimize for **activation per byte**, not completeness. Before writing an entry, ask: *does this seed land somewhere the LLM couldn't have reached on its own?* If no, skip it. If yes, the byte cost is justified. See `conventions.seedDensity` for the full principle and `project.seedRoadmap` for the development plan that follows from it.

## Do not store

Things derivable from `package.json`, `README.md`, or the code itself. The codex is for insights that would otherwise be lost between sessions.
