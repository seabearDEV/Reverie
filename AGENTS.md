# Reverie (agent guide)

This project stores its durable, cross-session knowledge in a Reverie store
(`.reverie/`). Use the `rvr` CLI to read and write it — never edit
`.reverie/*.json` by hand (that bypasses audit, alias resolution,
interpolation, and staleness metadata).

## Structured output

Pass `--json` to any command, or set `RVR_OUTPUT=json` once for the session,
to get a single machine-readable envelope on stdout:

```json
{ "reverie": "1", "ok": true, "command": "get", "result": { "...": "..." }, "warnings": [] }
```

On failure `ok` is `false` and `error.code` is from a frozen set
(PROJECT_UNRESOLVED, NOT_FOUND, INVALID_INPUT, REQUIRES_CONFIRMATION, ENCRYPTED_NO_PASSWORD, DECRYPT_FAILED, COMMAND_FAILED, INPUT_REQUIRED, IO, RUNTIME), and the process exits non-zero. Diagnostics go to stderr; stdout
carries only the envelope. Run `rvr manifest --json` to discover every command
and the MCP-tool ↔ CLI-command map.

## Bootstrap

1. Run `rvr context` first to load stored project knowledge in one call.
2. If this is a git repo, run `gh issue list --state open` and read any issue
   related to the user's request before coding.

## Before exploring code

- `rvr get files.<name>` before globbing/grepping for a source file.
- `rvr get arch.<area>` before reading code to understand a subsystem.
- `rvr get conventions.<topic>` before making style/pattern decisions.

## Write back

When you discover something non-obvious (a gotcha, a decision, a pattern),
store it with `rvr set <key> <value>` before the session ends. At session end,
consider `rvr set context.next_session "<where things stand>"` for the next
session's bootstrap banner.

## Do not store

Things derivable from package.json, README, or the code itself. Reverie is for
insights that would otherwise be lost between sessions.
