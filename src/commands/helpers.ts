import readline from 'readline';
import fs from 'fs';
import { colorizePathByLevels, displayTree } from '../formatting';
import { color } from '../formatting';
import { buildKeyToAliasMap } from '../alias';
import { loadConfirmKeys } from '../confirm';
import { isEncrypted } from '../utils/crypto';
import { interpretEscapes, visibleLength, wordWrap } from '../utils/wordWrap';
import { getBinaryName } from '../utils/binaryName';
import { isJsonMode, failJson, addWarning, ErrorCode } from '../utils/output';

export function printSuccess(message: string): void {
  // In JSON mode success is conveyed by the envelope's `ok:true`; suppress the
  // human line so the only thing on stdout is the single envelope (#117 WS1).
  if (isJsonMode()) return;
  console.log(color.green('✓ ') + message);
}

export function printError(message: string, code: ErrorCode = 'RUNTIME'): void {
  // In JSON mode the failure becomes the envelope's structured `error` (on
  // stdout) instead of a human line on stderr. failJson also sets exitCode=1.
  if (isJsonMode()) {
    failJson(code, message);
    return;
  }
  console.error(color.red('✗ ') + message);
  // Surface failure via the process exit code so scripts wrapping rvr can
  // detect errors. Pre-fix the CLI returned 0 on most printError paths.
  // Every call site is followed by a `return`/abort, so this matches intent.
  process.exitCode = 1;
}

export function printWarning(message: string): void {
  // In JSON mode warnings accumulate into the envelope's `warnings[]`.
  if (isJsonMode()) {
    addWarning(message);
    return;
  }
  console.log(color.yellow('⚠ ') + message);
}

export function displayKeys(keys: string[], keyToAliasMap?: Record<string, string>): void {
  const aliasMap = keyToAliasMap ?? buildKeyToAliasMap();
  for (const key of keys) {
    const colorizedPath = colorizePathByLevels(key);
    const alias = aliasMap[key];
    if (alias) {
      console.log(`${colorizedPath} ${color.blue('(' + alias + ')')}`);
    } else {
      console.log(colorizedPath);
    }
  }
}

export function displayEntries(entries: Record<string, string>, keyToAliasMap?: Record<string, string>): void {
  const aliasMap = keyToAliasMap ?? buildKeyToAliasMap();
  const confirmKeys = loadConfirmKeys();
  Object.entries(entries).forEach(([key, value]) => {
    const colorizedPath = colorizePathByLevels(key);
    const alias = aliasMap[key];
    const confirmTag = confirmKeys[key] ? ` ${color.red('[confirm]')}` : '';
    const displayed = isEncrypted(value) ? '[encrypted]' : interpretEscapes(value);
    const lines = displayed.split('\n');

    const prefix = alias
      ? `${colorizedPath} ${color.blue('(' + alias + ')')}${confirmTag}:`
      : `${colorizedPath}${confirmTag}:`;

    const termWidth = process.stdout.columns || 80;

    if (lines.length > 1) {
      console.log(prefix);
      const mlIndent = '  ';
      const mlWidth = termWidth - mlIndent.length;
      for (const line of lines) {
        if (mlWidth < 20) {
          console.log(`${mlIndent}${line}`);
        } else {
          const wrapped = wordWrap(line, mlWidth);
          for (const line of wrapped) {
            console.log(`${mlIndent}${line}`);
          }
        }
      }
    } else {
      const prefixWidth = visibleLength(prefix) + 1; // +1 for the space
      const valueWidth = termWidth - prefixWidth;
      if (valueWidth < 20) {
        console.log(`${prefix} ${lines[0]}`);
      } else {
        const wrapped = wordWrap(lines[0], valueWidth);
        const indent = ' '.repeat(prefixWidth);
        for (let i = 0; i < wrapped.length; i++) {
          if (i === 0) {
            console.log(`${prefix} ${wrapped[i]}`);
          } else {
            console.log(`${indent}${wrapped[i]}`);
          }
        }
      }
    }
  });
}

export function displayAliases(aliases: Record<string, string>, options?: { tree?: boolean | undefined, name?: string | undefined }): void {
  const name = options?.name;
  const tree = options?.tree;

  if (name) {
    const aliasValue = aliases[name];
    if (!aliasValue) {
      printError(`Alias '${name}' not found`);
      return;
    }
    if (tree) {
      displayTree({ [name]: aliasValue });
    } else {
      console.log(`${color.cyan(name)}: ${colorizePathByLevels(aliasValue)}`);
    }
    return;
  }

  if (Object.keys(aliases).length === 0) {
    console.log(`No aliases found. Add one with "${getBinaryName()} set <key> <value> -a <alias>"`);
    return;
  }

  if (tree) {
    displayTree(aliases as Record<string, unknown>);
  } else {
    Object.entries(aliases).forEach(([alias, path]) => {
      console.log(`${color.cyan(alias)}: ${colorizePathByLevels(path)}`);
    });
  }
}

export function askConfirmation(prompt: string, output?: NodeJS.WritableStream): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: output ?? process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Read a password from the first line of a file. Refuses world-readable files
 * (chmod 600 recommended) — mirrors the ssh_config password-file convention.
 * Strips a trailing newline and surrounding whitespace from the line.
 */
export function readPasswordFile(filePath: string): string {
  const stat = fs.statSync(filePath);
  // Refuse world-readable files. Group-readable is permitted (common in CI
  // where the deploying user and service user share a group); strict shops
  // can chmod 600.
  if ((stat.mode & 0o004) !== 0) {
    throw new Error(
      `Refusing to read password from '${filePath}': file is world-readable. Run \`chmod 600 ${filePath}\` first.`,
    );
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const firstLine = content.split(/\r?\n/)[0] ?? '';
  return firstLine.trim();
}

// Module-local: ensure the RVR_PASSWORD warning only fires once per process
// even if askPassword is called multiple times (e.g. promptAndEncrypt does a
// prompt + confirm pair).
let rvrPasswordWarningShown = false;

export interface AskPasswordOptions {
  /** Path to a file whose first line is the password. Overrides env var. */
  passwordFile?: string | undefined;
}

export function askPassword(prompt: string, options?: AskPasswordOptions): Promise<string> {
  // 1. Explicit file path wins over everything — an explicit flag signals
  //    the caller has chosen a non-interactive source deliberately.
  if (options?.passwordFile) {
    try {
      return Promise.resolve(readPasswordFile(options.passwordFile));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // 2. RVR_PASSWORD env var — one-shot fallback for CI/scripting. Emit a
  //    single stderr warning so the user knows the secret is in their
  //    environment and should be cleared after the command.
  const envPassword = process.env.RVR_PASSWORD;
  if (envPassword !== undefined && envPassword !== '') {
    if (!rvrPasswordWarningShown) {
      process.stderr.write(
        color.yellow('⚠ password read from RVR_PASSWORD — clear your environment after use\n'),
      );
      rvrPasswordWarningShown = true;
    }
    return Promise.resolve(envPassword);
  }

  // 3. Interactive TTY prompt (original behavior).
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error(
      'Password input requires an interactive terminal, --password-file <path>, or the RVR_PASSWORD env var.',
    ));
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    // Write prompt/echo to stderr so it isn't captured by the pager
    const output = process.stderr;

    output.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';

    const onData = (ch: string): void => {
      const c = ch.toString();

      if (c === '\n' || c === '\r' || c === '\u0004') {
        // Enter or Ctrl+D — done
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        output.write('\n');
        resolve(password);
      } else if (c === '\u0003') {
        // Ctrl+C — abort
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        output.write('\n');
        reject(new Error('Password entry cancelled.'));
      } else if (c === '\u007f' || c === '\b') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          output.write('\b \b');
        }
      } else {
        password += c;
        output.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

export const VALID_DATA_TYPES = ['entries', 'aliases', 'confirm', 'all'] as const;
export const VALID_RESET_TYPES = ['entries', 'aliases', 'confirm', 'all', 'audit', 'telemetry', 'miss-paths'] as const;

export function validateDataType(type: string): boolean {
  return (VALID_DATA_TYPES as readonly string[]).includes(type);
}

export function validateResetType(type: string): boolean {
  return (VALID_RESET_TYPES as readonly string[]).includes(type);
}

export function getInvalidDataTypeMessage(type: string): string {
  return `Invalid type: ${type}. Must be 'entries', 'aliases', 'confirm', or 'all'`;
}

export function getInvalidResetTypeMessage(type: string): string {
  return `Invalid type: ${type}. Must be 'entries', 'aliases', 'confirm', 'all', 'audit', or 'telemetry'`;
}

export async function confirmOrAbort(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = await askConfirmation(prompt);
  if (answer.toLowerCase() !== 'y') {
    console.log('Aborted.');
    return false;
  }
  return true;
}
