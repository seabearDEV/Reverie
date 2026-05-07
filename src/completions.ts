import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadData } from './storage';
import { loadAliases } from './alias';
import { flattenObject } from './utils/objectPath';
import { debug } from './utils/debug';
import { VALID_DATA_TYPES, VALID_RESET_TYPES } from './commands/helpers';
import { VALID_CONFIG_KEYS } from './config';
import { getBinaryName } from './utils/binaryName';

// --- Types ---

export interface CompletionItem {
  value: string;
  description: string;
  group: string;
}

// Terminal height detection — stderr stays connected to the tty even when
// stdout is piped (which it is during shell completion).
function getMaxCompletionItems(): number {
  const rows = process.stderr.rows || process.stdout.rows || 24;
  return Math.max(rows - 5, 5);
}

// Argument types for dynamic completion
// dataKey: entries+aliases  dataKeyOnly: entries only  dataKeyPrefix: truncated to next dot segment
// dataKeyWithNamespaces: entries+aliases+namespace prefixes  configKey/exportType/resetType: static lists
type ArgType = 'dataKey' | 'dataKeyOnly' | 'dataKeyPrefix' | 'dataKeyWithNamespaces' | 'configKey' | 'exportType' | 'resetType' | null;

interface CommandDef {
  flags: Record<string, string>;
  argType: ArgType;
  description?: string | undefined;
  subcommands?: Record<string, CommandDef>;
}

// --- Static data ---

const CONFIG_KEYS: readonly string[] = VALID_CONFIG_KEYS;
const EXPORT_TYPES: readonly string[] = VALID_DATA_TYPES;
const RESET_TYPES: readonly string[] = VALID_RESET_TYPES;

const FLAG_DESCRIPTIONS: Record<string, string> = {
  '--tree': 'Display as tree',
  '-t': 'Display as tree',
  '--plain': 'Plain text, no colors',
  '-s': 'Show before interpolation',
  '--force': 'Skip confirmation',
  '-f': 'Skip confirmation',
  '--yes': 'Skip confirmation',
  '-y': 'Skip confirmation',
  '--dry': 'Print without executing',
  '--entries': 'Show entries only',
  '--aliases': 'Show aliases only',
  '--output': 'Output file path',
  '-o': 'Output file path',
  '--encrypt': 'Encrypt the value',
  '--alias': 'Create an alias for this key',
  '--decrypt': 'Decrypt an encrypted value',
  '-d': 'Decrypt an encrypted value',
  '--copy': 'Copy value to clipboard',
  '-c': 'Copy value to clipboard',
  '--capture': 'Capture output for piping',
  '--clear': 'Clear terminal after setting',
  '--source': 'Show source/raw output',
  '--confirm': 'Require confirmation to run',
  '--no-confirm': 'Remove confirmation requirement',
  '--values': 'Include values in output',
  '-v': 'Include values in output',
  '--depth': 'Limit key depth',
  '-k': 'Limit key depth',
  '--json': 'Output as JSON',
  '-j': 'Output as JSON',
  '--preview': 'Preview changes without modifying',
  '-p': 'Preview changes without modifying',
};

const GLOBAL_FLAGS: Record<string, string> = {
  '--debug': 'Enable debug output',
  '--version': 'Show version',
  '--help': 'Show help',
  '--global': 'Target global data store',
  '-G': 'Target global data store',
  '--project': 'Target project data store',
  '-P': 'Target project data store',
  '--all': 'Show all scopes (project + global)',
  '-A': 'Show all scopes (project + global)',
};

// Define each command once, then reference for shortcuts
const setDef: CommandDef = {
  flags: { '--force': FLAG_DESCRIPTIONS['--force'], '-f': FLAG_DESCRIPTIONS['-f'], '--encrypt': FLAG_DESCRIPTIONS['--encrypt'], '-e': FLAG_DESCRIPTIONS['-e'], '--alias': FLAG_DESCRIPTIONS['--alias'], '--clear': FLAG_DESCRIPTIONS['--clear'], '-c': FLAG_DESCRIPTIONS['--clear'], '--confirm': FLAG_DESCRIPTIONS['--confirm'], '--no-confirm': FLAG_DESCRIPTIONS['--no-confirm'], '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] },
  argType: 'dataKeyPrefix',
  description: 'Set an entry',
};
const getDef: CommandDef = {
  flags: {
    '--tree': FLAG_DESCRIPTIONS['--tree'], '-t': FLAG_DESCRIPTIONS['-t'],
    '--plain': FLAG_DESCRIPTIONS['--plain'], '-p': FLAG_DESCRIPTIONS['--plain'],
    '--source': FLAG_DESCRIPTIONS['--source'], '-s': FLAG_DESCRIPTIONS['-s'],
    '--decrypt': FLAG_DESCRIPTIONS['--decrypt'], '-d': FLAG_DESCRIPTIONS['-d'],
    '--copy': FLAG_DESCRIPTIONS['--copy'], '-c': FLAG_DESCRIPTIONS['-c'],
    '--aliases': FLAG_DESCRIPTIONS['--aliases'], '-a': FLAG_DESCRIPTIONS['--aliases'],
    '--values': FLAG_DESCRIPTIONS['--values'], '-v': FLAG_DESCRIPTIONS['-v'],
    '--depth': FLAG_DESCRIPTIONS['--depth'], '-k': FLAG_DESCRIPTIONS['-k'],
    '--json': FLAG_DESCRIPTIONS['--json'], '-j': FLAG_DESCRIPTIONS['-j'],
    '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'],
    '--all': FLAG_DESCRIPTIONS['--all'], '-A': FLAG_DESCRIPTIONS['-A'],
  },
  argType: 'dataKeyWithNamespaces',
  description: 'List keys or retrieve entries',
};
const runDef: CommandDef = {
  flags: {
    '--yes': FLAG_DESCRIPTIONS['--yes'], '-y': FLAG_DESCRIPTIONS['-y'],
    '--dry': FLAG_DESCRIPTIONS['--dry'],
    '--decrypt': FLAG_DESCRIPTIONS['--decrypt'], '-d': FLAG_DESCRIPTIONS['-d'],
    '--capture': FLAG_DESCRIPTIONS['--capture'], '-c': FLAG_DESCRIPTIONS['--capture'],
    '--source': FLAG_DESCRIPTIONS['--source'],
    '--chain': 'Treat value as space-separated key refs',
    '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'],
  },
  argType: 'dataKey',
  description: 'Execute a stored command',
};
const findDef: CommandDef = {
  flags: {
    '--entries': FLAG_DESCRIPTIONS['--entries'], '-e': FLAG_DESCRIPTIONS['--entries'],
    '--aliases': FLAG_DESCRIPTIONS['--aliases'], '-a': FLAG_DESCRIPTIONS['--aliases'],
    '--tree': FLAG_DESCRIPTIONS['--tree'], '-t': FLAG_DESCRIPTIONS['-t'],
    '--json': FLAG_DESCRIPTIONS['--json'], '-j': FLAG_DESCRIPTIONS['-j'],
    '--regex': 'Use regex pattern', '-x': 'Use regex pattern',
    '--keys': 'Search keys only', '-k': 'Search keys only',
    '--values': 'Search values only', '-v': 'Search values only',
    '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'],
  },
  argType: null,
  description: 'Find entries by key or value',
};
const copyDef: CommandDef = {
  flags: { '--force': FLAG_DESCRIPTIONS['--force'], '-f': FLAG_DESCRIPTIONS['-f'], '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] },
  argType: 'dataKey',
  description: 'Copy an entry to a new key',
};
const editDef: CommandDef = {
  flags: { '--decrypt': FLAG_DESCRIPTIONS['--decrypt'], '-d': FLAG_DESCRIPTIONS['-d'], '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] },
  argType: 'dataKey',
  description: 'Edit entry in $EDITOR',
};
const renameDef: CommandDef = {
  flags: { '--alias': FLAG_DESCRIPTIONS['--alias'], '-a': 'Rename alias', '--set-alias': 'Set alias on renamed key', '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] },
  argType: 'dataKey',
  description: 'Rename an entry key or alias',
};
const removeDef: CommandDef = {
  flags: { '--force': FLAG_DESCRIPTIONS['--force'], '-f': FLAG_DESCRIPTIONS['-f'], '--alias': FLAG_DESCRIPTIONS['--alias'], '-a': 'Remove alias only', '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] },
  argType: 'dataKey',
  description: 'Remove an entry',
};

const CLI_TREE: Record<string, CommandDef> = {
  set: setDef, s: setDef,
  get: getDef, g: getDef,
  run: runDef, r: runDef,
  init: {
    flags: {
      '--remove': 'Remove the project file',
      '--no-scan': 'Skip codebase analysis',
      '--no-claude': 'Skip CLAUDE.md generation',
      '--force': 'Overwrite existing CLAUDE.md',
      '--dry-run': 'Preview without writing',
    },
    argType: null,
    description: 'Initialize project (.reverie/ + CLAUDE.md)',
  },
  stale: {
    flags: { '--json': 'Output as JSON', '-j': 'Output as JSON', '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] },
    argType: null,
    description: 'Show stale entries',
  },
  lint: {
    flags: { '--json': 'Output as JSON', '-j': 'Output as JSON', '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] },
    argType: null,
    description: 'Check namespace schema',
  },
  find: findDef, f: findDef, search: findDef,
  copy: copyDef, cp: copyDef,
  edit: editDef, e: editDef,
  rename: renameDef, rn: renameDef,
  remove: removeDef, rm: removeDef,
  alias: {
    flags: {},
    argType: null,
    description: 'Manage key aliases',
    subcommands: {
      set: { flags: { '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] }, argType: 'dataKey', description: 'Create an alias' },
      remove: { flags: { '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] }, argType: 'dataKey', description: 'Remove an alias' },
      list: { flags: { '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] }, argType: null, description: 'List aliases' },
      rename: { flags: { '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] }, argType: 'dataKey', description: 'Rename an alias' },
    },
  },
  confirm: {
    flags: {},
    argType: null,
    description: 'Manage run confirmations',
    subcommands: {
      set: { flags: { '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] }, argType: 'dataKey', description: 'Require confirmation' },
      remove: { flags: { '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] }, argType: 'dataKey', description: 'Remove confirmation' },
      list: { flags: { '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'] }, argType: null, description: 'List confirmed keys' },
    },
  },
  context: {
    flags: {
      '--tier': 'Context tier (essential, standard, full)', '-t': 'Context tier',
      '--plain': FLAG_DESCRIPTIONS['--plain'], '-p': FLAG_DESCRIPTIONS['--plain'],
      '--json': 'Output as JSON', '-j': 'Output as JSON',
      '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'],
    },
    argType: null,
    description: 'Show project knowledge summary',
  },
  info: {
    flags: {},
    argType: null,
    description: 'Show version and stats',
  },
  config: {
    flags: {},
    argType: null,
    description: 'View or change settings',
    subcommands: {
      set: { flags: {}, argType: 'configKey', description: 'Set a config value' },
      get: { flags: {}, argType: 'configKey', description: 'Get config values' },
      info: { flags: {}, argType: null, description: 'Show version and stats' },
      examples: { flags: {}, argType: null, description: 'Show usage examples' },
      'llm-instructions': { flags: { '--default': 'Show built-in defaults only' }, argType: null, description: 'Show LLM instructions' },
      completions: {
        flags: {},
        argType: null,
        description: 'Manage shell completions',
        subcommands: {
          bash:    { flags: {}, argType: null, description: 'Output Bash script' },
          zsh:     { flags: {}, argType: null, description: 'Output Zsh script' },
          install: { flags: {}, argType: null, description: 'Auto-install completions' },
        },
      },
    },
  },
  stats: {
    flags: {
      '--period': 'Time period (7d, 30d, 90d, all)', '-p': 'Time period (7d, 30d, 90d, all)',
      '--detailed': 'Include namespace activity and breakdowns', '-D': 'Include namespace activity and breakdowns',
      '--json': 'Output raw JSON', '-j': 'Output raw JSON',
    },
    argType: null,
    description: 'View usage telemetry',
  },
  audit: {
    flags: {
      '--period': 'Time period (7d, 30d, 90d, all)', '-p': 'Time period (7d, 30d, 90d, all)',
      '--writes': 'Show writes only', '-w': 'Show writes only',
      '--mcp': 'Show MCP operations only', '--cli': 'Show CLI operations only',
      '--detailed': 'Show per-entry metrics', '-D': 'Show per-entry metrics',
      '--json': 'Output raw JSON', '-j': 'Output raw JSON',
      '--limit': 'Max entries to show', '-n': 'Max entries to show',
    },
    argType: 'dataKey' as ArgType,
    description: 'View audit log',
  },
  data: {
    flags: {},
    argType: null,
    description: 'Manage stored data',
    subcommands: {
      export: {
        flags: {
          '--output': FLAG_DESCRIPTIONS['--output'], '-o': FLAG_DESCRIPTIONS['-o'],
          '--pretty': 'Pretty-print output',
          '--include-encrypted': 'Emit real ciphertext instead of [encrypted] placeholder',
          '--split': 'For `export all`: write per-section files instead of one wrapped file',
          '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'],
          '--project': FLAG_DESCRIPTIONS['--project'], '-P': FLAG_DESCRIPTIONS['-P'],
        },
        argType: 'exportType',
        description: 'Export data or aliases',
      },
      import: {
        flags: {
          '--merge': 'Merge with existing',
          '-m': 'Merge with existing',
          '--force': FLAG_DESCRIPTIONS['--force'], '-f': FLAG_DESCRIPTIONS['-f'],
          '--preview': FLAG_DESCRIPTIONS['--preview'], '-p': FLAG_DESCRIPTIONS['-p'],
          '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'],
          '--project': FLAG_DESCRIPTIONS['--project'], '-P': FLAG_DESCRIPTIONS['-P'],
        },
        argType: 'exportType',
        description: 'Import data or aliases',
      },
      reset: {
        flags: {
          '--force': FLAG_DESCRIPTIONS['--force'], '-f': FLAG_DESCRIPTIONS['-f'],
          '--global': FLAG_DESCRIPTIONS['--global'], '-G': FLAG_DESCRIPTIONS['-G'],
          '--project': FLAG_DESCRIPTIONS['--project'], '-P': FLAG_DESCRIPTIONS['-P'],
        },
        argType: 'resetType' as ArgType,
        description: 'Reset to empty state',
      },
      projectfile: {
        flags: { '--remove': 'Remove the project file' },
        argType: null,
        description: 'Create/remove project data file',
      },
    },
  },
};

// --- Dynamic data loaders ---

function getDataKeys(): string[] {
  try {
    const data = loadData();
    return Object.keys(flattenObject(data));
  } catch (error) {
    debug('Failed to load data keys for completion', { error: String(error) });
    return [];
  }
}

function getAliasNames(): string[] {
  try {
    return Object.keys(loadAliases());
  } catch (error) {
    debug('Failed to load alias names for completion', { error: String(error) });
    return [];
  }
}

function getNamespacePrefixes(keys: string[]): CompletionItem[] {
  const seen = new Set<string>();
  const result: CompletionItem[] = [];
  for (const key of keys) {
    let dotIndex = key.indexOf('.');
    while (dotIndex !== -1) {
      const ns = key.substring(0, dotIndex);
      if (!seen.has(ns)) {
        seen.add(ns);
        result.push({ value: ns, description: 'Namespace', group: 'data keys' });
      }
      dotIndex = key.indexOf('.', dotIndex + 1);
    }
  }
  return result;
}

function getDynamicValues(argType: ArgType): CompletionItem[] {
  switch (argType) {
    case 'dataKey':
    case 'dataKeyPrefix':
    case 'dataKeyWithNamespaces': {
      const dataKeys = getDataKeys();
      const keys = dataKeys.map(k => ({ value: k, description: 'Entry', group: 'data keys' }));
      const aliases = getAliasNames()        .map(a => ({ value: a, description: 'Alias', group: 'aliases' }));
      if (argType === 'dataKeyWithNamespaces') {
        return [...keys, ...getNamespacePrefixes(dataKeys), ...aliases];
      }
      return [...keys, ...aliases];
    }
    case 'dataKeyOnly':
      return getDataKeys()        .map(k => ({ value: k, description: '', group: 'data keys' }));
    case 'configKey':
      return CONFIG_KEYS.map(k => ({ value: k, description: 'Config setting', group: 'config' }));
    case 'exportType':
      return EXPORT_TYPES.map(t => ({ value: t, description: 'Export type', group: 'types' }));
    case 'resetType':
      return RESET_TYPES.map(t => ({ value: t, description: 'Reset type', group: 'types' }));
    default:
      return [];
  }
}

/** Truncate completion values to the next dot-segment boundary after the typed partial. */
function truncateToNextDot(items: CompletionItem[], partial: string): CompletionItem[] {
  const seen = new Set<string>();
  const result: CompletionItem[] = [];

  for (const item of items) {
    const dotIndex = item.value.indexOf('.', partial.length);
    if (dotIndex === -1) {
      // No more dots — return the full value (leaf key or alias)
      if (!seen.has(item.value)) {
        seen.add(item.value);
        result.push(item);
      }
    } else {
      // Truncate to include the dot (namespace prefix)
      const prefix = item.value.substring(0, dotIndex + 1);
      if (!seen.has(prefix)) {
        seen.add(prefix);
        result.push({ value: prefix, description: 'Namespace', group: item.group });
      }
    }
  }

  return result;
}

// --- Core completion logic ---

export function getCompletions(compLine: string, compPoint: number): CompletionItem[] {
  const results = getCompletionsUnlimited(compLine, compPoint);
  const max = getMaxCompletionItems();
  return results.length > max ? results.slice(0, max) : results;
}

function getCompletionsUnlimited(compLine: string, compPoint: number): CompletionItem[] {
  // Slice line to cursor position
  const lineToPoint = compLine.slice(0, compPoint);

  // Split into words, preserving trailing space info
  const words = lineToPoint.split(/\s+/).filter(Boolean);
  const endsWithSpace = lineToPoint.endsWith(' ') || lineToPoint === '';
  const partial = endsWithSpace ? '' : (words.pop() ?? '');

  // words[0] is the program name (rvr); skip it
  const args = words.slice(1);

  // No command typed yet — complete top-level commands
  if (args.length === 0) {
    const topLevel = Object.entries(CLI_TREE).map(
      ([name, def]) => ({ value: name, description: def.description ?? '', group: 'commands' })
    );
    return filterPrefix(topLevel, partial);
  }

  const commandName = args[0];
  const cmdDef = CLI_TREE[commandName];

  // Unknown command — still suggest top-level commands
  if (!cmdDef) {
    const topLevel = Object.entries(CLI_TREE).map(
      ([name, def]) => ({ value: name, description: def.description ?? '', group: 'commands' })
    );
    return filterPrefix(topLevel, partial);
  }

  // Walk subcommand tree (supports arbitrary nesting: config -> completions -> bash)
  let activeDef: CommandDef = cmdDef;
  let depth = 1; // args[0] is the top-level command; walk from args[1] onward

  while (activeDef.subcommands && depth < args.length) {
    const subName = args[depth];
    const subDef = activeDef.subcommands[subName];
    if (subDef) {
      activeDef = subDef;
      depth++;
    } else if (!endsWithSpace && depth === args.length - 1) {
      // Still typing a subcommand name at this level
      const subs = Object.entries(activeDef.subcommands).map(
        ([name, def]) => ({ value: name, description: def.description ?? '', group: 'subcommands' })
      );
      return filterPrefix(subs, partial);
    } else {
      break;
    }
  }

  // If the active command has subcommands and we haven't descended further, suggest them
  if (activeDef.subcommands && depth === args.length) {
    const subs = Object.entries(activeDef.subcommands).map(
      ([name, def]) => ({ value: name, description: def.description ?? '', group: 'subcommands' })
    );
    if (endsWithSpace) {
      return subs;
    }
    return filterPrefix(subs, partial);
  }

  const prevWord = args[args.length - 1];

  // Special case: previous word is --output → let shell handle file completion
  if (prevWord === '--output' || prevWord === '-o') {
    return [];
  }

  // Handle : composition for run/r commands (e.g., "cd:paths." completes the segment after :)
  if (partial.includes(':') && (commandName === 'run' || commandName === 'r') && activeDef.argType) {
    const colonIndex = partial.lastIndexOf(':');
    const prefix = partial.substring(0, colonIndex + 1);
    const segmentPartial = partial.substring(colonIndex + 1);
    const dynamicItems = getDynamicValues(activeDef.argType);
    const filtered = filterPrefix(dynamicItems, segmentPartial);
    return filtered.map(item => ({ ...item, value: prefix + item.value }));
  }

  // Build candidates: flags only when typing a dash, data keys otherwise
  const candidates: CompletionItem[] = [];
  const typingFlag = partial.startsWith('-');

  if (typingFlag) {
    // Add flags that haven't been used yet
    const usedFlags = new Set(args.filter(a => a.startsWith('-')));
    for (const [flag, desc] of Object.entries(activeDef.flags)) {
      if (!usedFlags.has(flag)) {
        candidates.push({ value: flag, description: desc, group: 'flags' });
      }
    }
    for (const [flag, desc] of Object.entries(GLOBAL_FLAGS)) {
      if (!usedFlags.has(flag)) {
        candidates.push({ value: flag, description: desc, group: 'flags' });
      }
    }
  } else {
    // Add dynamic argument values
    if (activeDef.argType) {
      candidates.push(...getDynamicValues(activeDef.argType));
    }
  }

  const filtered = filterPrefix(candidates, partial);

  // For dataKeyPrefix, truncate to next dot-segment so set completes one level at a time
  if (activeDef.argType === 'dataKeyPrefix' && !typingFlag) {
    return truncateToNextDot(filtered, partial);
  }

  return filtered;
}

function filterPrefix(items: CompletionItem[], prefix: string): CompletionItem[] {
  if (!prefix) return items;
  return items.filter(item => item.value.startsWith(prefix));
}

// --- Shell script generators ---

export function generateBashScript(): string {
  const bin = getBinaryName();
  return `# Bash completion for ${bin} (Reverie)
_${bin}_completions() {
  # Remove : from word breaks so colon-composed commands (run cd:key) complete correctly
  local _saved_wordbreaks="$COMP_WORDBREAKS"
  COMP_WORDBREAKS="\${COMP_WORDBREAKS//:/}"

  local completions
  completions="$(${bin} --get-completions "$COMP_LINE" "$COMP_POINT" 2>/dev/null)"
  if [ -z "$completions" ]; then
    COMP_WORDBREAKS="$_saved_wordbreaks"
    return
  fi
  local tab=$'\\t'
  COMPREPLY=()
  while IFS= read -r line; do
    local value="\${line%%\${tab}*}"
    COMPREPLY+=("$value")
  done <<< "$completions"
  # Suppress trailing space for namespace prefixes (values ending in .)
  local all_dot=1
  for reply in "\${COMPREPLY[@]}"; do
    if [[ "$reply" != *. ]]; then
      all_dot=0
      break
    fi
  done
  if [[ $all_dot -eq 1 && \${#COMPREPLY[@]} -gt 0 ]]; then
    compopt -o nospace
  fi

  COMP_WORDBREAKS="$_saved_wordbreaks"
}
complete -o default -F _${bin}_completions ${bin}
`;
}

export function generateZshScript(): string {
  const bin = getBinaryName();
  // zsh disallows `-` in variable identifiers but permits it in command/function
  // names. Use `binVar` for any `local`/parameter-name interpolation; keep `bin`
  // for command invocations and function names. Without this split, hyphenated
  // binaries (e.g. `rvr-beta`, `rvr-dev`) generate `_rvr-beta_val` which fails
  // to parse with `parse error near '_rvr-beta_val'`. See issue #111.
  const binVar = bin.replace(/-/g, '_');
  return `# Zsh completion for ${bin} (Reverie)
_${bin}_completions() {
  local line tab=$'\\t' us=$'\\x1f'
  local -A groups
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then
      continue
    fi
    if [[ "$line" == *\${tab}* ]]; then
      local value="\${line%%\${tab}*}"
      local rest="\${line#*\${tab}}"
      local desc="\${rest%%\${tab}*}"
      local grp="\${rest#*\${tab}}"
      if [[ "$grp" == "$desc" ]]; then
        grp="completions"
      fi
      groups[\${grp}]="\${groups[\${grp}]+\${groups[\${grp}]}|}\${value}\${us}\${desc}"
    else
      groups[completions]="\${groups[completions]+\${groups[completions]}|}\${line}"
    fi
  done < <(${bin} --get-completions "$BUFFER" "$CURSOR" 2>/dev/null)
  if (( \${#groups} == 0 )); then
    _files
    return
  fi
  local grp_name _${binVar}_val
  local -a _${binVar}_items _${binVar}_dot _${binVar}_desc _${binVar}_plain
  for grp_name in \${(ko)groups}; do
    _${binVar}_items=("\${(@s:|:)groups[\$grp_name]}")
    _${binVar}_dot=()
    _${binVar}_desc=()
    _${binVar}_plain=()
    for _${binVar}_val in "\${_${binVar}_items[@]}"; do
      local _${binVar}_key="\${_${binVar}_val%%\${us}*}"
      local _${binVar}_dsc="\${_${binVar}_val#*\${us}}"
      if [[ "\$_${binVar}_key" == *. ]]; then
        _${binVar}_dot+=("\$_${binVar}_key")
      elif [[ "\$_${binVar}_val" == *\${us}* && -n "\$_${binVar}_dsc" ]]; then
        local _${binVar}_escaped="\${_${binVar}_key//:/\\:}"
        _${binVar}_desc+=("\${_${binVar}_escaped}:\${_${binVar}_dsc}")
      else
        _${binVar}_plain+=("\$_${binVar}_key")
      fi
    done
    (( \${#_${binVar}_desc} )) && _describe "\$grp_name" _${binVar}_desc
    (( \${#_${binVar}_plain} )) && compadd -- "\${_${binVar}_plain[@]}"
    (( \${#_${binVar}_dot} )) && compadd -S '' -- "\${_${binVar}_dot[@]}"
  done
}
compdef _${bin}_completions ${bin}
`;
}

// --- Install helper ---

export function installCompletions(): void {
  const bin = getBinaryName();
  // Same hyphen-handling as generateZshScript: zsh/bash allow `-` in command and
  // function names but not in `local`/parameter names. Use binVar in those slots.
  const binVar = bin.replace(/-/g, '_');
  const shell = process.env.SHELL ?? '';
  let rcFile: string;
  let scriptCmd: string;

  const home = os.homedir();
  if (shell.endsWith('/zsh')) {
    rcFile = path.join(home, '.zshrc');
    scriptCmd = `eval "$(${bin} config completions zsh)"`;
  } else if (shell.endsWith('/bash')) {
    // Prefer .bash_profile on macOS, .bashrc on Linux
    const bashProfile = path.join(home, '.bash_profile');
    const bashrc = path.join(home, '.bashrc');
    rcFile = process.platform === 'darwin' && fs.existsSync(bashProfile) ? bashProfile : bashrc;
    scriptCmd = `eval "$(${bin} config completions bash)"`;
  } else {
    console.error(`Unsupported shell: ${shell || '(unknown)'}`);
    console.error('Supported shells: bash, zsh');
    console.error(`You can manually add completions by running: ${bin} config completions bash  OR  ${bin} config completions zsh`);
    process.exit(1);
  }

  const content = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';

  // Install completions
  if (content.includes(`${bin} completions`) || content.includes(`${bin} config completions`)) {
    console.log(`Completions already installed in ${rcFile}`);
  } else {
    const completionBlock = `\n# Reverie shell completions (${bin})\n${scriptCmd}\n`;
    fs.appendFileSync(rcFile, completionBlock, 'utf8');
    console.log(`Completions installed in ${rcFile}`);
  }

  // Install shell wrapper for `run` / `r` (eval in current shell)
  // Re-read content since completions block may have been appended above
  const wrapperContent = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';
  const wrapperMarker = `# Reverie shell wrapper (${bin})`;

  if (wrapperContent.includes(wrapperMarker)) {
    console.log(`Shell wrapper already installed in ${rcFile}`);
  } else {
    const wrapperBlock = `
${wrapperMarker} — eval "${bin} run" in the current shell so cd/export/alias work
${bin}() {
  local subcmd="" has_help=false
  for arg in "$@"; do
    if [[ "$arg" == "-h" || "$arg" == "--help" ]]; then
      has_help=true
    elif [[ "$arg" != -* && -z "$subcmd" ]]; then
      subcmd="$arg"
    fi
  done
  if [[ "$has_help" == false && ("$subcmd" == "run" || "$subcmd" == "r") ]]; then
    local __${binVar}_cmd __${binVar}_exit
    __${binVar}_cmd="$(command ${bin} "$@" --source)"
    __${binVar}_exit=$?
    [[ $__${binVar}_exit -ne 0 ]] && return $__${binVar}_exit
    [[ -n "$__${binVar}_cmd" ]] && eval "$__${binVar}_cmd"
  else
    command ${bin} "$@"
  fi
}
`;
    fs.appendFileSync(rcFile, wrapperBlock, 'utf8');
    console.log(`Shell wrapper installed in ${rcFile}`);
  }

  // Install history exclusion
  // Re-read content since earlier blocks may have been appended above
  const currentContent = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';
  const historyMarker = `_${bin}_history_filter`;

  if (currentContent.includes(historyMarker) || (!shell.endsWith('/zsh') && currentContent.includes('HISTIGNORE'))) {
    console.log(`History exclusion already configured in ${rcFile}`);
  } else {
    const historyBlock = shell.endsWith('/zsh')
      ? `\n# Reverie - exclude from shell history (${bin} set/s commands may contain sensitive values)\n[[ -z \${functions[add-zsh-hook]} ]] && autoload -Uz add-zsh-hook\n${historyMarker}() { [[ $1 != ${bin}\\ (set|s)\\ * ]] }\nadd-zsh-hook zshaddhistory ${historyMarker}\n`
      : `\n# Reverie - exclude from shell history (${bin} set/s commands may contain sensitive values)\nHISTIGNORE="\${HISTIGNORE:+\$HISTIGNORE:}${bin} set *:${bin} s *"\n`;
    fs.appendFileSync(rcFile, historyBlock, 'utf8');
    console.log(`History exclusion installed in ${rcFile}`);
  }

  console.log(`Restart your shell or run: source ${rcFile}`);
}
