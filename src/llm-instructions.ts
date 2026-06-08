import { getValue } from './storage';
import { ERROR_CODES } from './utils/output';

export const DEFAULT_LLM_INSTRUCTIONS = `You are connected to a Reverie data store via MCP. This store is a persistent, structured knowledge base for the project you are working on. Use it to learn, record, and share context across sessions and AI agents.

HOW TO USE:
- At session start, call reverie_context to load all stored project knowledge in one call.
- Before exploring the codebase (reading files, searching code), check if the answer is already stored — e.g. reverie_get with key "arch" or "conventions" or "commands".
- When you discover something non-obvious about the project (architecture decisions, gotchas, patterns, key file roles), store it with reverie_set.
- When you find stored information that is outdated or wrong, update it immediately.
- Do NOT store things easily derived from package.json, README, or the code itself. Store insights, decisions, and context that would otherwise be lost between sessions.

SCHEMA (recommended namespaces):
- project.*            — name, description, stack, repo URL
- commands.*           — build, test, lint, deploy commands
- arch.*               — architecture notes, patterns, key decisions
- conventions.*        — coding patterns, naming rules, style notes
- context.*            — non-obvious gotchas, edge cases, historical decisions
- context.next_session — special: short handoff note for the next session's bootstrap. Surfaces in reverie_context as a top banner, auto-labeled "[likely stale]" after 7 days.
- files.*              — key file paths and their roles
- deps.*               — notable dependencies and why they are used

SCOPE:
- If a .reverie/ project store directory exists, reads/writes default to the project scope.
- Use scope: "global" to target the user's personal global store (~/.reverie/store/).
- reverie_get with no key shows project entries by default. Pass all: true to see both scopes.
- If a write tool returns an error with code "PROJECT_UNRESOLVED", project resolution failed (no .reverie/ found). Either run reverie_init to create a project store, or retry with explicit scope: "global" if the entry is genuinely user-level. Reads still fall through to global automatically — only writes refuse.

GUARDRAILS:
- reverie_context may prepend a "[trimmed: ...]" notice when the response would exceed the configured size budget (default 50KB). Listed namespaces were dropped to fit; fetch the specific entries via reverie_get <key>, or call reverie_context with tier:"full" to bypass the budget. project.*, conventions.*, commands.*, deps.*, and context.next_session are never trimmed.
- reverie_context may also prepend a "[warning: ... still exceeds budget after shedding ...]" notice. This means the never-shed namespaces alone are over budget — surface this to the user so they can either raise bootstrap_max_response_bytes via reverie_config_set or audit project.*, conventions.*, commands.*, deps.*, and context.next_session for over-long entries.
- reverie_set may append a "warning: this key has been written N times in this session" line on the 3rd+ write of the same key within 30 minutes. The write succeeded; the warning is a nudge to consider whether the entry has stabilized. Files-style keys (files.*) used as scratch space rather than seeds are the most common trigger — see conventions.seedDensity.

TOOLS (19 total):

Core read/write:
- reverie_context — compact summary of entries (best for session start). Accepts tier: "essential" (minimal), "standard" (default, excludes arch), "full" (everything)
- reverie_get — retrieve specific keys or browse namespaces (use depth: 1 to scan top-level). Shows staleness tags on stale/untracked entries.
- reverie_set — store a key-value pair (use dot notation, keep values concise). Supports encryption via encrypt/password params.
- reverie_find — find entries by keyword. Supports regex, keys-only, values-only filtering.
- reverie_remove — delete an entry by key. Also removes associated aliases.

Aliases:
- reverie_alias_set — create a shortcut name for a dot-notation path (e.g. "chk" -> "commands.check")
- reverie_alias_remove — remove an alias
- reverie_alias_list — list all defined aliases

Execution:
- reverie_run — execute a stored shell command. Supports dry: true for preview, chain: true for &&-chaining multiple keys. If the command requires confirmation, the response will include a one-time confirm_token. Show the command to the user, get approval, then call reverie_run again with that confirm_token to execute.

Data management:
- reverie_copy — copy an entry to a new key
- reverie_rename — rename an entry key or alias
- reverie_export — export entries, aliases, or confirm keys as JSON
- reverie_import — import entries/aliases/confirm from JSON. Supports merge: true and preview: true.
- reverie_reset — clear entries, aliases, confirm keys, audit, or telemetry logs

Configuration:
- reverie_config_get — read config settings (colors, theme, max_backups)
- reverie_config_set — update a config setting

Observability:
- reverie_stats — view usage metrics and token savings: hit rate, net tokens saved (exploration avoided minus delivery cost), per-namespace breakdown with calibration tags (observed vs static cost estimates), trends. Pass detailed: true for full breakdown including calibration status.
- reverie_audit — query the audit log of data mutations and reads (before/after diffs, agent identity, hit/miss tracking). Pass detailed: true for per-entry latency, response sizes, and redundancy flags.
- reverie_stale — find entries not updated recently. Run after reverie_context when starting a new task to audit freshness.

FRESHNESS:
- Entries tagged [untracked] have no update timestamp — treat as the MOST suspect.
- Entries tagged [Nd] haven't been updated in N days — verify before trusting version numbers, URLs, or commands.
- Run reverie_stale after reverie_context to audit knowledge freshness when starting a new task.

PREFER MCP TOOLS (the CLI is the equal-functionality fallback):
- You are connected via MCP — these tools are the preferred surface. Use them rather than reading .reverie/*.json directly. Direct file reads bypass audit logging, alias resolution, interpolation, and scope fallthrough.
- Every MCP tool has an exact \`rvr\` CLI equivalent; the two surfaces are interchangeable, and the CLI is the fallback for agents that cannot run an MCP server. You don't need it here, but if you shell out or hand off to a CLI-only context, \`rvr manifest --json\` is the MCP-tool ↔ CLI-command map and \`rvr config llm-instructions --surface cli\` is the CLI guidance.
- Hand-editing .reverie/*.json files is unsupported — it desyncs per-entry meta (staleness timestamps) and breaks the wrapper format. Use the MCP tools or the \`rvr\` CLI.

EFFECTIVE USAGE:
- Always call reverie_context as your FIRST tool call to bootstrap session knowledge.
- If the project is a GitHub repo, run \`gh issue list --state open\` after reverie_context to see in-flight work. If the user's request relates to an open issue, read its body for context before coding.
- Pick the right tier for the task:
  - tier:"essential" — answering questions, small fixes, single-file edits
  - omit (standard) — multi-file changes, bug fixes, new features
  - tier:"full" — refactoring subsystems, changing architecture, onboarding to the codebase
- Write back: when you learn something non-obvious, store it before the session ends.
- Hand off: at session end, consider writing context.next_session with a short note about where things stand — what was in-flight, what to pick up, any blockers. The next session's reverie_context will surface it as a top banner. Ephemeral by design; treated as stale after 7 days.
- All mutations are audited — reverie_audit shows what changed, when, and by whom.

FIRST SESSION (fresh project):
- After calling reverie_context, check if the response lacks arch.* entries or contains context.initialized = "scaffold".
- If so, this is a freshly initialized project. Before starting the user's task:
  1. Read key source files (entry points, config, core modules) to understand the architecture.
  2. Populate arch.* entries with architecture decisions, patterns, and key subsystem descriptions.
  3. Populate context.* entries with non-obvious gotchas, edge cases, and historical decisions you discover.
  4. Enrich files.* entries with descriptions of what each key file does (not just its path).
  5. Update context.initialized to "complete" when done.
- This deep analysis runs once. Subsequent sessions benefit from the populated knowledge base.
- Keep entries concise (1-2 sentences). Store insights, not code.`;

/**
 * CLI-surface instructions (#117 WS2). The same bootstrap discipline as the
 * MCP blob, but phrased for an agent that drives Reverie through the `rvr`
 * CLI — the only path available to the MCP-banned cohort #117 serves. The MCP
 * blob's "PREFER MCP TOOLS" guidance is actively wrong for a CLI agent (it
 * cannot reach those tools); this version points at `rvr <cmd> --json` and
 * `RVR_OUTPUT=json` for structured output, and `rvr manifest --json` for
 * discovery. Keep the two blobs in sync when the workflow changes.
 */
export const CLI_LLM_INSTRUCTIONS = `You are working with a Reverie data store via the \`rvr\` command-line tool. This store is a persistent, structured knowledge base for the project you are working on. Use it to learn, record, and share context across sessions and AI agents.

STRUCTURED OUTPUT (for agents):
- Pass \`--json\` to any command, or set \`RVR_OUTPUT=json\` once for the whole session, to get a single machine-readable envelope on stdout: { "reverie": "1", "ok": true|false, "command": "...", "result": ..., "warnings": [{ "code": ..., "message": ... }], "error": { "code": ..., "message": ..., "preview": ... } }.
- On failure, "ok" is false, "error.code" is from a frozen set (${ERROR_CODES.join(', ')}), and the process exits non-zero. Branch on "error.code", not on prose.
- Diagnostics and prompts go to stderr; stdout carries only the one envelope. Run \`rvr manifest --json\` to discover every command, flag, and the MCP-tool↔CLI-command map.

HOW TO USE:
- At session start, run \`rvr context\` to load all stored project knowledge in one call.
- Before exploring the codebase (reading files, searching code), check if the answer is already stored — e.g. \`rvr get arch\` or \`rvr get conventions\` or \`rvr get commands\`.
- When you discover something non-obvious about the project (architecture decisions, gotchas, patterns, key file roles), store it with \`rvr set <key> <value>\`.
- When you find stored information that is outdated or wrong, update it immediately.
- Do NOT store things easily derived from package.json, README, or the code itself. Store insights, decisions, and context that would otherwise be lost between sessions.

SCHEMA (recommended namespaces):
- project.*            — name, description, stack, repo URL
- commands.*           — build, test, lint, deploy commands
- arch.*               — architecture notes, patterns, key decisions
- conventions.*        — coding patterns, naming rules, style notes
- context.*            — non-obvious gotchas, edge cases, historical decisions
- context.next_session — special: short handoff note for the next session's bootstrap. Surfaces in \`rvr context\` as a top banner, auto-labeled "[likely stale]" after 7 days.
- files.*              — key file paths and their roles
- deps.*               — notable dependencies and why they are used

SCOPE:
- If a .reverie/ project store directory exists, reads/writes default to the project scope.
- Use \`--global\` (-G) to target the user's personal global store (~/.reverie/store/).
- \`rvr get\` with no key shows project entries by default. Add \`--all\` (-A) to see both scopes.
- If a write fails with error code PROJECT_UNRESOLVED, project resolution failed (no .reverie/ found). Either run \`rvr init\` to create a project store, or retry with \`--global\` if the entry is genuinely user-level. Reads still fall through to global automatically — only writes refuse.

GUARDRAILS:
- \`rvr context\` may add a "[trimmed: ...]" warning when the response would exceed the configured size budget (default 50KB). Listed namespaces were dropped to fit; fetch the specific entries via \`rvr get <key>\`, or run \`rvr context --tier full\` to bypass the budget. project.*, conventions.*, commands.*, deps.*, and context.next_session are never trimmed.
- In JSON mode these notices appear in the envelope's "warnings" array (and "result.degraded"/"result.shedNamespaces").

EXECUTION:
- \`rvr run <key>\` executes a stored shell command. Use \`--dry\` to preview without running, \`--chain\` to &&-chain multiple keys.
- If a command requires confirmation, \`rvr run <key>\` (without \`--yes\`) refuses with error code REQUIRES_CONFIRMATION and the resolved command in "error.preview". Show it to the user, get approval, then re-run with \`--yes\`. (There is no token to pass back — you own the permission gate.)

DO NOT HAND-EDIT THE STORE:
- Always interact with Reverie via \`rvr\` (or the MCP tools when available), never by reading or writing .reverie/*.json directly.
- Direct file reads/writes bypass audit logging, alias resolution, interpolation, and scope fallthrough, and desync per-entry staleness metadata.

EFFECTIVE USAGE:
- Run \`rvr context\` as your FIRST step to bootstrap session knowledge.
- If the project is a GitHub repo, run \`gh issue list --state open\` after \`rvr context\` to see in-flight work. If the user's request relates to an open issue, read its body before coding.
- Pick the right tier: \`rvr context --tier essential\` (small fixes), \`rvr context\` (standard — most work), \`rvr context --tier full\` (refactors, onboarding).
- Write back: when you learn something non-obvious, store it before the session ends.
- Hand off: at session end, consider \`rvr set context.next_session "<where things stand>"\` — the next session's \`rvr context\` surfaces it as a banner. Ephemeral; treated as stale after 7 days.
- Audit freshness with \`rvr stale\` after \`rvr context\` when starting a new task. Entries tagged [untracked] or [Nd] are the most suspect — verify versions, URLs, and commands before trusting them.

FIRST SESSION (fresh project):
- After \`rvr context\`, if the response lacks arch.* entries or contains context.initialized = "scaffold", this is a freshly initialized project. Before the user's task: read key source files, populate arch.* (decisions/patterns), context.* (gotchas/edge cases), enrich files.* (what each key file does), then set context.initialized to "complete". This deep analysis runs once. Keep entries concise (1-2 sentences) — insights, not code.`;

/**
 * Get the custom LLM instructions from the data store, if any.
 * Returns undefined if not set.
 */
export function getCustomInstructions(): string | undefined {
  try {
    const val = getValue('system.llm.instructions');
    return typeof val === 'string' ? val : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Assemble the effective LLM instructions for a given surface: built-in
 * defaults + optional custom section. Custom instructions are appended as a
 * PROJECT CONTEXT block, not a replacement.
 *
 * @param surface 'mcp' (default — the MCP server handshake) or 'cli' (the
 *   `rvr`-driven workflow for agents that cannot run an MCP server, #117 WS2).
 */
export function getEffectiveInstructions(surface: 'mcp' | 'cli' = 'mcp'): string {
  const base = surface === 'cli' ? CLI_LLM_INSTRUCTIONS : DEFAULT_LLM_INSTRUCTIONS;
  const custom = getCustomInstructions();
  if (!custom) return base;
  return `${base}\n\nPROJECT CONTEXT:\n${custom}`;
}
