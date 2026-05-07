import { getValue } from './storage';

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

PREFER MCP TOOLS:
- Always interact with Reverie via MCP tools (reverie_get, reverie_set, reverie_find, etc.) rather than reading .reverie/*.json directly.
- Direct file reads bypass audit logging, alias resolution, interpolation, and scope fallthrough.
- Hand-editing .reverie/*.json files is unsupported — it desyncs per-entry meta (staleness timestamps) and breaks the wrapper format. Use the CLI or MCP tools.

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
 * Assemble the effective LLM instructions: built-in defaults + optional custom section.
 * Custom instructions are appended as a PROJECT CONTEXT block, not a replacement.
 */
export function getEffectiveInstructions(): string {
  const custom = getCustomInstructions();
  if (!custom) return DEFAULT_LLM_INSTRUCTIONS;
  return `${DEFAULT_LLM_INSTRUCTIONS}\n\nPROJECT CONTEXT:\n${custom}`;
}
