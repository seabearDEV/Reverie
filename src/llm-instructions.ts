import { getValue } from './storage';
import { ERROR_CODES } from './utils/output';

// ≤2KB hard cap (#126): MCP clients truncate server instructions around
// 2KB, so anything past that is authored for nobody. Front-load the loop;
// tool descriptions and docs/schema-guide.md carry the depth. A size
// regression test enforces the cap — if you add a line here, cut one.
export const DEFAULT_LLM_INSTRUCTIONS = `You are connected to a Reverie store via MCP — a persistent project knowledge base shared across sessions and agents.

THE LOOP:
1. Bootstrap: call reverie_context FIRST every session. Tiers: "essential" (small fixes), standard (default), "full" (refactors/onboarding). In a GitHub repo, follow with \`gh issue list --state open\`.
2. Check before exploring: before reading or searching code, try reverie_get / reverie_find — arch.*, conventions.*, commands.*, files.* may already hold the answer.
3. Write back: store non-obvious discoveries (decisions, gotchas, patterns) with reverie_set before the session ends; update or remove anything outdated. Do NOT store what package.json/README/code already says. Entries are seeds — concise insights, not code.
4. Hand off: at session end consider setting context.next_session ("where things stand") — the next bootstrap surfaces it as a banner; auto-stale after 7 days.

NAMESPACES: project.* commands.* arch.* conventions.* context.* (gotchas) files.* deps.*. Full schema + tier guidance: docs/schema-guide.md in the Reverie repo.

SCOPE: the .reverie/ project store is the default when present; scope:"global" targets ~/.reverie/store. Writes refuse with PROJECT_UNRESOLVED when no project resolves — run reverie_init or retry with scope:"global". Reads fall through automatically.

WARNINGS ARE ACTIONABLE: "[trimmed: ...]" = size budget shed (fetch dropped keys via reverie_get, or tier:"full"); "warning: ... written N times" = write-amplification (let entries stabilize). Entries tagged [Nd]/[untracked] are freshness-suspect — verify before trusting; reverie_stale audits this.

NEVER hand-edit .reverie/*.json — it desyncs entry metadata. Use these tools or the \`rvr\` CLI (exact 1:1 equivalent; map via \`rvr manifest --json\`).

FRESH PROJECT: if bootstrap lacks arch.* or has context.initialized="scaffold", read key sources, populate arch./context./files. entries, then set context.initialized="complete".`;

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
- Set \`RVR_SESSION=<any-id>\` once per agent session so separate \`rvr\` invocations count as one session: write-amplification warnings (3rd+ write of a key in 30min) land in \`warnings[]\` with code WRITE_AMP, and miss-path telemetry works across invocations — the same session guardrails MCP agents get.

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
- \`rvr context\` may add a "[trimmed: ...]" warning when the response would exceed the configured size budget (default 38KB). Listed namespaces were dropped to fit; fetch the specific entries via \`rvr get <key>\`, or run \`rvr context --tier full\` to bypass the budget. project.*, conventions.*, commands.*, deps.*, and context.next_session are never trimmed.
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
