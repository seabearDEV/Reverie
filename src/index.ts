#!/usr/bin/env bun

import { Command, Option } from 'commander';
import * as commands from './commands';
import { removeAlias, resolveKey, loadAliases, setAlias, renameAlias } from './alias';
import { setConfirm, removeConfirm, loadConfirmKeys } from './confirm';
import { color } from './formatting';
import { showHelp, showExamples } from './formatting';
import { askPassword, askConfirmation, printError } from './commands/helpers';
import { version } from '../package.json';
import { getCompletions, generateBashScript, generateZshScript, installCompletions } from './completions';
import { withPager } from './utils/pager';
import { getDataDirectory } from './utils/paths';
import { getBinaryName } from './utils/binaryName';
import fs from 'fs';
import { DEFAULT_LLM_INSTRUCTIONS, CLI_LLM_INSTRUCTIONS, getEffectiveInstructions } from './llm-instructions';
import { withCliInstrumentation } from './utils/instrumentation';
import { configureOutput, resolveJsonMode, isJsonMode, emitEnvelope, alreadyEmitted, setResult } from './utils/output';

// Early-exit handler for shell tab-completion (must run before Commander parses args)
const completionFlagIndex = process.argv.indexOf('--get-completions');
if (completionFlagIndex !== -1) {
  const compLine = process.argv[completionFlagIndex + 1] || '';
  const compPoint = parseInt(process.argv[completionFlagIndex + 2] || '0', 10) || compLine.length;
  getCompletions(compLine, compPoint).forEach(r =>
    console.log(`${r.value}\t${r.description}\t${r.group}`)
  );
  process.exit(0);
}

// Initialize the CLI
const reverie = new Command();
reverie.name(getBinaryName());
reverie.version(version);
reverie.description('Bicameral memory for AI-assisted development — persistent project context across sessions');

reverie.helpCommand(false);

// Add global debug option
reverie.option('--debug', 'Enable debug mode')
  .hook('preAction', (thisCommand) => {
    if (thisCommand.opts().debug) {
      process.env.DEBUG = 'true';
    }
  });

// Global structured-output flag (#117 WS1). `rvr --json <cmd>` or the
// session-wide RVR_OUTPUT=json env var make every command emit one versioned
// envelope on stdout. Read commands also keep their local `-j, --json` for
// `rvr get foo -j` ergonomics; optsWithGlobals() merges both sources.
reverie.option('--json', 'Emit a structured JSON envelope on stdout (or set RVR_OUTPUT=json)');

// Configure the output layer before every action runs. actionCommand is the
// leaf command; we build a space-joined name (e.g. "alias set") for the
// envelope's `command` field, and resolve JSON mode from the merged flag + env.
reverie.hook('preAction', (_thisCommand, actionCommand) => {
  const names: string[] = [];
  for (let c: typeof actionCommand | null = actionCommand; c?.parent; c = c.parent) {
    names.unshift(c.name());
  }
  const json = resolveJsonMode(actionCommand.optsWithGlobals().json as boolean | undefined);
  configureOutput({ json, command: names.join(' ') });
});

// Set command
reverie
  .command('set <key> [value...]')
  .alias('s')
  .description('Set an entry, or batch set with key=val pairs')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('-e, --encrypt', 'Encrypt the value with a password')
  .option('-a, --alias <name>', 'Create an alias for this key')
  .option('-p, --prompt', 'Read value interactively (avoids shell expansion of $, !, etc.)')
  .option('-s, --show', 'Show input when using --prompt (default is masked)')
  .option('-c, --clear', 'Clear terminal and scrollback after setting (removes sensitive input from history)')
  .option('--confirm', 'Require confirmation before running this entry')
  .option('--no-confirm', 'Remove confirmation requirement from this entry')
  .option('--password-file <path>', 'Read encryption password from the first line of a file (chmod 600)')
  .option('-G, --global', 'Target global data store')
  .action(async (key: string, valueArray: string[], options: { force?: boolean, encrypt?: boolean, alias?: string, prompt?: boolean, show?: boolean, clear?: boolean, confirm?: boolean, global?: boolean, passwordFile?: string }) => {
    const scope = options.global ? 'global' as const : undefined;
    // Batch mode: `set a=1 b=2 c=3`
    if (key.includes('=')) {
      const pairs = [key, ...valueArray];
      for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) {
          printError(`Invalid batch pair '${pair}'. Expected key=value format.`);
          process.exitCode = 1;
          return;
        }
        const k = pair.slice(0, eqIdx);
        const v = pair.slice(eqIdx + 1);
        if (!k) {
          printError(`Invalid batch pair '${pair}'. Key cannot be empty.`);
          process.exitCode = 1;
          return;
        }
        const rk = resolveKey(k);
        await withCliInstrumentation(
          { tool: 'reverie_set', key: rk, rawKey: k, scope, writeValue: v, params: { key: rk, value: v } },
          () => commands.setEntry(rk, v, options.force, undefined, undefined, undefined, options.global)
        );
      }
      return;
    }

    let value: string | undefined;
    if (options.prompt) {
      if (!process.stdin.isTTY) {
        printError('--prompt requires an interactive terminal.');
        process.exitCode = 1;
        return;
      }
      if (options.show) {
        value = await askConfirmation('Value: ');
      } else {
        value = await askPassword('Value: ');
        const confirm = await askPassword('Confirm: ');
        if (value !== confirm) {
          printError('Values do not match.');
          process.exitCode = 1;
          return;
        }
      }
    } else if (valueArray.length === 0) {
      // Read from stdin if piped (non-TTY)
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
        const stdinValue = Buffer.concat(chunks).toString('utf8').trimEnd();
        if (stdinValue.length > 0) {
          value = stdinValue;
        } else if (!options.alias && options.confirm === undefined) {
          printError('No input received from stdin.');
          process.exitCode = 1;
          return;
        }
        // value stays undefined — intentional for alias-only or confirm-only updates
      } else if (!options.alias && options.confirm === undefined) {
        // Allow no value when -a or --confirm/--no-confirm is provided (metadata-only update)
        printError('Missing value. Provide a value or use --prompt (-p) to enter it interactively.');
        process.exitCode = 1;
        return;
      }
    } else {
      value = valueArray.join(' ');
    }
    const resolvedKey = resolveKey(key);
    await withCliInstrumentation(
      { tool: 'reverie_set', key: resolvedKey, rawKey: key, scope, writeValue: value, params: { key: resolvedKey, value: value ?? '' } },
      () => commands.setEntry(resolvedKey, value, options.force, options.encrypt, options.alias, options.confirm, options.global, options.passwordFile)
    );
    if (options.clear) {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    }
  });

// Get command
reverie
  .command('get [key]')
  .alias('g')
  .description('List keys or retrieve entries (-v for values)')
  .option('-t, --tree', 'Display data in a hierarchical tree structure')
  .option('-p, --plain', 'Output plain text without colors (for scripting)')
  .option('-s, --source', 'Show stored value before interpolation')
  .option('-d, --decrypt', 'Decrypt an encrypted value (prompts for password)')
  .option('--password-file <path>', 'Read decryption password from the first line of a file (chmod 600)')
  .option('-c, --copy', 'Copy value to clipboard')
  .addOption(new Option('-a, --aliases', 'Show aliases only — use `alias list` instead').hideHelp())
  .option('-v, --values', 'Include values in output')
  .option('-k, --depth <n>', 'Limit key depth (e.g. -k 1 for top-level only)', parseInt)
  .option('-j, --json', 'Output as JSON (for scripting)')
  .option('-G, --global', 'Target global data store')
  .option('-A, --all', 'Show entries from all scopes (project + global)')
  .action(async (key: string | undefined, options: { tree?: boolean, plain?: boolean, source?: boolean, decrypt?: boolean, copy?: boolean, aliases?: boolean, values?: boolean, depth?: number, json?: boolean, global?: boolean, all?: boolean, passwordFile?: string }) => {
    if (options.aliases) console.error(color.yellow('Deprecation: use `alias list` instead of `get -a`.'));
    const scope = options.global ? 'global' as const : undefined;
    const resolvedKey = key ? resolveKey(key) : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_get', key: resolvedKey, rawKey: key, scope, params: { key: key ?? '' } },
      () => withPager(() => commands.getEntry(resolvedKey ?? key, options))
    );
  });

// Run command
reverie
  .command('run <keys...>')
  .alias('r')
  .description('Execute stored command(s) (use : to compose, multiple keys &&-chain)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry', 'Print the command without executing')
  .option('-d, --decrypt', 'Decrypt an encrypted command before running')
  .option('--password-file <path>', 'Read decryption password from the first line of a file (chmod 600)')
  .option('-c, --capture', 'Capture output for piping (instead of inheriting stdio)')
  .option('--source', 'Output command to stdout for shell eval (used by shell wrapper)')
  .option('--chain', 'Treat stored value as space-separated key references to resolve and chain')
  .option('-G, --global', 'Target global data store')
  .action(async (keys: string[], options: { yes?: boolean, dry?: boolean, decrypt?: boolean, capture?: boolean, source?: boolean, chain?: boolean, global?: boolean, passwordFile?: string }) => {
    const scope = options.global ? 'global' as const : undefined;
    const resolvedKey = keys[0] ? resolveKey(keys[0], scope) : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_run', key: resolvedKey, rawKey: keys[0], scope, params: { keys } },
      () => commands.runCommand(keys, options)
    );
  });

// Copy command
reverie
  .command('copy <source> <dest>')
  .alias('cp')
  .description('Copy an entry to a new key')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('-G, --global', 'Target global data store')
  .action(async (source: string, dest: string, options: { force?: boolean, global?: boolean }) => {
    const scope = options.global ? 'global' as const : undefined;
    const resolvedSource = resolveKey(source);
    await withCliInstrumentation(
      { tool: 'reverie_copy', key: dest, rawKey: source, scope, copySourceKey: resolvedSource, params: { source: resolvedSource, dest } },
      () => commands.copyEntry(resolvedSource, dest, options.force, options.global)
    );
  });

// Find command
reverie
  .command('find <term>')
  .alias('f')
  .description('Find entries by key or value')
  .option('-e, --entries', 'Search only in data entries')
  .option('-a, --aliases', 'Search only in aliases')
  .option('-t, --tree', 'Display results in a hierarchical tree structure')
  .option('-j, --json', 'Output as JSON (for scripting)')
  .option('-x, --regex', 'Treat search term as a regular expression')
  .option('-k, --keys', 'Search keys only (skip value matching)')
  .option('-v, --values', 'Search values only (skip key matching)')
  .option('-G, --global', 'Target global data store')
  .action(async (term: string, options: { entries?: boolean, aliases?: boolean, tree?: boolean, json?: boolean, regex?: boolean, keys?: boolean, values?: boolean, global?: boolean }) => {
    const scope = options.global ? 'global' as const : undefined;
    await withPager(async () => {
      await withCliInstrumentation(
        { tool: 'reverie_find', key: term, scope, params: { query: term } },
        () => commands.searchEntries(term, options)
      );
    });
  });

// Edit command
reverie
  .command('edit <key>')
  .alias('e')
  .description('Open an entry in $EDITOR for editing')
  .option('-d, --decrypt', 'Decrypt an encrypted value before editing')
  .option('--password-file <path>', 'Read decryption password from the first line of a file (chmod 600)')
  .option('-G, --global', 'Target global data store')
  .action(async (key: string, options: { decrypt?: boolean, global?: boolean, passwordFile?: string }) => {
    const resolvedKey = resolveKey(key);
    await withCliInstrumentation(
      { tool: 'reverie_set', key: resolvedKey, rawKey: key, scope: options.global ? 'global' as const : undefined, params: { key: resolvedKey } },
      () => commands.editEntry(resolvedKey, options)
    );
  });

// Rename command
reverie
  .command('rename <old> <new>')
  .alias('rn')
  .description('Rename an entry key or alias')
  .addOption(new Option('-a, --alias', 'Rename an alias instead of an entry key — use `alias rename` instead').hideHelp())
  .option('--set-alias <name>', 'Set an alias on the renamed key')
  .option('-G, --global', 'Target global data store')
  .action(async (oldName: string, newName: string, options: { alias?: boolean, setAlias?: string, global?: boolean }) => {
    if (options.alias) console.error(color.yellow('Deprecation: use `alias rename <old> <new>` instead of `rename -a`.'));
    const scope = options.global ? 'global' as const : undefined;
    const resolvedOld = options.alias ? oldName : resolveKey(oldName);
    await withCliInstrumentation(
      { tool: 'reverie_rename', key: resolvedOld, rawKey: oldName, scope, params: { oldKey: resolvedOld, newKey: newName } },
      () => options.alias
        ? commands.renameEntry(oldName, newName, true, undefined, options.global)
        : commands.renameEntry(resolvedOld, newName, false, options.setAlias, options.global)
    );
  });

// Remove command
reverie
  .command('remove <key>')
  .alias('rm')
  .description('Remove an entry')
  .addOption(new Option('-a, --alias', 'Remove the alias only (keep the entry) — use `alias remove` instead').hideHelp())
  .option('-f, --force', 'Skip confirmation prompt')
  .option('-G, --global', 'Target global data store')
  .action(async (key: string, options: { alias?: boolean, force?: boolean, global?: boolean }) => {
    if (options.alias) console.error(color.yellow('Deprecation: use `alias remove <name>` instead of `remove -a`.'));
    const tool = options.alias ? 'reverie_alias_remove' : 'reverie_remove';
    const scope = options.global ? 'global' as const : undefined;
    const resolvedKey = options.alias ? key : resolveKey(key);
    await withCliInstrumentation(
      { tool, key: resolvedKey, rawKey: key, scope, params: { key: resolvedKey } },
      async () => {
        if (options.alias) {
          const removed = removeAlias(key, scope);
          if (!removed) {
            printError(`Alias '${key}' not found.`, 'NOT_FOUND');
            return undefined;
          }
          console.log(`Alias '${key}' removed successfully.`);
          return { alias: key, removed: true };
        }
        return await commands.removeEntry(resolvedKey, options.force, options.global);
      }
    );
  });

// ── Alias subcommand group ────────────────────────────────────────────

const aliasCommand = reverie
  .command('alias')
  .description('Manage key aliases');

aliasCommand
  .command('set <name> <path>')
  .description('Create an alias for a key')
  .option('-G, --global', 'Target global data store')
  .action(async (name: string, targetPath: string, options: { global?: boolean }) => {
    const scope = options.global ? 'global' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_alias_set', key: name, scope, params: { alias: name, path: targetPath } },
      () => {
        setAlias(name, targetPath, scope);
        return { alias: name, target: targetPath };
      }
    );
  });

aliasCommand
  .command('remove <name>')
  .description('Remove an alias')
  .option('-G, --global', 'Target global data store')
  .action(async (name: string, options: { global?: boolean }) => {
    const scope = options.global ? 'global' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_alias_remove', key: name, scope, params: { alias: name } },
      () => {
        const removed = removeAlias(name, scope);
        if (!removed) {
          printError(`Alias '${name}' not found.`, 'NOT_FOUND');
          return undefined;
        }
        console.log(`Alias '${name}' removed.`);
        return { alias: name, removed: true };
      }
    );
  });

aliasCommand
  .command('list')
  .description('List all aliases')
  .option('-G, --global', 'Target global data store')
  .option('-A, --all', 'Show aliases from all scopes')
  .action(async (options: { global?: boolean, all?: boolean }) => {
    const scope = options.global ? 'global' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_alias_list', scope, params: {} },
      () => {
        const aliases = loadAliases(scope);
        if (isJsonMode()) {
          setResult({ aliases });
          return;
        }
        if (Object.keys(aliases).length === 0) {
          console.log('No aliases defined.');
        } else {
          for (const [name, target] of Object.entries(aliases)) {
            console.log(`${color.green(name)} ${color.gray('->')} ${color.yellow(target)}`);
          }
        }
      }
    );
  });

aliasCommand
  .command('rename <old> <new>')
  .description('Rename an alias')
  .option('-G, --global', 'Target global data store')
  .action(async (oldName: string, newName: string, options: { global?: boolean }) => {
    const scope = options.global ? 'global' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_alias_set', key: oldName, scope, params: { old: oldName, new: newName } },
      () => {
        const result = renameAlias(oldName, newName, scope);
        if (result) {
          console.log(`Alias '${oldName}' renamed to '${newName}'.`);
          return { from: oldName, to: newName };
        }
        const aliases = loadAliases(scope);
        if (!(oldName in aliases)) {
          printError(`Alias '${oldName}' not found.`, 'NOT_FOUND');
        } else {
          printError(`Alias '${newName}' already exists.`, 'INVALID_INPUT');
        }
        return undefined;
      }
    );
  });

// ── Confirm subcommand group ─────────────────────────────────────────

const confirmCommand = reverie
  .command('confirm')
  .description('Manage run confirmation requirements');

confirmCommand
  .command('set <key>')
  .description('Require confirmation before running this key')
  .option('-G, --global', 'Target global data store')
  .action(async (key: string, options: { global?: boolean }) => {
    const resolvedKey = resolveKey(key);
    const scope = options.global ? 'global' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_confirm_set', key: resolvedKey, rawKey: key, scope, params: { key: resolvedKey } },
      () => {
        setConfirm(resolvedKey, scope);
        console.log(`Entry '${resolvedKey}' now requires confirmation to run.`);
        return { key: resolvedKey, confirm: true };
      }
    );
  });

confirmCommand
  .command('remove <key>')
  .description('Remove confirmation requirement')
  .option('-G, --global', 'Target global data store')
  .action(async (key: string, options: { global?: boolean }) => {
    const resolvedKey = resolveKey(key);
    const scope = options.global ? 'global' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_confirm_remove', key: resolvedKey, rawKey: key, scope, params: { key: resolvedKey } },
      () => {
        removeConfirm(resolvedKey, scope);
        console.log(`Confirmation removed from '${resolvedKey}'.`);
        return { key: resolvedKey, confirm: false };
      }
    );
  });

confirmCommand
  .command('list')
  .description('List keys requiring confirmation')
  .option('-G, --global', 'Target global data store')
  .action(async (options: { global?: boolean }) => {
    const scope = options.global ? 'global' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_confirm_list', scope, params: {} },
      () => {
        const keys = loadConfirmKeys(scope);
        if (isJsonMode()) {
          setResult({ confirmKeys: Object.keys(keys) });
          return;
        }
        if (Object.keys(keys).length === 0) {
          console.log('No keys require confirmation.');
        } else {
          for (const key of Object.keys(keys)) {
            console.log(`  ${color.yellow(key)}`);
          }
        }
      }
    );
  });

// ── Context command ──────────────────────────────────────────────────

reverie
  .command('context')
  .description('Show a compact summary of stored project knowledge')
  .option('-t, --tier <tier>', 'Context tier: essential, standard, full', 'standard')
  .option('-G, --global', 'Target global data store')
  .option('-p, --plain', 'Output plain text without colors')
  .option('-j, --json', 'Output as JSON')
  .option('--size-only', 'Report per-namespace entry/byte counts and the budget instead of content')
  .action(async (options: { tier?: string, global?: boolean, plain?: boolean, json?: boolean, sizeOnly?: boolean }) => {
    const scope = options.global ? 'global' as const : undefined;
    await withPager(() => withCliInstrumentation(
      { tool: 'reverie_context', scope, params: { tier: options.tier, sizeOnly: options.sizeOnly } },
      () => commands.showContext(options)
    ));
  });

// ── Info command (top-level) ─────────────────────────────────────────

reverie
  .command('info')
  .description('Show version, stats, and storage paths')
  .action(() => {
    commands.showInfo();
  });

// ── Manifest command (top-level) — agent discovery (#117 WS2) ────────

reverie
  .command('manifest')
  .description('Output the command/flag tree + MCP↔CLI map (the tools/list analog; use --json)')
  .action(() => {
    commands.showManifest(reverie);
  });

// ── Search (hidden alias for find) ───────────────────────────────────

async function handleSearch(term: string, options: { entries?: boolean, aliases?: boolean, tree?: boolean, json?: boolean, regex?: boolean, keys?: boolean, values?: boolean, global?: boolean }): Promise<void> {
  const scope = options.global ? 'global' as const : undefined;
  await withCliInstrumentation(
    { tool: 'reverie_find', key: term, scope, params: { query: term } },
    () => commands.searchEntries(term, options)
  );
}

reverie
  .command('search <term>', { hidden: true })
  .description('Find entries by key or value (alias for find)')
  .option('-e, --entries', 'Search only in data entries')
  .option('-a, --aliases', 'Search only in aliases')
  .option('-t, --tree', 'Display results in a hierarchical tree structure')
  .option('-j, --json', 'Output as JSON (for scripting)')
  .option('-x, --regex', 'Treat search term as a regular expression')
  .option('-k, --keys', 'Search keys only (skip value matching)')
  .option('-v, --values', 'Search values only (skip key matching)')
  .option('-G, --global', 'Target global data store')
  .action(async (term: string, options: { entries?: boolean, aliases?: boolean, tree?: boolean, json?: boolean, regex?: boolean, keys?: boolean, values?: boolean, global?: boolean }) => {
    await withPager(() => handleSearch(term, options));
  });

// Stale entries command
reverie
  .command('stale [days]')
  .description('Show entries not updated in N days (default: 30)')
  .option('-j, --json', 'Output as JSON')
  .option('-G, --global', 'Target global data store')
  .action(async (days: string | undefined, options: { json?: boolean, global?: boolean }) => {
    const scope = options.global ? 'global' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_stale', scope, params: { days: days ?? '30' } },
      async () => {
        const { loadMeta, loadMetaMerged } = await import('./store');
        const { getEntriesFlat } = await import('./storage');
        const { color } = await import('./formatting');
        const threshold = parseInt(days ?? '30', 10);
        if (isNaN(threshold) || threshold < 0) {
          if (isJsonMode()) {
            printError('days must be a non-negative integer.', 'INVALID_INPUT');
          } else {
            console.error(color.red('Error: days must be a non-negative integer.'));
            process.exitCode = 1;
          }
          return;
        }
        const meta = scope ? loadMeta(scope) : loadMetaMerged();
        const flat = getEntriesFlat(scope);
        const cutoff = Date.now() - threshold * 86400000;
        const stale: { key: string; age: number; lastUpdated: number | undefined }[] = [];
        for (const key of Object.keys(flat)) {
          const ts = meta[key];
          if (ts === undefined || ts < cutoff) {
            stale.push({ key, age: ts ? Math.floor((Date.now() - ts) / 86400000) : -1, lastUpdated: ts });
          }
        }
        if (isJsonMode()) {
          setResult({ thresholdDays: threshold, stale });
          return;
        }
        if (stale.length === 0) {
          console.log(color.green(`No entries older than ${threshold} days.`));
          return;
        }
        // Sort: untracked first (most suspect), then oldest-first
        stale.sort((a, b) => (a.lastUpdated ?? 0) - (b.lastUpdated ?? 0));
        console.log(color.bold(`\n${stale.length} entries not updated in ${threshold}+ days:\n`));
        for (const { key, age } of stale) {
          const ageStr = age < 0 ? 'untracked' : `${age}d ago`;
          const ageColor = age < 0 ? color.gray : age > 90 ? color.red : color.yellow;
          console.log(`  ${color.white(key.padEnd(40))} ${ageColor(ageStr)}`);
        }
        console.log('');
      }
    );
  });

// Lint command
reverie
  .command('lint')
  .description('Check entries against the recommended namespace schema')
  .option('-j, --json', 'Output as JSON')
  .option('--seed-quality', 'Flag entries with low activation-per-byte (soft warnings)')
  .option('-G, --global', 'Target global data store')
  .action(async (options: { json?: boolean, global?: boolean, seedQuality?: boolean }) => {
    await withCliInstrumentation(
      { tool: 'reverie_lint', scope: options.global ? 'global' : undefined, params: {} },
      () => commands.lintEntries(options)
    );
  });

// Topology command
reverie
  .command('topology')
  .description('Co-occurrence analysis on the audit log — which entries get read together')
  .option('-p, --period <period>', 'Time period: 7d, 30d, 90d, all', '30d')
  .option('-n, --limit <n>', 'Max pairs to show (default: 20)', parseInt)
  .option('-m, --min-sessions <n>', 'Only show pairs co-occurring in at least N sessions (default: 1)', parseInt)
  .option('--dot', 'Emit graphviz DOT for visualization (pipe to `dot -Tsvg`)')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: { period?: string, limit?: number, minSessions?: number, dot?: boolean, json?: boolean }) => {
    await withCliInstrumentation(
      { tool: 'reverie_topology', params: { period: options.period } },
      () => commands.showTopology(options)
    );
  });

// Configuration commands
const configCommand = reverie
  .command('config')
  .description('Manage configuration settings')
  .action(async () => {
    await withPager(() => { commands.handleConfig(); });
  });

configCommand
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action(async (key: string, value: string) => {
    await withCliInstrumentation(
      { tool: 'reverie_config_set', key, scope: 'global', writeValue: value, params: { key, value } },
      () => commands.configSet(key, value)
    );
  });

configCommand
  .command('get [key]')
  .description('Get configuration values')
  .action(async (key?: string) => {
    await withCliInstrumentation(
      { tool: 'reverie_config_get', key, scope: 'global', params: { key } },
      () => commands.handleConfig(key)
    );
  });

// Config subcommands: info, examples, completions
configCommand
  .command('info')
  .description('Show version, stats, and storage info')
  .action(() => {
    commands.showInfo();
  });

configCommand
  .command('examples')
  .description('Show usage examples')
  .action(() => {
    if (isJsonMode()) {
      setResult({ hint: `Usage examples are human-formatted. Run \`${getBinaryName()} manifest --json\` for the machine-readable command surface, or \`${getBinaryName()} config llm-instructions --surface cli --json\` for agent guidance.` });
      return;
    }
    void withPager(() => showExamples());
  });

configCommand
  .command('llm-instructions')
  .description('Show the LLM instructions sent to AI agents (MCP handshake or CLI workflow)')
  .option('--default', 'Show only the built-in defaults (exclude custom additions)')
  .addOption(new Option('--surface <surface>', 'Which surface to show').choices(['mcp', 'cli']).default('mcp'))
  .action(async (options: { default?: boolean, surface?: 'mcp' | 'cli' }) => {
    const surface = options.surface ?? 'mcp';
    const base = surface === 'cli' ? CLI_LLM_INSTRUCTIONS : DEFAULT_LLM_INSTRUCTIONS;
    const text = options.default ? base : getEffectiveInstructions(surface);
    if (isJsonMode()) {
      setResult({ surface, instructions: text });
      return;
    }
    await withPager(() => { process.stdout.write(text + '\n'); });
  });

const completionsCommand = configCommand
  .command('completions')
  .description('Generate shell completion scripts')
  .helpCommand(false);

completionsCommand
  .command('bash')
  .description('Output Bash completion script')
  .action(() => {
    if (isJsonMode()) { setResult({ shell: 'bash', script: generateBashScript() }); return; }
    process.stdout.write(generateBashScript());
  });

completionsCommand
  .command('zsh')
  .description('Output Zsh completion script')
  .action(() => {
    if (isJsonMode()) { setResult({ shell: 'zsh', script: generateZshScript() }); return; }
    process.stdout.write(generateZshScript());
  });

completionsCommand
  .command('install')
  .description('Auto-detect shell and install completions')
  .action(() => {
    if (isJsonMode()) {
      // Interactive setup that writes shell rc files and prints progress; not a
      // machine surface. Refuse rather than pollute the envelope's stdout.
      printError('completions install is interactive; run it without --json.', 'INVALID_INPUT');
      return;
    }
    installCompletions();
  });

// Data management command group
const dataCommand = reverie
  .command('data')
  .description('Manage stored data (export, import, reset)');

dataCommand
  .command('export <type>')
  .description('Export data or aliases to a file')
  .option('-o, --output <file>', 'Output file path')
  .option('--pretty', 'Pretty-print the output')
  .option('--include-encrypted', 'Emit real ciphertext for encrypted values instead of the [encrypted] placeholder. Produces a file suitable for backup/restore; the output contains sensitive material.')
  .option('--split', 'For `export all`: write per-section files (entries/aliases/confirm) instead of a single wrapped file. Default is one file that `import all` can consume directly.')
  .option('-G, --global', 'Export from global data store only')
  .option('-P, --project', 'Export from project data store only')
  .action(async (type: string, options: { format?: string, output?: string, pretty?: boolean, includeEncrypted?: boolean, split?: boolean, global?: boolean, project?: boolean }) => {
    const scope = options.global ? 'global' as const : options.project ? 'project' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_export', scope, params: { type } },
      () => withPager(() => commands.exportData(type, options))
    );
  });

dataCommand
  .command('import <type> <file>')
  .description('Import data or aliases from a file')
  .option('-m, --merge', 'Merge with existing data instead of replacing')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('-p, --preview', 'Preview changes without modifying data')
  .option('-G, --global', 'Import into global data store')
  .option('-P, --project', 'Import into project data store')
  .action(async (type: string, file: string, options: { format?: string, merge?: boolean, force?: boolean, preview?: boolean, global?: boolean, project?: boolean }) => {
    const scope = options.global ? 'global' as const : options.project ? 'project' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_import', scope, params: { type, file } },
      () => commands.importData(type, file, options)
    );
  });

dataCommand
  .command('reset <type>')
  .description('Reset data or aliases to empty state')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('-G, --global', 'Reset global data store only')
  .option('-P, --project', 'Reset project data store only')
  .action(async (type: string, options: { force?: boolean, global?: boolean, project?: boolean }) => {
    const scope = options.global ? 'global' as const : options.project ? 'project' as const : undefined;
    await withCliInstrumentation(
      { tool: 'reverie_reset', scope, params: { type } },
      () => commands.resetData(type, options)
    );
  });

dataCommand
  .command('projectfile', { hidden: true })
  .description('Create or remove a project-scoped .reverie/ directory')
  .option('--remove', 'Remove the project file')
  .action((options: { remove?: boolean }) => {
    console.error(color.yellow('Deprecation: use `init` instead of `data projectfile`.'));
    commands.handleProjectFile(options);
  });

// Init command: create/remove project-scoped data file
reverie
  .command('init')
  .description('Initialize project with .reverie/ directory, codebase scan, and CLAUDE.md')
  .option('--remove', 'Remove the project file')
  .option('--scaffold', 'Auto-populate from project files (kept for backward compat)')
  .option('--no-scan', 'Skip codebase analysis')
  .option('--no-claude', 'Skip CLAUDE.md generation')
  .option('--no-agents', 'Skip AGENTS.md generation')
  .option('--force', 'Overwrite existing CLAUDE.md / AGENTS.md')
  .option('--dry-run', 'Preview without writing')
  .action(async (options: { remove?: boolean; scaffold?: boolean; scan?: boolean; claude?: boolean; agents?: boolean; force?: boolean; dryRun?: boolean }) => {
    if (options.scaffold) console.error(color.yellow('Deprecation: --scaffold is now a no-op. Scanning is the default. Use --no-scan to skip.'));
    await withCliInstrumentation(
      { tool: 'reverie_init', scope: 'project', params: {} },
      () => commands.handleProjectFile(options)
    );
  });

// Stats command: telemetry and usage trends
reverie
  .command('stats')
  .description('View usage telemetry and effectiveness trends')
  .option('-p, --period <period>', 'Time period: 7d, 30d, 90d, all', '30d')
  .option('-D, --detailed', 'Include namespace activity, project breakdown, and top tools')
  .option('-j, --json', 'Output raw JSON')
  .action(async (options: { period: string; detailed?: boolean; json?: boolean }) => {
    const { computeStats } = await import('./utils/telemetry');
    const { parsePeriodDays } = await import('./utils');
    const stats = computeStats(parsePeriodDays(options.period));

    if (isJsonMode()) {
      setResult(stats);
      return;
    }

    const { color } = await import('./formatting');

    if (stats.totalCalls === 0) {
      console.log(color.gray('No telemetry data yet. Usage is tracked automatically via CLI and MCP.'));
      return;
    }

    const { formatStatsReport } = await import('./commands/statsReport');
    const lines = formatStatsReport(stats, {
      detailed: Boolean(options.detailed),
      palette: {
        header: color.bold,
        value: color.white,
        dim: color.gray,
        good: color.green,
        warn: color.yellow,
        bad: color.red,
      },
    });
    console.log('');
    for (const line of lines) console.log(line);
    console.log('');
  });

// Audit log command
reverie
  .command('audit [key]')
  .description('View the audit log of data mutations')
  .option('-p, --period <period>', 'Time period: 7d, 30d, 90d, all', '30d')
  .option('-w, --writes', 'Show only write operations')
  .option('--mcp', 'Show only MCP operations')
  .option('--cli', 'Show only CLI operations')
  .option('--project <path>', 'Filter by project directory path')
  .option('--hits', 'Show only reads that returned data')
  .option('--misses', 'Show only reads that found nothing')
  .option('--redundant', 'Show only writes where value didn\'t change')
  .option('-D, --detailed', 'Show per-entry metrics (duration, sizes, hit/miss)')
  .option('-j, --json', 'Output as JSON')
  .option('-n, --limit <n>', 'Max entries to show (default: 50)', parseInt)
  .option('-f, --follow', 'Follow the audit log in real time')
  .action(async (key: string | undefined, options: { period: string; writes?: boolean; mcp?: boolean; cli?: boolean; project?: string; hits?: boolean; misses?: boolean; redundant?: boolean; detailed?: boolean; json?: boolean; limit?: number; follow?: boolean }) => {
    if (options.follow) {
      // --follow streams indefinitely; that is incompatible with the
      // single-envelope JSON contract (#117 WS1). Refuse rather than emit a
      // never-terminating stream of non-envelope lines on stdout.
      if (isJsonMode()) {
        printError('audit --follow streams continuously and cannot emit a single JSON envelope. Drop --follow (or RVR_OUTPUT) and poll `audit --json` instead.', 'INVALID_INPUT');
        return;
      }
      const { followAuditLog } = await import('./commands/audit');
      await followAuditLog(key, options);
    } else {
      const { showAuditLog } = await import('./commands/audit');
      await withPager(() => showAuditLog(key, options));
    }
  });

// MCP server subcommand: allows binary/Homebrew installs to run the MCP server
reverie
  .command('mcp-server')
  .description('Start the MCP (Model Context Protocol) server over stdio')
  .option('--cwd <dir>', 'Set working directory (enables project-scoped data detection)')
  .option('--agent <name>', 'Agent identity for audit logging')
  .action(async (options: { cwd?: string; agent?: string }) => {
    if (options.agent) {
      process.env.RVR_AGENT_NAME = options.agent;
    }
    const projectDir = process.env.RVR_PROJECT_DIR ?? options.cwd;
    if (projectDir) {
      process.chdir(projectDir);
    }
    const { startMcpServer } = await import('./mcp-server');
    await startMcpServer();
  });

// First-run: welcome message + optional completions install
async function handleFirstRun(): Promise<void> {
  if (fs.existsSync(getDataDirectory())) return;

  // Skip the banner for `mcp-server` — its stdout is JSON-RPC framing,
  // and a chatty stderr write is fine (clients log it but don't parse it).
  const isMcpServer = process.argv.includes('mcp-server');
  const bin = getBinaryName();
  process.stderr.write(`\nWelcome to Reverie! Run \`${bin} config examples\` to see usage patterns.\n`);

  if (isMcpServer || !process.stdin.isTTY) {
    process.stderr.write('\n');
    return;
  }

  const shell = process.env.SHELL ?? '';
  if (!shell.endsWith('/zsh') && !shell.endsWith('/bash')) {
    console.log();
    return;
  }

  console.log();
  const answer = await askConfirmation('Install shell completions and wrapper? [Y/n] ');
  if (answer.toLowerCase() !== 'n') {
    installCompletions();
  } else {
    console.log(`Skipped. Run \`${bin} config completions install\` later to set up.`);
  }
  console.log();
}

void (async () => {
  await handleFirstRun();

  // Show rich help for: rvr, rvr --help, rvr -h, rvr help (with optional --debug)
  const userArgs = process.argv.slice(2).filter(a => a !== '--debug');
  const isRootHelp = userArgs.length === 0 ||
    (userArgs.length === 1 && ['--help', '-h', 'help'].includes(userArgs[0]));

  if (isRootHelp) {
    if (process.argv.includes('--debug')) process.env.DEBUG = 'true';
    void withPager(() => showHelp());
  } else {
    // Fix nested subcommand --help routing (Commander v13 can't route --help
    // for nested subcommands when required positional args are missing)
    if (userArgs.includes('--help') || userArgs.includes('-h')) {
      const helpFreeArgs = userArgs.filter(a => a !== '--help' && a !== '-h');
      if (helpFreeArgs.length >= 2) {
        const parentCmd = reverie.commands.find(c => c.name() === helpFreeArgs[0]);
        if (parentCmd) {
          const subCmd = parentCmd.commands.find(c => c.name() === helpFreeArgs[1]);
          if (subCmd) {
            subCmd.help();
          }
        }
      }
    }
    // parseAsync (not parse) so async actions complete before the finalize
    // below — the instrumented wrapper emits the envelope for data commands;
    // this fallback covers the few non-instrumented commands (info, manifest,
    // etc.) so JSON mode always produces exactly one envelope.
    await reverie.parseAsync(process.argv);
    if (isJsonMode() && !alreadyEmitted()) {
      emitEnvelope();
    }
  }
})();
