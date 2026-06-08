// `rvr manifest` (#117 WS2) — the CLI analog of MCP's tools/list. Introspects
// the live Commander tree so the command/flag surface never drifts from the
// real CLI, and pairs it with the MCP-tool ↔ CLI-command map and the
// self-describing envelope contract (schema version + error codes).

import type { Command } from 'commander';
import { color } from '../formatting';
import { isJsonMode, setResult, ENVELOPE_VERSION, ERROR_CODES } from '../utils/output';
import { getBinaryName } from '../utils/binaryName';

export interface ManifestOption {
  flags: string;
  description: string;
}

export interface ManifestCommand {
  name: string;
  aliases: string[];
  description: string;
  options: ManifestOption[];
  subcommands: ManifestCommand[];
}

export interface Manifest {
  binary: string;
  envelope: { version: string; errorCodes: readonly string[] };
  mcpToolMap: Record<string, string>;
  commands: ManifestCommand[];
}

/**
 * Static MCP-tool → CLI-command map. The 19 MCP tools and their CLI
 * equivalents (see arch.mcp / arch.cli). Lets an agent that knows one surface
 * translate to the other.
 */
export const MCP_CLI_MAP: Record<string, string> = {
  reverie_context: 'context',
  reverie_get: 'get',
  reverie_set: 'set',
  reverie_find: 'find',
  reverie_remove: 'remove',
  reverie_copy: 'copy',
  reverie_rename: 'rename',
  reverie_alias_set: 'alias set',
  reverie_alias_remove: 'alias remove',
  reverie_alias_list: 'alias list',
  reverie_run: 'run',
  reverie_export: 'data export',
  reverie_import: 'data import',
  reverie_reset: 'data reset',
  reverie_config_get: 'config get',
  reverie_config_set: 'config set',
  reverie_stats: 'stats',
  reverie_audit: 'audit',
  reverie_stale: 'stale',
};

// Commander does not expose `hidden` publicly; read the internal flags off a
// loosely-typed view rather than sprinkling `any` through the walker.
interface HiddenFlags { _hidden?: boolean; hidden?: boolean }

function isHidden(obj: unknown): boolean {
  const h = obj as HiddenFlags;
  return h._hidden === true || h.hidden === true;
}

function walkCommand(cmd: Command): ManifestCommand {
  const options: ManifestOption[] = cmd.options
    .filter((o) => !isHidden(o))
    .map((o) => ({ flags: o.flags, description: o.description }));

  const subcommands: ManifestCommand[] = cmd.commands
    .filter((c) => !isHidden(c))
    .map((c) => walkCommand(c));

  return {
    name: cmd.name(),
    aliases: cmd.aliases(),
    description: cmd.description(),
    options,
    subcommands,
  };
}

/** Build the manifest from the live Commander program. */
export function buildManifest(program: Command): Manifest {
  const commands = program.commands
    .filter((c) => !isHidden(c))
    .map((c) => walkCommand(c));
  return {
    binary: getBinaryName(),
    envelope: { version: ENVELOPE_VERSION, errorCodes: ERROR_CODES },
    mcpToolMap: MCP_CLI_MAP,
    commands,
  };
}

function printCommandTree(cmd: ManifestCommand, depth: number): void {
  const indent = '  '.repeat(depth);
  const aliasTag = cmd.aliases.length > 0 ? color.gray(` (${cmd.aliases.join(', ')})`) : '';
  console.log(`${indent}${color.cyan(cmd.name)}${aliasTag}${cmd.description ? color.gray(' — ' + cmd.description) : ''}`);
  for (const sub of cmd.subcommands) {
    printCommandTree(sub, depth + 1);
  }
}

/** Render the manifest: JSON envelope in JSON mode, a readable tree otherwise. */
export function showManifest(program: Command): void {
  const manifest = buildManifest(program);

  if (isJsonMode()) {
    setResult(manifest);
    return;
  }

  console.log(color.bold(`\n${manifest.binary} — command manifest`));
  console.log(color.gray(`envelope schema v${manifest.envelope.version} · error codes: ${manifest.envelope.errorCodes.join(', ')}\n`));
  for (const cmd of manifest.commands) {
    printCommandTree(cmd, 0);
  }
  console.log(color.bold('\nMCP tool → CLI command:'));
  for (const [tool, cli] of Object.entries(manifest.mcpToolMap)) {
    console.log(`  ${color.green(tool.padEnd(22))} ${color.gray('→')} ${color.yellow(cli)}`);
  }
  console.log(color.gray('\nRun with --json (or RVR_OUTPUT=json) for the machine-readable form.\n'));
}
