import fs from 'fs';
import path from 'path';
import { printSuccess, printWarning } from './helpers';

export const CLAUDE_MD_TEMPLATE = `## Bootstrap

Call \`reverie_context\` as your first tool call to load all stored project knowledge.

## Prefer MCP tools over direct file reads

Always use Reverie MCP tools (\`reverie_get\`, \`reverie_set\`, \`reverie_find\`, etc.) to interact with the \`.reverie/\` store. Direct file reads bypass audit logging, alias resolution, and interpolation. The only acceptable reason to read \`.reverie/\` files directly is debugging the MCP server itself.

## Before exploring code

- Check \`reverie_get\` with key \`files.<name>\` before globbing/grepping for a source file.
- Check \`reverie_get\` with key \`arch.<area>\` before reading code to understand a subsystem.
- Check \`reverie_get\` with key \`conventions.<topic>\` before making style/pattern decisions.

## Write back

When you discover something non-obvious (a gotcha, an architectural decision, a pattern), store it with \`reverie_set\` before the session ends. Future sessions benefit from what you learn now.

## Do not store

Things derivable from package.json, README, or the code itself. Reverie is for insights that would otherwise be lost between sessions.

## First session (fresh project)

When \`reverie_context\` returns only scaffold-level entries (no \`arch.*\`, no \`context.*\` beyond \`context.initialized\`), perform a deep codebase analysis before starting the user's task:

1. Read key source files to understand the architecture
2. Populate \`arch.*\` with architecture decisions and patterns
3. Populate \`context.*\` with non-obvious gotchas and edge cases
4. Enrich \`files.*\` with descriptions of what each key file does
5. Update \`context.initialized\` to "complete"

This runs once per project. Keep entries concise — insights, not code.
`;

/**
 * Agent-agnostic project file (#117 WS2). AGENTS.md is the emerging
 * cross-agent convention (Claude, Cursor, Copilot, Gemini all read it). Unlike
 * CLAUDE.md, it describes the CLI-driven workflow — the path available to
 * agents that cannot run an MCP server. Keep it in sync with
 * CLI_LLM_INSTRUCTIONS in src/llm-instructions.ts.
 */
export const AGENTS_MD_TEMPLATE = `# Reverie (agent guide)

This project stores its durable, cross-session knowledge in a Reverie store
(\`.reverie/\`). Use the \`rvr\` CLI to read and write it — never edit
\`.reverie/*.json\` by hand (that bypasses audit, alias resolution,
interpolation, and staleness metadata).

## Structured output

Pass \`--json\` to any command, or set \`RVR_OUTPUT=json\` once for the session,
to get a single machine-readable envelope on stdout:

\`\`\`json
{ "reverie": "1", "ok": true, "command": "get", "result": { "...": "..." }, "warnings": [] }
\`\`\`

On failure \`ok\` is \`false\`, \`error.code\` is from a frozen set
(\`NOT_FOUND\`, \`INVALID_INPUT\`, \`PROJECT_UNRESOLVED\`,
\`REQUIRES_CONFIRMATION\`, \`DECRYPT_FAILED\`, \`ENCRYPTED_NO_PASSWORD\`, \`IO\`,
\`RUNTIME\`), and the process exits non-zero. Diagnostics go to stderr; stdout
carries only the envelope. Run \`rvr manifest --json\` to discover every command
and the MCP-tool ↔ CLI-command map.

## Bootstrap

1. Run \`rvr context\` first to load stored project knowledge in one call.
2. If this is a git repo, run \`gh issue list --state open\` and read any issue
   related to the user's request before coding.

## Before exploring code

- \`rvr get files.<name>\` before globbing/grepping for a source file.
- \`rvr get arch.<area>\` before reading code to understand a subsystem.
- \`rvr get conventions.<topic>\` before making style/pattern decisions.

## Write back

When you discover something non-obvious (a gotcha, a decision, a pattern),
store it with \`rvr set <key> <value>\` before the session ends. At session end,
consider \`rvr set context.next_session "<where things stand>"\` for the next
session's bootstrap banner.

## Do not store

Things derivable from package.json, README, or the code itself. Reverie is for
insights that would otherwise be lost between sessions.
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
