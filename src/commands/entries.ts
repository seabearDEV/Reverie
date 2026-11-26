import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadData, handleError, getValue, getValueForWrite, setValue, removeValue, Scope } from '../storage';
import { flattenObject, setNestedValue } from '../utils/objectPath';
import { assertKeysWritable, renameDestinationProblem, renamedLeaves } from '../utils/keyCollision';
import { isValidEntryKey } from '../utils/directoryStore';
import { findProjectFile, updateEntries, loadMeta, loadMetaMerged, getStalenessTag } from '../store';
import { CodexValue } from '../types';
import { displayTree } from '../formatting';
import { color } from '../formatting';
import { execSync, spawnSync } from 'child_process';
import { ensureDataDirectoryExists } from '../utils/paths';
import { buildKeyToAliasMap, setAlias, removeAliasesForKey, loadAliases, updateAliases, resolveKey, renameAlias } from '../alias';
import { hasConfirm, setConfirm, removeConfirm, flagsListedUnder, moveConfirm, flagsGating, gatedAmong } from '../confirm';
import { resolveScopeForWrite } from '../projectResolution';
import { debug } from '../utils/debug';
import { StoreUnreadableError, assertSidecarsWritable, assertSubtreeReadable, confirmListUnreadable, listUnreadableFiles } from '../utils/unreadable';
import { GetOptions } from '../types';
import { printSuccess, printWarning, printError, displayEntries, displayKeys, displayAliases, askConfirmation, askPassword } from './helpers';
import { copyToClipboard } from '../utils/clipboard';
import { isEncrypted, encryptValue, decryptValue } from '../utils/crypto';
import { interpolate, interpolateExec, interpolateObject, collectReferencedKeys, interpolateForRead, unresolvedWarning, unresolvedOverflowNote, UNRESOLVED_WARNING_CODE, UnresolvedOnRead } from '../utils/interpolate';
import { getBinaryName } from '../utils/binaryName';
import { isJsonMode, setResult, failJson, addWarning, recordErrorCode } from '../utils/output';
import { markValueStored } from '../utils/writeAmp';

function toScope(global?: boolean  ): Scope | undefined {
  return global ? 'global' : undefined;
}

/** How many unresolved-reference warnings one command prints before it summarizes. */
const UNRESOLVED_WARNINGS_CAP = 10;

/**
 * #202: say that these entries were returned as written because a `\${name}`
 * in them does not resolve. warnings[] in JSON mode; stderr otherwise, so
 * stdout stays exactly the value for a caller capturing it.
 */
function warnUnresolved(found: [string, UnresolvedOnRead][]): void {
  const emit = (message: string): void => {
    if (isJsonMode()) addWarning(message, UNRESOLVED_WARNING_CODE);
    else console.error(`warning: ${message}`);
  };
  for (const [key, unresolved] of found.slice(0, UNRESOLVED_WARNINGS_CAP)) emit(unresolvedWarning(key, unresolved));
  const rest = found.length - UNRESOLVED_WARNINGS_CAP;
  if (rest > 0) emit(`${unresolvedOverflowNote(rest)}; \`${getBinaryName()} lint\` lists them.`);
}

/**
 * #202: after a `set`, say which of the values just stored hold a reference
 * that does not resolve — `set` used to accept one without a word, and the
 * first sign was a failed read later. The write stands; this says what a
 * reader will get. Safe pass: nothing is executed.
 *
 * Takes every pair a command stored, so a batch `set a=… b=…` is checked
 * once, after its last pair: checked pair by pair, a reference to a key the
 * same command defines next was reported as unresolved.
 *
 * Called by the command, not by setEntry, and only with values that may be
 * shown: the warning quotes the reference, so a value typed at the masked
 * prompt or about to be encrypted must never be passed in.
 */
export function warnUnresolvedReferences(stored: [string, string][]): void {
  const found: [string, UnresolvedOnRead][] = [];
  for (const [key, value] of stored) {
    try {
      const read = interpolateForRead(value);
      if (read.unresolved) found.push([key, read.unresolved]);
    } catch { /* `:?` or a cycle fails the read of this entry; that is the read's to report, and a fault here must not fail a write that succeeded */ }
  }
  warnUnresolved(found);
}

export async function runCommand(keys: string[], options: { yes?: boolean, dry?: boolean, decrypt?: boolean, source?: boolean, capture?: boolean, chain?: boolean, global?: boolean, passwordFile?: string }): Promise<void> {
  debug('runCommand called', { keys, options });
  const scope = toScope(options.global);
  try {
    // --chain: resolve the first key's value as a space-separated list of key references
    if (options.chain) {
      if (keys.length !== 1) {
        printError('--chain requires exactly one key argument.', 'INVALID_INPUT');
        process.exitCode = 1;
        return;
      }
      const chainKey = keys[0];
      const resolvedChainKey = resolveKey(chainKey, scope);
      const chainValue = getValue(resolvedChainKey, scope);
      if (chainValue === undefined) {
        printError(`Entry '${chainKey}' not found.`, 'NOT_FOUND');
        process.exitCode = 1;
        return;
      }
      if (typeof chainValue !== 'string') {
        printError(`Entry '${chainKey}' is not a string value.`, 'INVALID_INPUT');
        process.exitCode = 1;
        return;
      }
      // Split on whitespace to get key references, then run them as if passed as CLI args
      const chainKeys = chainValue.trim().split(/\s+/);
      if (chainKeys.length === 0 || (chainKeys.length === 1 && chainKeys[0] === '')) {
        printError(`Entry '${chainKey}' is empty.`, 'INVALID_INPUT');
        process.exitCode = 1;
        return;
      }
      debug('chain resolved', { chainKey, chainKeys });
      // Recurse without --chain to run the resolved keys normally
      return runCommand(chainKeys, { ...options, chain: false });
    }

    const commands: string[] = [];
    // SECURITY: raw (pre-interpolation) segments are retained so the actual
    // execution can resolve `$(key)` exec refs separately from the safe display
    // value. `commands` (below) is built with the non-exec interpolation pass
    // and drives all preview/dry/confirm output; exec refs only run at the
    // execution moment via interpolateExec(rawValue).
    const rawCommands: string[] = [];
    const resolvedKeys: string[] = [];

    for (const keyGroup of keys) {
      // Split on : for composition (e.g. "cd:reverie" → "cd /path")
      const segments = keyGroup.replace(/:$/, '').split(':');
      const resolvedSegments: string[] = [];
      const rawSegments: string[] = [];

      for (const segment of segments) {
        const resolvedKey = resolveKey(segment, scope);
        resolvedKeys.push(resolvedKey);
        let value = getValue(resolvedKey, scope);

        if (value === undefined) {
          printError(`Entry '${segment}' not found.`, 'NOT_FOUND');
          process.exitCode = 1;
          return;
        }

        if (typeof value !== 'string') {
          printError(`Entry '${segment}' is not a string command (got ${typeof value}).`, 'INVALID_INPUT');
          process.exitCode = 1;
          return;
        }

        if (isEncrypted(value)) {
          if (!options.decrypt) {
            printError(`Entry '${segment}' is encrypted. Use --decrypt to decrypt and run.`, 'ENCRYPTED_NO_PASSWORD');
            process.exitCode = 1;
            return;
          }
          let password: string;
          try {
            password = await askPassword('Password: ', { passwordFile: options.passwordFile });
          } catch (err) {
            printError(err instanceof Error ? err.message : String(err));
            return;
          }
          try {
            value = decryptValue(value, password);
          } catch {
            printError('Decryption failed. Wrong password or corrupted data.', 'DECRYPT_FAILED');
            process.exitCode = 1;
            return;
          }
        }

        // Retain the raw value for exec-time resolution; the displayed/preview
        // value uses the SAFE (non-exec) interpolation pass.
        rawSegments.push(value);
        try {
          value = interpolate(value);
        } catch (err) {
          // #215: a `${key}` that names an unreadable entry. The outer catch
          // reports it as STORE_UNREADABLE and marks the file as shown;
          // printError here would call it RUNTIME and name the file twice.
          if (err instanceof StoreUnreadableError) throw err;
          printError(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return;
        }

        resolvedSegments.push(value);
      }

      commands.push(resolvedSegments.join(' '));
      rawCommands.push(rawSegments.join(' '));
    }

    const value = commands.join(' && ');
    const rawValue = rawCommands.join(' && ');

    // #158: the confirm gate must cover every key run touches, not just the
    // top-level segments. A hostile non-gated entry that references a
    // confirm-gated command via ${key} or $(key) would otherwise execute it
    // with no prompt. Enumerate the transitive key set (no execution) and
    // gate on any of them carrying confirm metadata.
    const confirmKeys = new Set<string>(resolvedKeys);
    for (const k of collectReferencedKeys(rawValue)) confirmKeys.add(k);
    // #215: fail closed. An unreadable confirmation list loads as empty, so
    // while one is unreadable every entry is gated. hasConfirm runs first —
    // it does the scan the second check reads.
    const anyKeyNeedsConfirm = [...confirmKeys].some(k => hasConfirm(k)) || confirmListUnreadable();

    // SECURITY: produce the real shell command ONLY when actually executing —
    // this is the single place `$(key)` exec refs run. Callers invoke it past
    // the dry/confirm gate; on interpolation error it reports and returns
    // undefined so the caller aborts without executing.
    const buildExecCommand = (): string | undefined => {
      try {
        return interpolateExec(rawValue);
      } catch (err) {
        if (err instanceof StoreUnreadableError) throw err; // #215, as above
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return undefined;
      }
    };

    // JSON mode (#117 WS1): produce a structured result instead of streaming
    // the child's stdio. --source (the shell-eval wrapper path) is exempt — it
    // is an internal integration, not an agent surface.
    if (isJsonMode() && !options.source) {
      const needsConfirmJson = anyKeyNeedsConfirm;
      if (options.dry) {
        setResult({ keys: resolvedKeys, command: value });
        return;
      }
      // Replaces the MCP two-step confirm-token flow: a stateless refusal the
      // host gates on, then re-runs with --yes (see design doc). The resolved
      // command rides in error.preview.
      if (needsConfirmJson && !options.yes) {
        setResult({ keys: resolvedKeys, command: value });
        failJson('REQUIRES_CONFIRMATION', `Entry requires confirmation. Re-run with --yes to execute.`, value);
        return;
      }
      const execValue = buildExecCommand();
      if (execValue === undefined) return;
      const proc = spawnSync(execValue, { encoding: 'utf-8', shell: process.env.SHELL ?? '/bin/sh' });
      // A spawn failure (bad $SHELL, ENOENT, EACCES) leaves status AND signal
      // null. Without this guard exitCode would resolve to 0 and the command
      // would report ok:true having run nothing.
      if (proc.error) {
        setResult({ keys: resolvedKeys, command: value, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' });
        failJson('COMMAND_FAILED', `Failed to spawn command: ${proc.error.message}`, value);
        process.exitCode = 1;
        return;
      }
      const exitCode = proc.status ?? (proc.signal ? 1 : 0);
      setResult({ keys: resolvedKeys, command: value, exitCode, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' });
      if (exitCode !== 0) {
        failJson('COMMAND_FAILED', `Command exited with code ${exitCode}.`, value);
      }
      process.exitCode = exitCode;
      return;
    }

    if (options.source) {
      process.stderr.write(color.gray('$ ') + color.white(value) + '\n');
    } else {
      console.log(color.gray('$ ') + color.white(value));
    }

    if (options.dry) {
      return;
    }

    // Only prompt if any resolved key has confirm metadata set (and --yes not passed)
    const needsConfirm = anyKeyNeedsConfirm;
    if (needsConfirm && !options.yes) {
      if (process.stdin.isTTY) {
        const answer = await askConfirmation('Run this? [y/N] ', options.source ? process.stderr : undefined);
        if (answer.toLowerCase() !== 'y') {
          if (options.source) {
            process.stderr.write('Aborted.\n');
          } else {
            console.log('Aborted.');
          }
          return;
        }
      } else {
        // Fail closed: with no TTY there is no one to answer the prompt. Earlier
        // this branch was skipped entirely, so a confirm-gated entry ran
        // unconfirmed on the non-interactive (agent/CI/piped) surface the
        // tripwire is meant to protect. Refuse and tell the caller how to opt in.
        printError(
          `Entry requires confirmation. Re-run with --yes to execute non-interactively.`,
          'REQUIRES_CONFIRMATION',
        );
        process.exitCode = 1;
        return;
      }
    }

    // Past the dry/confirm gate — now resolve `$(key)` exec refs for real.
    // --source emits the resolved command for the parent shell to eval, so it
    // too must use Reverie-resolved exec refs (not leave `$(key)` for the shell
    // to reinterpret as its own command substitution).
    const execValue = buildExecCommand();
    if (execValue === undefined) return;

    if (options.source) {
      process.stdout.write(execValue + '\n');
    } else if (options.capture) {
      try {
        const stdout = execSync(execValue, { encoding: 'utf-8', shell: process.env.SHELL ?? '/bin/sh' });
        process.stdout.write(stdout);
      } catch (err: unknown) {
        recordErrorCode('COMMAND_FAILED'); // the code the JSON branch reports (#203)
        process.exitCode = (err && typeof err === 'object' && 'status' in err ? Number(err.status) : 1) || 1;
        if (err && typeof err === 'object' && 'stderr' in err && (err as { stderr?: string }).stderr) {
          process.stderr.write(String((err as { stderr?: string }).stderr));
        }
      }
    } else {
      try {
        execSync(execValue, { stdio: 'inherit', shell: process.env.SHELL ?? '/bin/sh' });
      } catch (err: unknown) {
        recordErrorCode('COMMAND_FAILED');
        process.exitCode = (err && typeof err === 'object' && 'status' in err ? Number(err.status) : 1) || 1;
      }
    }
  } catch (error) {
    handleError('Failed to run command:', error);
  }
}

async function promptAndEncrypt(value: string, passwordFile?: string): Promise<string | null> {
  let password: string;
  try {
    password = await askPassword('Password: ', { passwordFile });
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return null;
  }
  // Non-interactive sources (env var, --password-file) read the same value
  // twice and would always match — no confirm step needed. Skip it when a
  // non-interactive source is active so users don't see a redundant prompt.
  if (passwordFile || process.env.RVR_PASSWORD) {
    return encryptValue(value, password);
  }
  const confirmPw = await askPassword('Confirm password: ');
  const passwordBuf = Buffer.from(password);
  const confirmBuf = Buffer.from(confirmPw);
  if (passwordBuf.length !== confirmBuf.length || !crypto.timingSafeEqual(passwordBuf, confirmBuf)) {
    printError('Passwords do not match.', 'INVALID_INPUT');
    process.exitCode = 1;
    return null;
  }
  return encryptValue(value, password);
}

/**
 * What still gates `key` after a command cleared a flag from it, as a
 * message, or null when nothing does. Clearing takes the flag listed under
 * the name given, in the list of the store it is given for — nothing else,
 * or it would take the flag of another entry. So the key can still be gated,
 * and reporting it cleared would be false. `removed` says whether the named
 * flag was there to remove.
 */
export function stillGatedNote(key: string, removed: boolean): string | null {
  const held = flagsGating(key);
  if (held.length === 0) return null;
  const bin = getBinaryName();
  const where = held.map(h => `'${h.key}' in the ${h.scope} list`).join(' and ');
  const fix = held.map(h => `\`${bin} confirm remove ${h.scope === 'global' ? '-G ' : ''}${h.key}\``).join(', ');
  const lead = removed
    ? `The flag listed as '${key}' was removed, but '${key}' still requires confirmation`
    : `'${key}' still requires confirmation`;
  return `${lead}: it is flagged as ${where}. A flag is removed only under the name and in the list it is in: ${fix}.`;
}

/**
 * The keys stored in the scope a lookup of `scope` covers. Each store is read
 * on its own: the default view (loadData with no scope) replaces a whole
 * top-level namespace of the global store with the project's, which hides
 * global keys that a lookup by key still finds.
 */
function storedKeys(scope?: Scope): string[] {
  if (scope === 'project' || scope === 'global') return Object.keys(flattenObject(loadData(scope)));
  const keys = new Set(Object.keys(flattenObject(loadData('global'))));
  if (findProjectFile()) for (const k of Object.keys(flattenObject(loadData('project')))) keys.add(k);
  return [...keys];
}

/**
 * Why a confirmation flag cannot be set on `key` (or, with `setting` false,
 * cleared from it), or null when it can.
 *
 * A flag gates `run`, and `run` takes an entry that holds a command. Two
 * requests used to report "now requires confirmation" and gate nothing, and
 * are refused:
 *
 *   - a key that names no entry (a typo): `confirm set` did not look;
 *   - a namespace: the lookup found the subtree, and `run` never takes one.
 *
 * Another spelling of an entry is accepted. The gate matches a flag by name,
 * case aside, and by the file the name opens (confirm.ts), so a flag listed
 * as `commands.Deploy` does gate the entry stored as `commands.deploy`.
 * Refusing it would leave unflagged what the user asked to flag.
 *
 * Clearing is looser about one thing: a namespace is accepted, so a flag
 * that an older version put on one can be taken off again.
 *
 * `unreadableIsEntry`: an entry whose file cannot be read (#215) is still an
 * entry. `confirm set` flags it; the flag-only `set` keeps refusing, as it
 * does for every other write to such a key, by letting the read throw.
 */
export function confirmTargetProblem(
  key: string,
  scope?: Scope,
  setting = true,
  unreadableIsEntry = false,
): { message: string; code: 'NOT_FOUND' | 'INVALID_INPUT' } | null {
  let value: CodexValue | undefined;
  try {
    value = getValue(key, scope);
  } catch (err) {
    if (unreadableIsEntry && err instanceof StoreUnreadableError) return null;
    throw err;
  }
  if (value !== undefined && typeof value !== 'string') {
    return !setting ? null : {
      code: 'INVALID_INPUT',
      message: `'${key}' is a namespace, not an entry. A confirmation flag goes on an entry that holds a command: set it on the entries under '${key}'.`,
    };
  }
  // An entry reads under this key: stored under it, or under a spelling the
  // filesystem folds onto it.
  if (value !== undefined) return null;
  // Nothing reads. On a filesystem that folds nothing, another case of a
  // stored key lands here, and it names an entry all the same.
  const lower = key.toLowerCase();
  if (storedKeys(scope).some(k => k.toLowerCase() === lower)) return null;
  return { code: 'NOT_FOUND', message: `Entry '${key}' not found. Cannot update confirm on a non-existent entry.` };
}

async function handlePostSetConfirm(key: string, confirm: boolean | undefined, scope?: Scope  ): Promise<void> {
  if (confirm === true) {
    setConfirm(key, scope);
  } else if (confirm === false) {
    const removed = removeConfirm(key, scope);
    // The value is stored either way; say so if the key is still gated.
    const note = stillGatedNote(key, removed);
    if (note) printWarning(note);
  } else if (process.stdin.isTTY) {
    // #215: with the confirmation list unreadable the answer could not be
    // saved — the value is already written, so do not ask.
    let confirmUnreadable = false;
    try {
      confirmUnreadable = listUnreadableFiles(resolveScopeForWrite(scope)).some(f => f.kind === 'confirm');
    } catch { /* unresolvable scope: nothing was scanned, nothing to skip for */ }
    if (confirmUnreadable) return;
    const answer = await askConfirmation('Require confirmation to run? [y/N] ');
    if (answer.toLowerCase() === 'y') {
      setConfirm(key, scope);
    }
  }
}

export async function setEntry(key: string, value: string | undefined, force = false, encrypt = false, alias?: string, confirm?: boolean, global?: boolean, passwordFile?: string): Promise<{ key: string; alias?: string; confirm?: boolean } | undefined> {
  debug('setEntry called', { key, force, encrypt, alias, confirm, global });
  const scope = toScope(global);
  try {
    ensureDataDirectoryExists();

    // Confirm-only or alias-only update: no value provided
    if (value === undefined) {
      // Handle --confirm / --no-confirm on an existing entry (no value needed)
      if (confirm !== undefined) {
        const problem = confirmTargetProblem(key, scope, confirm);
        if (problem) {
          printError(problem.message, problem.code);
          process.exitCode = 1;
          return;
        }
        // #215: the confirmation list, then (with -a) the alias map. Check
        // both before the first write, as the value path does below — and
        // refuse a --no-confirm that cannot see the flag it is asked to drop.
        assertSidecarsWritable(() => resolveScopeForWrite(scope), alias ? ['confirm', 'aliases'] : ['confirm']);
        if (confirm) {
          setConfirm(key, scope);
          printSuccess(`Entry '${key}' now requires confirmation to run.`);
        } else {
          const removed = removeConfirm(key, scope);
          const note = stillGatedNote(key, removed);
          if (note) {
            printError(note, 'INVALID_INPUT');
            process.exitCode = 1;
          } else {
            printSuccess(`Entry '${key}' no longer requires confirmation to run.`);
          }
        }
        if (alias) {
          setAlias(alias, key, scope);
        }
        // Return a result so the #120 wrapper doesn't emit a result-less ok
        // envelope — `set <key> --confirm` succeeds without storing a value.
        return { key, confirm, ...(alias ? { alias } : {}) };
      }
      if (!alias) {
        printError('Missing value. Provide a value or use --alias (-a) to update an alias.', 'INPUT_REQUIRED');
        process.exitCode = 1;
        return;
      }
      const existing = getValue(key, scope);
      if (existing === undefined) {
        printError(`Entry '${key}' not found. Cannot set alias on a non-existent entry.`, 'NOT_FOUND');
        process.exitCode = 1;
        return;
      }
      setAlias(alias, key, scope);
      return { key, alias };
    }

    const existing = getValueForWrite(key, scope);
    if (existing !== undefined && !force && process.stdin.isTTY) {
      const displayVal = typeof existing === 'object'
        ? JSON.stringify(existing)
        : isEncrypted(String(existing)) ? '[encrypted]' : String(existing);
      console.log(`Key '${key}' already exists with value: ${displayVal}`);
      const answer = await askConfirmation('Overwrite? [y/N] ');
      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
    }

    let storedValue = value;
    if (encrypt) {
      const encrypted = await promptAndEncrypt(value, passwordFile);
      if (encrypted === null) return;
      storedValue = encrypted;
    }

    // #215: this command writes up to three files — the value, then the
    // alias map, then the confirmation list. Check the sidecars it will touch
    // before the value lands, so a refusal leaves nothing half-written.
    const sidecars: ('aliases' | 'confirm')[] = [];
    if (alias) sidecars.push('aliases');
    if (confirm !== undefined) sidecars.push('confirm');
    if (sidecars.length > 0) assertSidecarsWritable(() => resolveScopeForWrite(scope), sidecars);

    setValue(key, storedValue, scope);
    console.log(`Entry '${key}' set successfully.`);
    markValueStored();
    if (alias) {
      setAlias(alias, key, scope);
    }

    await handlePostSetConfirm(key, confirm, scope);
    return { key, ...(alias ? { alias } : {}) };
  } catch (error) {
    handleError('Failed to set entry:', error);
    return undefined;
  }
}

function displayFlatEntries(flat: Record<string, string>, aliasMap: Record<string, string>, options: GetOptions): void {
  // Keys-only mode: no key specified and --values not set
  if (!options.values) {
    if (options.plain) {
      for (const k of Object.keys(flat)) {
        console.log(k);
      }
      return;
    }
    displayKeys(Object.keys(flat), aliasMap);
    return;
  }

  const unresolved: [string, UnresolvedOnRead][] = [];
  let entries: Record<string, CodexValue>;
  try {
    entries = options.source
      ? flat
      : interpolateObject(flat, (k, u) => { unresolved.push([k, u]); });
  } catch (err) {
    // A `:?` or a cycle in one entry of the listing (or a fault): the
    // one-line error a get of that entry gives. This used to escape as a
    // stack trace.
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  warnUnresolved(unresolved);

  if (options.plain) {
    for (const [k, v] of Object.entries(entries)) {
      const strVal = typeof v === 'string' ? v : JSON.stringify(v);
      console.log(`${k}: ${isEncrypted(strVal) ? '[encrypted]' : strVal}`);
    }
    return;
  }

  displayEntries(entries as Record<string, string>, aliasMap);
}

function jsonFlatEntries(data: Record<string, string> | Record<string, CodexValue>, source = false): Record<string, string> {
  const flat = flattenObject(data);
  const result: Record<string, string> = {};
  const unresolved: [string, UnresolvedOnRead][] = [];
  for (const [k, v] of Object.entries(flat)) {
    if (isEncrypted(v)) {
      result[k] = '[encrypted]';
    } else if (source) {
      // --source: the stored text. JSON mode ignored the flag and resolved
      // the value anyway, so `get -s --json` warned where `get -s` did not.
      result[k] = v;
    } else {
      // A `:?` or a cycle keeps the raw value here, as it always has.
      try {
        const read = interpolateForRead(v);
        result[k] = read.value;
        if (read.unresolved) unresolved.push([k, read.unresolved]);
      } catch { result[k] = v; }
    }
  }
  warnUnresolved(unresolved);
  return result;
}

function displayScopedEntries(scope: 'project' | 'global', aliasMap: Record<string, string>, options: GetOptions): void {
  const label = scope === 'project' ? 'Project' : 'Global';
  const data = loadData(scope);

  if (Object.keys(data).length === 0) {
    if (!options.plain) {
      console.log(color.bold(`${label}:`));
      console.log(color.gray('  No entries'));
      console.log('');
    }
    return;
  }

  if (!options.plain) {
    console.log(color.bold(`${label}:`));
  }

  if (options.tree) {
    displayTree(data, aliasMap, '', '', !!options.plain, undefined, !!options.source, !options.values, options.depth);
  } else {
    displayFlatEntries(flattenObject(data, '', options.depth), aliasMap, options);
  }
  console.log('');
}

function displayAllEntries(data: Record<string, CodexValue>, aliasMap: Record<string, string>, options: GetOptions): void {
  if (Object.keys(data).length === 0) {
    if (options.plain) return;
    console.log(color.gray(`No entries found. Add one with "${getBinaryName()} set <key> <value>"`));
    console.log('');
    return;
  }

  if (options.tree) {
    displayTree(data, aliasMap, '', '', !!options.plain, undefined, !!options.source, !options.values, options.depth);
    return;
  }

  displayFlatEntries(flattenObject(data, '', options.depth), aliasMap, options);
}

function displaySubtree(key: string, value: Record<string, CodexValue>, aliasMap: Record<string, string>, options: GetOptions): void {
  if (options.tree) {
    displayTree({ [key]: value }, aliasMap, '', '', !!options.plain, undefined, !!options.source, !options.values, options.depth);
    return;
  }

  const flat = flattenObject({ [key]: value }, '', options.depth);

  if (Object.keys(flat).length === 0) {
    console.log(`No entries found under '${key}'.`);
    return;
  }

  displayFlatEntries(flat, aliasMap, options);
}

export async function getEntry(key?: string, options: GetOptions = {}): Promise<void> {
  debug('getEntry called', { key, options });

  // Resolve listing scope: --global → global, --all → both, default → project if exists else global
  const hasProject = !!findProjectFile();
  const listingScope: Scope | undefined = options.global ? 'global' : (hasProject && !options.all) ? 'project' : undefined;
  // For single-key lookups, use auto fallthrough (project → global)
  const lookupScope = toScope(options.global);

  // --json output mode (no alias map needed). The value goes inside the WS1
  // envelope's `result` (decision D3 — the bare-value shape was a documented
  // break). The instrumentation wrapper emits the single envelope. JSON mode
  // is global state set by the preAction hook from --json/RVR_OUTPUT.
  if (isJsonMode()) {
    if (!key) {
      if (options.all && hasProject) {
        setResult({ project: jsonFlatEntries(loadData('project'), options.source), global: jsonFlatEntries(loadData('global'), options.source) });
      } else if (options.aliases) {
        setResult({ aliases: loadAliases(listingScope) });
      } else {
        setResult(jsonFlatEntries(loadData(listingScope), options.source));
      }
      return;
    }

    const val = getValue(key, lookupScope);
    if (val === undefined) {
      failJson('NOT_FOUND', `Entry '${key}' not found`);
      return;
    }
    if (typeof val === 'object' && val !== null) {
      setResult(jsonFlatEntries(flattenObject({ [key]: val }), options.source));
    } else {
      const strVal = String(val);
      let displayVal: string;
      if (isEncrypted(strVal)) {
        displayVal = '[encrypted]';
      } else if (options.source) {
        displayVal = strVal; // --source: the stored text, as in text mode
      } else {
        // A `:?` or a cycle keeps the raw value here, as it always has.
        try {
          const read = interpolateForRead(strVal);
          displayVal = read.value;
          if (read.unresolved) warnUnresolved([[key, read.unresolved]]);
        } catch { displayVal = strVal; }
      }
      setResult({ [key]: displayVal });
    }
    return;
  }

  const aliasMap = buildKeyToAliasMap();

  if (!key) {
    // -a → aliases only
    if (options.aliases) {
      const aliases = loadAliases(listingScope);
      displayAliases(aliases);
      return;
    }

    // --all: show both scopes with section headers
    if (options.all && hasProject) {
      displayScopedEntries('project', aliasMap, options);
      displayScopedEntries('global', aliasMap, options);
      return;
    }

    const data = loadData(listingScope);
    displayAllEntries(data, aliasMap, options);
    return;
  }

  const value = getValue(key, lookupScope);

  if (value === undefined) {
    printError(`Entry '${key}' not found.`, 'NOT_FOUND');
    process.exitCode = 1;
    return;
  }

  if (typeof value === 'object' && value !== null) {
    if (options.copy) {
      printWarning('--copy only works with a single value, not a subtree.');
    }
    displaySubtree(key, value, aliasMap, options);
    return;
  }

  const strValue = String(value);

  if (isEncrypted(strValue) && options.decrypt) {
    let password: string;
    try {
      password = await askPassword('Password: ', { passwordFile: options.passwordFile });
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      return;
    }
    let decrypted: string;
    try {
      decrypted = decryptValue(strValue, password);
    } catch {
      printError('Decryption failed. Wrong password or corrupted data.', 'DECRYPT_FAILED');
      process.exitCode = 1;
      return;
    }
    let decryptedDisplay: string;
    try {
      // #202: an unresolved reference is returned as written, with a warning.
      const read = interpolateForRead(decrypted);
      decryptedDisplay = read.value;
      if (read.unresolved) warnUnresolved([[key, read.unresolved]]);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    if (options.copy) {
      try {
        copyToClipboard(decryptedDisplay);
        printSuccess('Copied to clipboard.');
        return;
      } catch (err) {
        printError(`Failed to copy: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (options.plain) {
      console.log(decryptedDisplay);
    } else {
      displayEntries({ [key]: decryptedDisplay }, aliasMap);
    }
    return;
  }

  // Interpolate unless encrypted or --source
  let displayValue = strValue;
  if (!isEncrypted(strValue) && !options.source) {
    try {
      // #202: an unresolved reference is returned as written, with a warning —
      // the same answer `get --json` and a subtree listing give. This used to
      // fail with exit 1, so an entry documenting a tool with \${VAR} syntax
      // could not be read at all. Only a `:?` or a cycle still fails here.
      const read = interpolateForRead(strValue);
      displayValue = read.value;
      if (read.unresolved) warnUnresolved([[key, read.unresolved]]);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }

  if (options.copy) {
    const copyValue = isEncrypted(strValue) ? '[encrypted]' : displayValue;
    try {
      copyToClipboard(copyValue);
      printSuccess('Copied to clipboard.');
      return;
    } catch (err) {
      printError(`Failed to copy: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (options.plain) {
    console.log(isEncrypted(strValue) ? '[encrypted]' : displayValue);
    return;
  }

  displayEntries({ [key]: displayValue }, aliasMap);

  // Staleness warning for CLI users
  const meta = options.global ? loadMeta('global') : loadMetaMerged();
  const staleTag = getStalenessTag(key, meta);
  if (staleTag) {
    printWarning(`Entry not updated recently${staleTag}`);
  }
}

export async function editEntry(key: string, options: { decrypt?: boolean, global?: boolean, passwordFile?: string } = {}): Promise<void> {
  debug('editEntry called', { key, options });
  const scope = toScope(options.global);
  try {
    const editor = process.env.VISUAL ?? process.env.EDITOR;
    if (!editor) {
      printError('No editor configured. Set $EDITOR or $VISUAL environment variable.', 'INVALID_INPUT');
      process.exitCode = 1;
      return;
    }

    let value = getValue(key, scope);

    if (value === undefined) {
      printError(`Entry '${key}' not found.`, 'NOT_FOUND');
      process.exitCode = 1;
      return;
    }

    if (typeof value !== 'string') {
      printError(`Entry '${key}' is a subtree, not a single value. Cannot edit.`, 'INVALID_INPUT');
      process.exitCode = 1;
      return;
    }

    let password: string | undefined;
    if (isEncrypted(value)) {
      if (!options.decrypt) {
        printError(`Entry '${key}' is encrypted. Use --decrypt to edit.`, 'ENCRYPTED_NO_PASSWORD');
        process.exitCode = 1;
        return;
      }
      try {
        password = await askPassword('Password: ', { passwordFile: options.passwordFile });
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        return;
      }
      try {
        value = decryptValue(value, password);
      } catch {
        printError('Decryption failed. Wrong password or corrupted data.', 'DECRYPT_FAILED');
        process.exitCode = 1;
        return;
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-edit-'));
    const tmpFile = path.join(tmpDir, 'value.tmp');
    fs.writeFileSync(tmpFile, value, { encoding: 'utf8', mode: 0o600 });

    try {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd' : (process.env.SHELL ?? '/bin/sh');
      const shellArgs = isWindows
        ? ['/c', `${editor} "%RVR_TMPFILE%"`]
        : ['-c', `${editor} "$RVR_TMPFILE"`];
      const result = spawnSync(shell, shellArgs, {
        stdio: 'inherit',
        env: { ...process.env, RVR_TMPFILE: tmpFile },
      });
      if (result.error) throw result.error;
      if (result.status !== 0 && result.status !== null) {
        throw new Error(`Editor exited with code ${result.status}`);
      }
      const newValue = fs.readFileSync(tmpFile, 'utf8');

      if (newValue === value) {
        console.log('No changes made.');
        return;
      }

      let storedValue = newValue;
      if (password) {
        storedValue = encryptValue(newValue, password);
      }

      setValue(key, storedValue, scope);
      printSuccess(`Entry '${key}' updated successfully.`);
      markValueStored();
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore cleanup errors */ }
    }
  } catch (error) {
    handleError('Failed to edit entry:', error);
  }
}

export async function removeEntry(key: string, force = false, global?: boolean): Promise<{ key: string; removed: true } | undefined> {
  debug('removeEntry called', { key, force, global });
  const scope = toScope(global);

  // #215: an entry under this key that cannot be read is invisible to the
  // removal — it would stay on disk while the cascade below drops its alias
  // and its confirmation flag. Checked before the lookup: a key whose only
  // children are unreadable looks absent, and "not found" is the wrong answer.
  assertSubtreeReadable(() => resolveScopeForWrite(scope), key, 'remove');

  const existing = getValue(key, scope);
  if (existing === undefined) {
    printWarning(`Entry '${key}' not found.`);
    return;
  }

  if (!force && process.stdin.isTTY) {
    const answer = await askConfirmation(`Remove '${key}'? [y/N] `);
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  // #215: removal cascades to the alias map and the confirmation list. If
  // either cannot be read the cascade cannot see what points at this key, so
  // refuse before the entry is gone rather than leave them dangling.
  assertSidecarsWritable(() => resolveScopeForWrite(scope), ['aliases', 'confirm']);

  if (!removeValue(key, scope)) {
    // The lookup above falls through from the project store to the global
    // one; the removal deliberately does not (#99). So a key that exists
    // only in the global store was found, not removed, and reported as
    // "removed successfully". Say what happened, and skip the cascade.
    printError(`Entry '${key}' not found in the project store. It exists in the global store: pass --global to remove it there.`, 'NOT_FOUND');
    process.exitCode = 1;
    return;
  }

  // Cascade delete: remove any aliases pointing to this key or its children
  removeAliasesForKey(key, scope);

  // #244: the confirmation flags stay. A flag gates by name and the global
  // list is read in every project, so a flag listed under this key may be
  // what gates another project's entry of the same name — which this removal
  // cannot see. As with rename (#234), only `confirm remove` clears a flag.
  printSuccess(`Entry '${key}' removed successfully.`);
  const kept = flagsListedUnder(key, scope);
  if (kept.length > 0) {
    printWarning(`The confirmation flag${kept.length === 1 ? '' : 's'} listed under ${kept.map(k => `'${k}'`).join(', ')} stay${kept.length === 1 ? 's' : ''}: a flag gates its name in every project. Clear ${kept.length === 1 ? 'it' : 'them'} with \`${getBinaryName()} confirm remove\` once nothing uses ${kept.length === 1 ? 'it' : 'them'}.`);
  }
  return { key, removed: true };
}

export async function copyEntry(sourceKey: string, destKey: string, force = false, global?: boolean): Promise<{ source: string; dest: string } | undefined> {
  debug('copyEntry called', { sourceKey, destKey, force, global });
  const scope = toScope(global);
  try {
    const value = getValue(sourceKey, scope);
    if (value === undefined) {
      printError(`Entry '${sourceKey}' not found.`, 'NOT_FOUND');
      process.exitCode = 1;
      return;
    }

    const existing = getValueForWrite(destKey, scope);
    if (existing !== undefined && !force && process.stdin.isTTY) {
      const displayVal = typeof existing === 'object'
        ? JSON.stringify(existing)
        : isEncrypted(String(existing)) ? '[encrypted]' : String(existing);
      console.log(`Key '${destKey}' already exists with value: ${displayVal}`);
      const answer = await askConfirmation('Overwrite? [y/N] ');
      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
    }

    if (typeof value === 'string') {
      setValue(destKey, value, scope);
    } else {
      // Batch: load once, set all leaves, save once (instead of O(L) file writes).
      // Apply the project-resolution guard here too — this path bypasses
      // storage.ts setValue, so the guard would otherwise be skipped (#99).
      const effectiveScope = resolveScopeForWrite(scope);
      // This path does not go through setValue, so it validates the
      // destination itself: setNestedValue drops an unsafe segment silently,
      // and the copy would report success having written nothing.
      if (!isValidEntryKey(destKey)) throw new Error(`Invalid store key: ${JSON.stringify(destKey)}`);
      const leaves = Object.entries(flattenObject({ [sourceKey]: value }))
        .map(([flatKey, flatVal]): [string, string] => [destKey + flatKey.slice(sourceKey.length), String(flatVal)]);
      // #254: under the store lock, against the store as it stands there.
      updateEntries((entries, meta) => {
        // #216 / #224: every destination leaf is checked against the store
        // as it stands, before the first is set. A refusal saves nothing.
        assertKeysWritable(entries, leaves.map(([leafKey]) => leafKey));
        for (const [leafKey, leafValue] of leaves) setNestedValue(entries, leafKey, leafValue);
        meta[destKey] = Date.now();
      }, effectiveScope);
    }

    printSuccess(`Entry '${sourceKey}' copied to '${destKey}'.`);
    return { source: sourceKey, dest: destKey };
  } catch (error) {
    handleError('Failed to copy entry:', error);
    return undefined;
  }
}

export function renameEntry(oldKey: string, newKey: string, aliasMode = false, newAlias?: string, global?: boolean): { from: string; to: string; kind: string; alias?: string } | undefined {
  debug('renameEntry called', { oldKey, newKey, aliasMode, newAlias, global });
  const scope = toScope(global);

  if (aliasMode) {
    const result = renameAlias(oldKey, newKey, scope);
    if (!result) {
      const aliases = loadAliases(scope);
      if (!(oldKey in aliases)) {
        printError(`Alias '${oldKey}' not found.`, 'NOT_FOUND');
      } else {
        printError(`Alias '${newKey}' already exists.`, 'INVALID_INPUT');
      }
      process.exitCode = 1;
      return;
    }
    printSuccess(`Alias '${oldKey}' renamed to '${newKey}'.`);
    return { from: oldKey, to: newKey, kind: 'alias' };
  }

  // Entry key rename
  // #215: an unreadable entry under the old key would be left behind while
  // its alias and its confirmation flag move to the new name.
  assertSubtreeReadable(() => resolveScopeForWrite(scope), oldKey, 'rename');
  const value = getValue(oldKey, scope);
  if (value === undefined) {
    printError(`Entry '${oldKey}' not found.`, 'NOT_FOUND');
    process.exitCode = 1;
    return;
  }

  // #224: the move below writes the new keys and then removes the old key
  // with everything under it. Refuse a destination that would be removed
  // with it, or that cannot be stored at all — both used to report success
  // with the entries gone.
  const destinationProblem = renameDestinationProblem(oldKey, newKey, isValidEntryKey);
  if (destinationProblem) {
    printError(destinationProblem, 'INVALID_INPUT');
    process.exitCode = 1;
    return;
  }

  const existing = getValueForWrite(newKey, scope);
  if (existing !== undefined) {
    printError(`Entry '${newKey}' already exists. Remove it first or choose a different key.`, 'INVALID_INPUT');
    process.exitCode = 1;
    return;
  }

  // #215: a rename moves the value, re-points aliases and moves the confirm
  // flag. With either sidecar unreadable it cannot know what to carry over —
  // refuse before the value moves.
  assertSidecarsWritable(() => resolveScopeForWrite(scope), ['aliases', 'confirm']);

  // Which of the entries about to move does the gate ask about? Asked now:
  // it looks at their files, and afterwards those are gone.
  const leaves = renamedLeaves(oldKey, newKey, value);
  const gatedNow = gatedAmong(leaves.map(([from]) => from));
  const gatedLeaves = leaves.filter(([from]) => gatedNow.has(from));

  // Move the value. A refused collision (#216 / #224) is thrown before
  // anything is written; report it and leave the source where it is.
  try {
    if (typeof value === 'string') {
      setValue(newKey, value, scope);
    } else {
      // Batch: load once, set all leaves, save once (instead of O(L) file writes).
      // Apply the project-resolution guard here too — this path bypasses
      // storage.ts setValue, so the guard would otherwise be skipped (#99).
      const effectiveScope = resolveScopeForWrite(scope);
      const leaves = Object.entries(flattenObject({ [oldKey]: value }))
        .map(([flatKey, flatVal]): [string, string] => [newKey + flatKey.slice(oldKey.length), String(flatVal)]);
      // #254: under the store lock, against the store as it stands there.
      updateEntries((entries, meta) => {
        assertKeysWritable(entries, leaves.map(([leafKey]) => leafKey));
        for (const [leafKey, leafValue] of leaves) setNestedValue(entries, leafKey, leafValue);
        meta[newKey] = Date.now();
      }, effectiveScope);
    }
  } catch (error) {
    handleError('Failed to rename entry:', error);
    return;
  }
  removeValue(oldKey, scope);

  // Update aliases: re-point any alias targeting oldKey (or children) to newKey.
  // Batch: one write for all of them (instead of O(A*4) file I/O). Decided
  // against the map as it stands under the store lock (#254).
  const oldPrefix = oldKey + '.';
  const repoint = (current: Record<string, string>): Record<string, string> | null => {
    // First pass: collect re-point updates (alias -> newTarget)
    const updates: [string, string][] = [];
    for (const [alias, target] of Object.entries(current)) {
      if (target === oldKey) {
        updates.push([alias, newKey]);
      } else if (target.startsWith(oldPrefix)) {
        updates.push([alias, newKey + target.slice(oldKey.length)]);
      }
    }
    if (updates.length === 0) return null;

    // Enforce one-alias-per-entry: remove any existing alias already pointing
    // to one of the new targets before re-pointing (same rule as setAlias)
    const aliases = { ...current };
    const newTargets = new Set(updates.map(([, t]) => t));
    for (const [alias, target] of Object.entries(aliases)) {
      if (newTargets.has(target)) {
        delete aliases[alias];
      }
    }
    // Apply re-pointings
    for (const [alias, newTarget] of updates) {
      aliases[alias] = newTarget;
    }
    return aliases;
  };
  // Nothing points at the old key: nothing to write.
  if (repoint(loadAliases(scope)) !== null) updateAliases(repoint, scope);

  // Confirm metadata: each gated entry that moved is flagged under its new
  // key. The old name keeps its flag — it may be what gates an entry of that
  // name somewhere this rename cannot see.
  moveConfirm(gatedLeaves, scope);

  // Set a new alias on the renamed key
  if (newAlias) {
    setAlias(newAlias, newKey, scope);
  }

  printSuccess(`Entry '${oldKey}' renamed to '${newKey}'.`);
  return { from: oldKey, to: newKey, kind: 'entry', ...(newAlias ? { alias: newAlias } : {}) };
}
