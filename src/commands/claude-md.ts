import fs from 'fs';
import path from 'path';
import { printSuccess, printWarning } from './helpers';

/**
 * Shared operational core for both agent-instruction files (#121).
 *
 * CLAUDE.md and AGENTS.md are read from disk BEFORE an agent knows which
 * surface it has, so each must carry the full either-surface decision — they
 * must NOT be split by surface. That split was the bug: a CLAUDE.md that
 * only described MCP left an MCP-banned Claude agent with no path, even though
 * the `rvr` CLI offers identical functionality. The two *fetchable* instruction
 * blobs in llm-instructions.ts stay surface-specific because they are delivered
 * THROUGH a surface (MCP handshake vs `rvr config llm-instructions`); these
 * files are not. Keep this core as the single source — the per-file wrappers
 * below differ only in their title framing.
 *
 * Guidance posture (project.surfaceStrategy, post-#119/#124-#127 parity):
 * "same store, either surface" — not "prefer MCP". MCP earns writes via
 * schema-validated params; the CLI earns filterable reads via pipes.
 */
export const REVERIE_CORE_GUIDE = `## Reverie store

This project keeps durable, cross-session knowledge in a Reverie store (\`.reverie/\`). Two interchangeable surfaces reach it — **same store, same functionality, either surface**:

- **MCP tools** — \`reverie_context\`, \`reverie_get\`, \`reverie_set\`, \`reverie_find\`, … Schema-validated params make these the safest write path; use them whenever an MCP server is connected.
- **\`rvr\` CLI** — \`rvr context\`, \`rvr get\`, \`rvr set\`, \`rvr find\`, … The only path when MCP is unavailable, and the better read path when you'd filter — pipe \`--json\` output (e.g. through \`jq\`) so only the distilled answer enters context. Every MCP tool has an exact \`rvr\` equivalent: run \`rvr manifest --json\` for the full MCP-tool ↔ CLI-command map, and \`rvr config llm-instructions --surface cli\` for CLI specifics (the \`--json\` envelope, scope flags, confirm flow, \`RVR_SESSION\`).

CLI commands emit a single machine-readable envelope with \`--json\` (or \`RVR_OUTPUT=json\`): \`{ "reverie": "1", "ok": true, "command": "…", "result": …, "error": { "code": … }, "warnings": [] }\`. Branch on \`error.code\`, not on prose. (One exception: \`rvr audit --follow --json\` streams raw NDJSON rows, no envelope.)

Never hand-edit \`.reverie/*.json\` directly — that bypasses audit logging, alias resolution, interpolation, and staleness metadata. Use the MCP tools or \`rvr\` only.

## Bootstrap

1. Load the front page first — \`reverie_context\` (MCP) or \`rvr context\` (CLI): pinned namespaces in full, a one-line gist for every other entry. Open an entry (\`reverie_get\` / \`rvr get <key>\`) when its gist is relevant to the task.
2. If this is a git repo, run \`gh issue list --state open\` and read any issue related to the user's request before coding.

## Before exploring code

Check the store before globbing/grepping or reading code — \`reverie_get <key>\` (MCP) or \`rvr get <key>\` (CLI):
- \`files.<name>\` before searching for a source file.
- \`arch.<area>\` before reading code to understand a subsystem.
- \`conventions.<topic>\` before making style/pattern decisions.

## Write back

When you discover something non-obvious (a gotcha, an architectural decision, a pattern), store it — \`reverie_set\` / \`rvr set <key> <value>\` — before the session ends. At session end, consider a \`context.next_session\` handoff note for the next session's bootstrap banner.

## Do not store

Things derivable from package.json, README, or the code itself. Reverie is for insights that would otherwise be lost between sessions.`;

/**
 * First-session deep-analysis block, appended to both files. Surface-neutral so
 * it reads the same whether the agent drives Reverie via MCP or the CLI.
 */
export const REVERIE_FIRST_SESSION = `## First session (fresh project)

When the bootstrap (\`reverie_context\` / \`rvr context\`) returns only scaffold-level entries (no \`arch.*\`, no \`context.*\` beyond \`context.initialized\`), do a deep codebase analysis before the user's task:

1. Read key source files to understand the architecture.
2. Populate \`arch.*\` with architecture decisions and patterns.
3. Populate \`context.*\` with non-obvious gotchas and edge cases.
4. Enrich \`files.*\` with what each key file does.
5. Set \`context.initialized\` to "complete".

This runs once per project. Keep entries concise — insights, not code.`;

/**
 * CLAUDE.md — Claude Code reads this file. Starts directly with the shared core
 * (no title, matching Claude's project-instructions convention).
 */
export const CLAUDE_MD_TEMPLATE = `${REVERIE_CORE_GUIDE}

${REVERIE_FIRST_SESSION}
`;

/**
 * AGENTS.md — the emerging cross-agent convention (Cursor, Copilot, Gemini,
 * Codex all read it). Same operational core as CLAUDE.md, agent-agnostic title.
 * It deliberately names BOTH surfaces (same store, either surface) so an
 * agent without MCP still finds the identical CLI path.
 */
export const AGENTS_MD_TEMPLATE = `# Reverie — agent guide

${REVERIE_CORE_GUIDE}

${REVERIE_FIRST_SESSION}
`;

/**
 * Generate a CLAUDE.md file in the given directory.
 *
 * @returns The written content, or null if skipped.
 */
export function generateClaudeMd(options: {
  cwd?: string | undefined;
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
} = {}): string | null {
  const cwd = options.cwd ?? process.cwd();
  const target = path.join(cwd, 'CLAUDE.md');

  const content = CLAUDE_MD_TEMPLATE;

  if (options.dryRun) {
    return content;
  }

  if (fs.existsSync(target) && !options.force) {
    printWarning('CLAUDE.md already exists. Use --force to overwrite.');
    return null;
  }

  fs.writeFileSync(target, content, { encoding: 'utf8' });
  printSuccess(`Created: ${target}`);
  return content;
}

/**
 * Generate an agent-agnostic AGENTS.md file in the given directory (#117 WS2).
 *
 * @returns The written content, or null if skipped.
 */
export function generateAgentsMd(options: {
  cwd?: string | undefined;
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
} = {}): string | null {
  const cwd = options.cwd ?? process.cwd();
  const target = path.join(cwd, 'AGENTS.md');

  const content = AGENTS_MD_TEMPLATE;

  if (options.dryRun) {
    return content;
  }

  if (fs.existsSync(target) && !options.force) {
    printWarning('AGENTS.md already exists. Use --force to overwrite.');
    return null;
  }

  fs.writeFileSync(target, content, { encoding: 'utf8' });
  printSuccess(`Created: ${target}`);
  return content;
}
