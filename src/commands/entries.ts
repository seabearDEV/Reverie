import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadData, handleError, getValue, setValue, removeValue, Scope } from '../storage';
import { flattenObject, setNestedValue } from '../utils/objectPath';
import { findProjectFile, loadEntries, saveEntriesAndTouchMeta, loadMeta, loadMetaMerged, getStalenessTag } from '../store';
import { CodexValue } from '../types';
import { displayTree } from '../formatting';
import { color } from '../formatting';
import { execSync, spawnSync } from 'child_process';
import { ensureDataDirectoryExists } from '../utils/paths';
import { buildKeyToAliasMap, setAlias, removeAliasesForKey, loadAliases, saveAliases, resolveKey, renameAlias } from '../alias';
import { hasConfirm, setConfirm, removeConfirm, removeConfirmForKey } from '../confirm';
import { resolveScopeForWrite } from '../projectResolution';
import { debug } from '../utils/debug';
import { GetOptions } from '../types';
import { printSuccess, printWarning, printError, displayEntries, displayKeys, displayAliases, askConfirmation, askPassword } from './helpers';
import { copyToClipboard } from '../utils/clipboard';
import { isEncrypted, encryptValue, decryptValue } from '../utils/crypto';
import { interpolate, interpolateObject } from '../utils/interpolate';
import { getBinaryName } from '../utils/binaryName';
import { isJsonMode, setResult, failJson } from '../utils/output';

function toScope(global?: boolean  ): Scope | undefined {
  return global ? 'global' : undefined;
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
    const resolvedKeys: string[] = [];

    for (const keyGroup of keys) {
      // Split on : for composition (e.g. "cd:reverie" → "cd /path")
      const segments = keyGroup.replace(/:$/, '').split(':');
      const resolvedSegments: string[] = [];

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

        try {
          value = interpolate(value);
        } catch (err) {
          printError(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return;
        }

        resolvedSegments.push(value);
      }

      commands.push(resolvedSegments.join(' '));
    }

    const value = commands.join(' && ');

    // JSON mode (#117 WS1): produce a structured result instead of streaming
    // the child's stdio. --source (the shell-eval wrapper path) is exempt — it
    // is an internal integration, not an agent surface.
    if (isJsonMode() && !options.source) {
      const needsConfirmJson = resolvedKeys.some(k => hasConfirm(k));
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
      const proc = spawnSync(value, { encoding: 'utf-8', shell: process.env.SHELL ?? '/bin/sh' });
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
    const needsConfirm = resolvedKeys.some(k => hasConfirm(k));
    if (needsConfirm && !options.yes && process.stdin.isTTY) {
      const answer = await askConfirmation('Run this? [y/N] ', options.source ? process.stderr : undefined);
      if (answer.toLowerCase() !== 'y') {
        if (options.source) {
          process.stderr.write('Aborted.\n');
        } else {
          console.log('Aborted.');
        }
        return;
      }
    }

    if (options.source) {
      process.stdout.write(value + '\n');
    } else if (options.capture) {
      try {
        const stdout = execSync(value, { encoding: 'utf-8', shell: process.env.SHELL ?? '/bin/sh' });
        process.stdout.write(stdout);
      } catch (err: unknown) {
        process.exitCode = (err && typeof err === 'object' && 'status' in err ? Number(err.status) : 1) || 1;
        if (err && typeof err === 'object' && 'stderr' in err && (err as { stderr?: string }).stderr) {
          process.stderr.write(String((err as { stderr?: string }).stderr));
        }
      }
    } else {
      try {
        execSync(value, { stdio: 'inherit', shell: process.env.SHELL ?? '/bin/sh' });
      } catch (err: unknown) {
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

async function handlePostSetConfirm(key: string, confirm: boolean | undefined, scope?: Scope  ): Promise<void> {
  if (confirm === true) {
    setConfirm(key, scope);
  } else if (confirm === false) {
    removeConfirm(key, scope);
  } else if (process.stdin.isTTY) {
    const answer = await askConfirmation('Require confirmation to run? [y/N] ');
    if (answer.toLowerCase() === 'y') {
      setConfirm(key, scope);
    }
  }
}

export async function setEntry(key: string, value: string | undefined, force = false, encrypt = false, alias?: string, confirm?: boolean, global?: boolean, passwordFile?: string): Promise<{ key: string; alias?: string } | undefined> {
  debug('setEntry called', { key, force, encrypt, alias, confirm, global });
  const scope = toScope(global);
  try {
    ensureDataDirectoryExists();

    // Confirm-only or alias-only update: no value provided
    if (value === undefined) {
      // Handle --confirm / --no-confirm on an existing entry (no value needed)
      if (confirm !== undefined) {
        const existing = getValue(key, scope);
        if (existing === undefined) {
          printError(`Entry '${key}' not found. Cannot update confirm on a non-existent entry.`, 'NOT_FOUND');
          process.exitCode = 1;
          return;
        }
        if (confirm) {
          setConfirm(key, scope);
          printSuccess(`Entry '${key}' now requires confirmation to run.`);
        } else {
          removeConfirm(key, scope);
          printSuccess(`Entry '${key}' no longer requires confirmation to run.`);
        }
        if (alias) {
          setAlias(alias, key, scope);
        }
        return;
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
      return;
    }

    const existing = getValue(key, scope);
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

    setValue(key, storedValue, scope);
    console.log(`Entry '${key}' set successfully.`);

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

  const entries = options.source
    ? flat as Record<string, CodexValue>
    : interpolateObject(flat);

  if (options.plain) {
    for (const [k, v] of Object.entries(entries)) {
      const strVal = typeof v === 'string' ? v : JSON.stringify(v);
      console.log(`${k}: ${isEncrypted(strVal) ? '[encrypted]' : strVal}`);
    }
    return;
  }

  displayEntries(entries as Record<string, string>, aliasMap);
}

function jsonFlatEntries(data: Record<string, string> | Record<string, CodexValue>): Record<string, string> {
  const flat = flattenObject(data);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (isEncrypted(v)) {
      result[k] = '[encrypted]';
    } else {
      try { result[k] = interpolate(v); } catch { result[k] = v; }
    }
  }
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
        setResult({ project: jsonFlatEntries(loadData('project')), global: jsonFlatEntries(loadData('global')) });
      } else if (options.aliases) {
        setResult({ aliases: loadAliases(listingScope) });
      } else {
        setResult(jsonFlatEntries(loadData(listingScope)));
      }
      return;
    }

    const val = getValue(key, lookupScope);
    if (val === undefined) {
      failJson('NOT_FOUND', `Entry '${key}' not found`);
      return;
    }
    if (typeof val === 'object' && val !== null) {
      setResult(jsonFlatEntries(flattenObject({ [key]: val })));
    } else {
      const strVal = String(val);
      let displayVal: string;
      if (isEncrypted(strVal)) {
        displayVal = '[encrypted]';
      } else {
        try { displayVal = interpolate(strVal); } catch { displayVal = strVal; }
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
    let decryptedDisplay = decrypted;
    try {
      decryptedDisplay = interpolate(decrypted);
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
      displayValue = interpolate(strValue);
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

  removeValue(key, scope);

  // Cascade delete: remove any aliases pointing to this key or its children
  removeAliasesForKey(key, scope);

  // Cascade delete: remove confirm metadata for this key or its children
  removeConfirmForKey(key, scope);

  printSuccess(`Entry '${key}' removed successfully.`);
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

    const existing = getValue(destKey, scope);
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
      const data = loadEntries(effectiveScope);
      for (const [flatKey, flatVal] of Object.entries(flattenObject({ [sourceKey]: value }))) {
        setNestedValue(data, destKey + flatKey.slice(sourceKey.length), String(flatVal));
      }
      saveEntriesAndTouchMeta(data, destKey, effectiveScope);
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
  const value = getValue(oldKey, scope);
  if (value === undefined) {
    printError(`Entry '${oldKey}' not found.`, 'NOT_FOUND');
    process.exitCode = 1;
    return;
  }

  const existing = getValue(newKey, scope);
  if (existing !== undefined) {
    printError(`Entry '${newKey}' already exists. Remove it first or choose a different key.`, 'INVALID_INPUT');
    process.exitCode = 1;
    return;
  }

  // Move the value
  if (typeof value === 'string') {
    setValue(newKey, value, scope);
  } else {
    // Batch: load once, set all leaves, save once (instead of O(L) file writes).
    // Apply the project-resolution guard here too — this path bypasses
    // storage.ts setValue, so the guard would otherwise be skipped (#99).
    const effectiveScope = resolveScopeForWrite(scope);
    const data = loadEntries(effectiveScope);
    for (const [flatKey, flatVal] of Object.entries(flattenObject({ [oldKey]: value }))) {
      setNestedValue(data, newKey + flatKey.slice(oldKey.length), String(flatVal));
    }
    saveEntriesAndTouchMeta(data, newKey, effectiveScope);
  }
  removeValue(oldKey, scope);

  // Update aliases: re-point any alias targeting oldKey (or children) to newKey
  // Batch: mutate in-place and save once (instead of O(A*4) file I/O)
  const aliases = loadAliases(scope);
  const oldPrefix = oldKey + '.';

  // First pass: collect re-point updates (alias -> newTarget)
  const updates: [string, string][] = [];
  for (const [alias, target] of Object.entries(aliases)) {
    if (target === oldKey) {
      updates.push([alias, newKey]);
    } else if (target.startsWith(oldPrefix)) {
      updates.push([alias, newKey + target.slice(oldKey.length)]);
    }
  }

  if (updates.length > 0) {
    // Enforce one-alias-per-entry: remove any existing alias already pointing
    // to one of the new targets before re-pointing (same rule as setAlias)
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
    saveAliases(aliases, scope);
  }

  // Move confirm metadata
  if (hasConfirm(oldKey)) {
    removeConfirm(oldKey, scope);
    setConfirm(newKey, scope);
  }

  // Set a new alias on the renamed key
  if (newAlias) {
    setAlias(newAlias, newKey, scope);
  }

  printSuccess(`Entry '${oldKey}' renamed to '${newKey}'.`);
  return { from: oldKey, to: newKey, kind: 'entry', ...(newAlias ? { alias: newAlias } : {}) };
}
