// Unit tests for `rvr manifest` introspection (#117 WS2).

import { describe, it, expect } from 'bun:test';
import { Command } from 'commander';
import { buildManifest, MCP_CLI_MAP } from '../commands/manifest';
import { ENVELOPE_VERSION, ERROR_CODES } from '../utils/output';

function makeProgram(): Command {
  const program = new Command();
  program.name('rvr');
  program.command('get [key]').alias('g').description('get an entry')
    .option('-j, --json', 'json output');
  const alias = program.command('alias').description('manage aliases');
  alias.command('set <name> <path>').description('create an alias');
  program.command('search <term>', { hidden: true }).description('hidden alias for find');
  return program;
}

describe('buildManifest (#117 WS2)', () => {
  it('introspects the live command tree', () => {
    const m = buildManifest(makeProgram());
    const get = m.commands.find(c => c.name === 'get');
    expect(get).toBeDefined();
    expect(get?.aliases).toContain('g');
    expect(get?.description).toBe('get an entry');
    expect(get?.options.some(o => o.flags.includes('--json'))).toBe(true);
  });

  it('includes nested subcommands', () => {
    const m = buildManifest(makeProgram());
    const alias = m.commands.find(c => c.name === 'alias');
    expect(alias?.subcommands.some(s => s.name === 'set')).toBe(true);
  });

  it('omits hidden commands', () => {
    const m = buildManifest(makeProgram());
    expect(m.commands.some(c => c.name === 'search')).toBe(false);
  });

  it('embeds the envelope contract (schema version + error codes)', () => {
    const m = buildManifest(makeProgram());
    expect(m.envelope.version).toBe(ENVELOPE_VERSION);
    expect(m.envelope.errorCodes).toEqual(ERROR_CODES);
  });

  it('maps all 19 MCP tools to CLI commands', () => {
    const m = buildManifest(makeProgram());
    expect(Object.keys(m.mcpToolMap)).toHaveLength(19);
    expect(m.mcpToolMap).toBe(MCP_CLI_MAP);
    expect(m.mcpToolMap.reverie_alias_set).toBe('alias set');
    expect(m.mcpToolMap.reverie_context).toBe('context');
  });
});
