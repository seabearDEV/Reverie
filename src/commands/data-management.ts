import { loadData, saveData, getValue, setValue, handleError, Scope, validateImportEntries, validateImportAliases, validateImportConfirm } from '../storage';
import { color } from '../formatting';
import fs from 'fs';
import { loadAliases, saveAliases } from '../alias';
import { loadConfirmKeys, saveConfirmKeys } from '../confirm';
import { CodexData, ExportOptions, ImportOptions, ResetOptions } from '../types';
import path from 'path';
import { validateDataType, validateResetType, confirmOrAbort, getInvalidDataTypeMessage, getInvalidResetTypeMessage, printSuccess, printError, printWarning } from './helpers';
import { deepMerge } from '../utils/deepMerge';
import { flattenObject, expandFlatKeys } from '../utils/objectPath';
import { maskEncryptedValues } from '../utils/crypto';
import { debug } from '../utils/debug';
import { createAutoBackup } from '../utils/autoBackup';
import { findProjectFile, clearProjectFileCache, saveAll } from '../store';
import { wrapExport, tryUnwrapImport } from '../utils/envelope';
import { version as pkgVersion } from '../../package.json';
import { getConfigSetting } from '../config';
import { getBinaryName } from '../utils/binaryName';

function resolveImportMaxBytes(): number {
  const configured = Number(getConfigSetting('import_max_bytes'));
  // Fall back to 50 MB if the config is missing, corrupted, or non-positive.
  // The config loader already clamps negatives to the default, but guard
  // again here so a hand-edited config file can't disable the cap.
  return Number.isFinite(configured) && configured > 0 ? configured : 50 * 1024 * 1024;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
import { getAuditPath } from '../utils/audit';
import { getTelemetryPath, getMissPathsPath } from '../utils/telemetry';
import { scanCodebase, ScaffoldEntry } from './scan';
import { generateClaudeMd, generateAgentsMd } from './claude-md';

function resolveScope(options: { global?: boolean | undefined, project?: boolean | undefined }): Scope | undefined {
  if (options.global) return 'global';
  if (options.project) return 'project';
  return undefined;
}

// Concrete scope for the envelope meta field. 'auto' (undefined) resolves to
// project when a project store exists, else global — mirroring the lookup
// fallthrough that actually produced the exported data.
function resolveExportScope(scope?: Scope): 'project' | 'global' {
  if (scope === 'project') return 'project';
  if (scope === 'global') return 'global';
  return findProjectFile() ? 'project' : 'global';
}

export function exportData(type: string, options: ExportOptions): { type: string; files: string[] } | undefined {
  debug('exportData called', { type, options });
  try {
    if (!validateDataType(type)) {
      printError(getInvalidDataTypeMessage(type), 'INVALID_INPUT');
      return;
    }

    const scope = resolveScope(options);
    const defaultDir = process.cwd();
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const indent = options.pretty ? 2 : 0;
    const envelopeScope = resolveExportScope(scope);
    const includesEncrypted = !!options.includeEncrypted;
    const written: string[] = [];

    // Single-file 'all' export (default in v1.12.2+). Produces one wrapped
    // file that `data import all` can consume directly — restores the
    // advertised export-all → import-all round-trip (#76). Pass --split
    // to get the legacy per-section files.
    if (type === 'all' && !options.split) {
      const outputFile = options.output ?? path.join(defaultDir, `reverie-all-${timestamp}.json`);
      const entries = loadData(scope);
      const entriesPayload = includesEncrypted ? entries : maskEncryptedValues(entries);
      const wrapped = wrapExport({
        type: 'all',
        scope: envelopeScope,
        includesEncrypted,
        payload: {
          entries: entriesPayload,
          aliases: loadAliases(scope),
          confirm: loadConfirmKeys(scope),
        },
        version: pkgVersion,
      });
      fs.writeFileSync(outputFile, JSON.stringify(wrapped, null, indent), { encoding: 'utf8', mode: 0o600 });
      printSuccess(`All data exported to: ${color.cyan(outputFile)}`);
      if (includesEncrypted) {
        printWarning('Export contains decryptable ciphertext. Store the file securely.');
      }
      return { type, files: [outputFile] };
    }

    // Split path: each section gets its own wrapped file. Runs for single-
    // type exports (entries/aliases/confirm) and for `all --split`.
    const getOutputFile = (typeName: string, defaultName: string): string => {
      if (!options.output) return path.join(defaultDir, defaultName);
      if (type !== 'all') return options.output;
      const ext = path.extname(options.output);
      const base = options.output.slice(0, options.output.length - ext.length);
      return `${base}-${typeName}${ext || '.json'}`;
    };

    if (type === 'entries' || type === 'all') {
      const outputFile = getOutputFile('entries', `reverie-entries-${timestamp}.json`);
      const entries = loadData(scope);
      const entriesPayload = includesEncrypted ? entries : maskEncryptedValues(entries);
      const wrapped = wrapExport({
        type: 'entries',
        scope: envelopeScope,
        includesEncrypted,
        payload: { entries: entriesPayload },
        version: pkgVersion,
      });
      fs.writeFileSync(outputFile, JSON.stringify(wrapped, null, indent), { encoding: 'utf8', mode: 0o600 });
      printSuccess(`Entries exported to: ${color.cyan(outputFile)}`);
      if (includesEncrypted) {
        printWarning('Export contains decryptable ciphertext. Store the file securely.');
      }
      written.push(outputFile);
    }

    if (type === 'aliases' || type === 'all') {
      const outputFile = getOutputFile('aliases', `reverie-aliases-${timestamp}.json`);
      const wrapped = wrapExport({
        type: 'aliases',
        scope: envelopeScope,
        includesEncrypted: false,
        payload: { aliases: loadAliases(scope) },
        version: pkgVersion,
      });
      fs.writeFileSync(outputFile, JSON.stringify(wrapped, null, indent), { encoding: 'utf8', mode: 0o600 });
      printSuccess(`Aliases exported to: ${color.cyan(outputFile)}`);
      written.push(outputFile);
    }

    if (type === 'confirm' || type === 'all') {
      const outputFile = getOutputFile('confirm', `reverie-confirm-${timestamp}.json`);
      const wrapped = wrapExport({
        type: 'confirm',
        scope: envelopeScope,
        includesEncrypted: false,
        payload: { confirm: loadConfirmKeys(scope) },
        version: pkgVersion,
      });
      fs.writeFileSync(outputFile, JSON.stringify(wrapped, null, indent), { encoding: 'utf8', mode: 0o600 });
      printSuccess(`Confirm keys exported to: ${color.cyan(outputFile)}`);
      written.push(outputFile);
    }
    return { type, files: written };
  } catch (error) {
    handleError('Error exporting data:', error);
    return undefined;
  }
}

export async function importData(type: string, file: string, options: ImportOptions): Promise<void> {
  debug('importData called', { type, file, options });
  const scope = resolveScope(options);
  try {
    // Validate type parameter
    if (!validateDataType(type)) {
      printError(getInvalidDataTypeMessage(type), 'INVALID_INPUT');
      return;
    }

    // Check if file exists
    if (!fs.existsSync(file)) {
      printError(`Import file not found: ${file}`, 'NOT_FOUND');
      return;
    }

    // Reject oversized files before reading into memory (#80). Prevents a
    // misplaced heap dump or adversarial payload from OOM'ing the Node
    // process with a cryptic V8 error instead of a clear user message.
    const maxBytes = resolveImportMaxBytes();
    const fileSize = fs.statSync(file).size;
    if (fileSize > maxBytes) {
      printError(
        `Import file too large: ${formatBytes(fileSize)} exceeds the ${formatBytes(maxBytes)} limit. ` +
        `Set the 'import_max_bytes' config if you really need to import a file this size:\n  ${getBinaryName()} config set import_max_bytes ${fileSize}`,
        'INVALID_INPUT'
      );
      return;
    }

    // Parse and validate JSON
    let importedData: unknown;
    try {
      importedData = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      printError('The import file contains invalid JSON.', 'INVALID_INPUT');
      return;
    }

    if (typeof importedData !== 'object' || importedData === null || Array.isArray(importedData)) {
      printError('The import file must contain a JSON object.', 'INVALID_INPUT');
      return;
    }

    const validData = importedData as Record<string, unknown>;

    // Try to unwrap the integrity envelope. Throws on shape errors or
    // sha256 mismatch; returns envelope=null for bare-shape files (back-
    // compat path for pre-v1.12.2 exports and hand-written JSON).
    let envelope;
    let envelopePayload: Record<string, unknown>;
    let envelopeWarnings: string[];
    try {
      const unwrap = tryUnwrapImport(validData, pkgVersion);
      envelope = unwrap.envelope;
      envelopePayload = unwrap.payload;
      envelopeWarnings = unwrap.warnings;
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      return;
    }

    // Type compatibility: envelope.type must match user's requested type,
    // or one side must be 'all' (compatible as a subset extraction).
    if (envelope && envelope.type !== type && envelope.type !== 'all' && type !== 'all') {
      printError(`Import type mismatch: file was exported as '${envelope.type}', but import requested '${type}'.`, 'INVALID_INPUT');
      return;
    }

    envelopeWarnings.forEach(w => printWarning(w));

    // Confirm before overwriting unless --force or --preview is used.
    // Surface includesEncrypted so the user knows decryptable ciphertext
    // is about to land in the store.
    if (!options.force && !options.preview) {
      console.log(color.yellow(`⚠ This will ${options.merge ? 'merge' : 'replace'} your ${type} file.`));
      if (envelope?.includesEncrypted) {
        console.log(color.yellow('⚠ Import contains decryptable ciphertext (includesEncrypted: true).'));
      }
      const confirmed = await confirmOrAbort('Continue? [y/N] ');
      if (!confirmed) return;
    }

    const isAll = type === 'all';

    // Pick the raw per-section values out of the source, preserving the
    // undefined-vs-present distinction. A present-but-malformed section
    // (e.g. `aliases: "not-an-object"`) used to be silently coerced to
    // undefined here and then dropped from the import — letting a torn
    // backup half-apply with no error. Shape-validate explicitly below
    // so #77's transactional guarantee holds for shape errors too (#89).
    const rawEntries: unknown = envelope
      ? envelopePayload.entries
      : (type === 'entries' ? importedData : validData.entries);
    const rawAliases: unknown = envelope
      ? envelopePayload.aliases
      : (type === 'aliases' ? importedData : validData.aliases);
    const rawConfirm: unknown = envelope
      ? envelopePayload.confirm
      : (type === 'confirm' ? importedData : validData.confirm);

    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v);
    const shapeTypeName = (v: unknown): string =>
      v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

    const wantsEntries = type === 'entries' || isAll;
    const wantsAliases = type === 'aliases' || isAll;
    const wantsConfirm = type === 'confirm' || isAll;

    if (wantsEntries && rawEntries !== undefined && !isPlainObject(rawEntries)) {
      printError(`Import section 'entries' must be an object (got ${shapeTypeName(rawEntries)}).`, 'INVALID_INPUT');
      return;
    }
    if (wantsAliases && rawAliases !== undefined && !isPlainObject(rawAliases)) {
      printError(`Import section 'aliases' must be an object (got ${shapeTypeName(rawAliases)}).`, 'INVALID_INPUT');
      return;
    }
    if (wantsConfirm && rawConfirm !== undefined && !isPlainObject(rawConfirm)) {
      printError(`Import section 'confirm' must be an object (got ${shapeTypeName(rawConfirm)}).`, 'INVALID_INPUT');
      return;
    }

    const entriesSection: Record<string, unknown> | undefined =
      wantsEntries && isPlainObject(rawEntries) ? rawEntries : undefined;
    const aliasesSection: Record<string, unknown> | undefined =
      wantsAliases && isPlainObject(rawAliases) ? rawAliases : undefined;
    const confirmSection: Record<string, unknown> | undefined =
      wantsConfirm && isPlainObject(rawConfirm) ? rawConfirm : undefined;

    if (isAll && !entriesSection && !aliasesSection && !confirmSection) {
      printError('Import with type "all" requires {"entries": {...}, "aliases": {...}, "confirm": {...}} (at least one section).', 'INVALID_INPUT');
      return;
    }

    // Preview mode: show diff without modifying data
    if (options.preview) {
      // Validate raw input the same way the apply path does. Pre-fix the
      // preview silently dropped bad keys via flattenObject's prototype-
      // getter trap, so the user saw a clean preview for an import the
      // apply would reject.
      try {
        if (entriesSection) validateImportEntries(entriesSection);
        if (aliasesSection) {
          const hasNonStringValues = Object.values(aliasesSection).some(v => typeof v !== 'string');
          if (!hasNonStringValues) validateImportAliases(aliasesSection);
        }
        if (confirmSection) validateImportConfirm(confirmSection);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        return;
      }
      showImportPreview({ entries: entriesSection, aliases: aliasesSection, confirm: confirmSection }, !!options.merge);
      return;
    }

    // Auto-backup before destructive import (replace, not merge). If the
    // backup throws, abort — a destructive import with no rollback point
    // is exactly the failure mode #74 was filed to prevent.
    if (!options.merge) {
      try {
        createAutoBackup('pre-import', scope);
      } catch (err) {
        printError(`Aborting: auto-backup failed (${err instanceof Error ? err.message : String(err)}). No changes were made.`, 'IO');
        return;
      }
    }

    // Validate every section up front BEFORE any save. This fixes #77
    // failure mode #2: a validation error in aliases or confirm used to
    // fire AFTER entries had already been written, leaving the store
    // partially applied. Validators also run before expandFlatKeys because
    // flattenObject's __proto__ getter trap silently normalizes some bad
    // keys and erases the evidence that the input was invalid.
    try {
      if (entriesSection) validateImportEntries(entriesSection);
      if (aliasesSection) {
        if (Object.values(aliasesSection).some(v => typeof v !== 'string')) {
          printError('Alias values must all be strings (dot-notation paths).', 'INVALID_INPUT');
          return;
        }
        validateImportAliases(aliasesSection);
      }
      if (confirmSection) validateImportConfirm(confirmSection);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      return;
    }

    // Compute the final per-section payloads, then commit them together in
    // a single saveAll call. Closes the cross-section tear window: even
    // with process death or disk error mid-apply, the store never ends up
    // with new entries and stale aliases / confirm (or vice versa).
    const nextEntries: CodexData | undefined = entriesSection
      ? (options.merge
          ? deepMerge(loadData(scope), expandFlatKeys(entriesSection)) as CodexData
          : expandFlatKeys(entriesSection) as CodexData)
      : undefined;
    const nextAliases: Record<string, string> | undefined = aliasesSection
      ? (options.merge
          ? { ...loadAliases(scope), ...(aliasesSection as Record<string, string>) }
          : aliasesSection as Record<string, string>)
      : undefined;
    const nextConfirm: Record<string, true> | undefined = confirmSection
      ? (options.merge
          ? { ...loadConfirmKeys(scope), ...(confirmSection as Record<string, true>) }
          : confirmSection as Record<string, true>)
      : undefined;

    saveAll(
      {
        ...(nextEntries !== undefined && { entries: nextEntries }),
        ...(nextAliases !== undefined && { aliases: nextAliases }),
        ...(nextConfirm !== undefined && { confirm: nextConfirm }),
      },
      scope,
    );

    if (entriesSection) printSuccess(`Entries ${options.merge ? 'merged' : 'imported'} successfully`);
    if (aliasesSection) printSuccess(`Aliases ${options.merge ? 'merged' : 'imported'} successfully`);
    if (confirmSection) printSuccess(`Confirm keys ${options.merge ? 'merged' : 'imported'} successfully`);
  } catch (error) {
    handleError('Error importing data:', error);
  }
}

export async function resetData(type: string, options: ResetOptions): Promise<void> {
  debug('resetData called', { type, options });
  const scope = resolveScope(options);
  try {
    // Validate type parameter
    if (!validateResetType(type)) {
      printError(getInvalidResetTypeMessage(type), 'INVALID_INPUT');
      return;
    }

    // Confirm before resetting unless --force is used
    if (!options.force) {
      console.log(color.yellow(`⚠ This will reset your ${type} to an empty state.`));
      const confirmed = await confirmOrAbort('Continue? [y/N] ');
      if (!confirmed) return;
    }

    // Log-file resets (audit, telemetry, miss-paths) — global only, no backup needed
    if (type === 'audit' || type === 'telemetry' || type === 'miss-paths') {
      const file = type === 'audit' ? getAuditPath() : type === 'telemetry' ? getTelemetryPath() : getMissPathsPath();
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
      const label = type === 'audit' ? 'Audit log' : type === 'telemetry' ? 'Telemetry' : 'Miss-path log';
      printSuccess(`${label} has been cleared`);
      return;
    }

    // Auto-backup before reset. Abort if the backup can't be written —
    // see #74.
    try {
      createAutoBackup('pre-reset', scope);
    } catch (err) {
      printError(`Aborting: auto-backup failed (${err instanceof Error ? err.message : String(err)}). No changes were made.`);
      return;
    }

    // Reset entries
    if (type === 'entries' || type === 'all') {
      saveData({}, scope);
      printSuccess('Entries have been reset to an empty state');
    }

    // Reset aliases
    if (type === 'aliases' || type === 'all') {
      saveAliases({}, scope);
      printSuccess('Aliases have been reset to an empty state');
    }

    // Reset confirm keys
    if (type === 'confirm' || type === 'all') {
      saveConfirmKeys({}, scope);
      printSuccess('Confirm keys have been reset to an empty state');
    }
  } catch (error) {
    handleError('Error resetting data:', error);
  }
}

function computeDiff(current: Record<string, string>, incoming: Record<string, string>, merge: boolean): string[] {
  const lines: string[] = [];

  if (merge) {
    const allKeys = new Set([...Object.keys(current), ...Object.keys(incoming)]);
    for (const key of [...allKeys].sort()) {
      const inCurrent = key in current;
      const inImport = key in incoming;
      if (inImport && !inCurrent) {
        lines.push(color.green(`  [add]    ${key}: ${incoming[key]}`));
      } else if (inImport && inCurrent && current[key] !== incoming[key]) {
        lines.push(color.yellow(`  [modify] ${key}: ${current[key]} → ${incoming[key]}`));
      }
      // unchanged keys are omitted for brevity
    }
  } else {
    // Replace mode: everything current is removed, everything incoming is added
    for (const key of Object.keys(current).sort()) {
      if (!(key in incoming) || current[key] !== incoming[key]) {
        lines.push(color.red(`  [remove] ${key}: ${current[key]}`));
      }
    }
    for (const key of Object.keys(incoming).sort()) {
      if (!(key in current) || current[key] !== incoming[key]) {
        lines.push(color.green(`  [add]    ${key}: ${incoming[key]}`));
      }
    }
  }

  return lines;
}

function showImportPreview(sections: {
  entries?: Record<string, unknown> | undefined;
  aliases?: Record<string, unknown> | undefined;
  confirm?: Record<string, unknown> | undefined;
}, merge: boolean): void {
  const { entries: entriesSection, aliases: aliasesSection, confirm: confirmSection } = sections;
  let hasChanges = false;

  if (entriesSection) {
    const currentFlat = flattenObject(loadData());
    const importFlat = flattenObject(expandFlatKeys(entriesSection));
    const lines = computeDiff(currentFlat, importFlat, merge);
    console.log(color.bold(`Entries (${merge ? 'merge' : 'replace'}):`));
    if (lines.length > 0) {
      lines.forEach(l => console.log(l));
      hasChanges = true;
    } else {
      console.log(color.gray('  No changes'));
    }
  }

  if (aliasesSection) {
    const currentAliases = loadAliases();
    const currentFlat: Record<string, string> = {};
    const importFlat: Record<string, string> = {};
    for (const [k, v] of Object.entries(currentAliases)) currentFlat[k] = v;
    for (const [k, v] of Object.entries(aliasesSection)) importFlat[k] = String(v);
    const lines = computeDiff(currentFlat, importFlat, merge);
    console.log(color.bold(`Aliases (${merge ? 'merge' : 'replace'}):`));
    if (lines.length > 0) {
      lines.forEach(l => console.log(l));
      hasChanges = true;
    } else {
      console.log(color.gray('  No changes'));
    }
  }

  if (confirmSection) {
    const currentConfirm = loadConfirmKeys();
    const currentFlat: Record<string, string> = {};
    const importFlat: Record<string, string> = {};
    for (const k of Object.keys(currentConfirm)) currentFlat[k] = 'true';
    for (const k of Object.keys(confirmSection)) importFlat[k] = 'true';
    const lines = computeDiff(currentFlat, importFlat, merge);
    console.log(color.bold(`Confirm keys (${merge ? 'merge' : 'replace'}):`));
    if (lines.length > 0) {
      lines.forEach(l => console.log(l));
      hasChanges = true;
    } else {
      console.log(color.gray('  No changes'));
    }
  }

  if (!hasChanges) {
    console.log(color.gray('No changes would be made.'));
  }

  console.log(color.gray('\nThis is a preview. No data was modified.'));
}

const PERSISTENCE_VALUE = '.reverie/ = project knowledge store (any agent, file-per-entry layout). CLAUDE.md = Claude behavioral directives. MEMORY.md = personal user preferences. Rule: if another agent would benefit, it belongs in .reverie/.';

export function handleProjectFile(options: {
  remove?: boolean;
  scaffold?: boolean;
  scan?: boolean;
  claude?: boolean;
  agents?: boolean;
  force?: boolean;
  dryRun?: boolean;
}): void {
  if (options.remove) {
    const projectPath = findProjectFile();
    if (!projectPath) {
      printError('No .reverie project store found in current directory tree.', 'NOT_FOUND');
      return;
    }
    // findProjectFile may return either a `.reverie/` directory (v1.0.0-beta.1+)
    // or a legacy `.codexcli.json` single-file (pre-v1.10). rmSync handles both
    // uniformly with `recursive: true`.
    fs.rmSync(projectPath, { recursive: true, force: true });
    clearProjectFileCache();
    printSuccess(`Removed: ${projectPath}`);
    return;
  }

  const cwd = process.cwd();
  const target = path.join(cwd, '.reverie');

  // Single stat call to determine the target's state.
  let targetStat: ReturnType<typeof fs.statSync> | null = null;
  try {
    targetStat = fs.statSync(target);
  } catch { /* ENOENT — target doesn't exist yet */ }

  // Check for the edge case where target exists but is not a directory
  // (e.g. a leftover legacy file). mkdirSync would throw EEXIST in that case.
  if (targetStat !== null && !targetStat.isDirectory()) {
    const kind = targetStat.isFile() ? 'file' : targetStat.isSymbolicLink() ? 'symlink' : 'non-directory';
    printError(
      `Cannot initialize: '${target}' already exists as a ${kind}. ` +
      `Remove it manually before running '${getBinaryName()} init'.`,
      'INVALID_INPUT'
    );
    return;
  }

  const existed = targetStat !== null;

  // Create .reverie/ directory with empty sidecars if it doesn't exist
  if (!existed) {
    if (!options.dryRun) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      // Seed empty sidecars so the store has a consistent initial state
      fs.writeFileSync(path.join(target, '_aliases.json'), '{}\n', { mode: 0o600 });
      fs.writeFileSync(path.join(target, '_confirm.json'), '{}\n', { mode: 0o600 });
      clearProjectFileCache();
    }
    printSuccess(`Created: ${target}`);
  }

  // Scan codebase and populate entries (unless --no-scan)
  const shouldScan = options.scan !== false;
  if (shouldScan) {
    if (options.dryRun) {
      const discovered = scanCodebase(cwd);
      if (discovered.length > 0) {
        console.log(color.bold('Would scaffold:'));
        for (const { key, value } of discovered) {
          console.log(`  ${key}: ${value}`);
        }
      } else {
        printWarning('No project information detected.');
      }
    } else {
      scaffoldProject();
    }
  }

  // Seed conventions.persistence (unless --no-scan or it already exists)
  if (shouldScan && !options.dryRun) {
    const existing = getValue('conventions.persistence', 'project');
    if (existing === undefined) {
      setValue('conventions.persistence', PERSISTENCE_VALUE, 'project');
      console.log(`  ${color.green('+')} conventions.persistence: ${color.white(PERSISTENCE_VALUE)}`);
    }

    // Seed context.initialized marker for agents to detect fresh scaffold
    const initMarker = getValue('context.initialized', 'project');
    if (initMarker === undefined) {
      const markerValue = 'scaffold — arch.* and context.* namespaces need deep analysis by an AI agent';
      setValue('context.initialized', markerValue, 'project');
      console.log(`  ${color.green('+')} context.initialized: ${color.white(markerValue)}`);
    }
  }

  // Generate CLAUDE.md (unless --no-claude)
  if (options.claude !== false) {
    if (options.dryRun) {
      const content = generateClaudeMd({ cwd, dryRun: true });
      if (content) {
        console.log(color.bold('\nWould create CLAUDE.md:'));
        console.log(content);
      }
    } else {
      generateClaudeMd({ cwd, force: options.force });
    }
  }

  // Generate agent-agnostic AGENTS.md (unless --no-agents). Describes the
  // CLI-driven workflow for agents that cannot run an MCP server (#117 WS2).
  if (options.agents !== false) {
    if (options.dryRun) {
      const content = generateAgentsMd({ cwd, dryRun: true });
      if (content) {
        console.log(color.bold('\nWould create AGENTS.md:'));
        console.log(content);
      }
    } else {
      generateAgentsMd({ cwd, force: options.force });
    }
  }
}

function mergeScaffoldEntries(discovered: ScaffoldEntry[]): number {
  if (discovered.length === 0) {
    printWarning('No project information detected.');
    return 0;
  }

  // Deduplicate by key (first wins — e.g., package.json name over go.mod module)
  const seen = new Set<string>();
  const unique = discovered.filter(e => {
    if (seen.has(e.key)) return false;
    seen.add(e.key);
    return true;
  });

  // Merge into existing project data (skip keys that already exist)
  let count = 0;
  for (const { key, value } of unique) {
    const existing = getValue(key, 'project');
    if (existing !== undefined) continue;
    setValue(key, value, 'project');
    console.log(`  ${color.green('+')} ${key}: ${color.white(value)}`);
    count++;
  }

  if (count === 0) {
    console.log(color.gray('  All discovered entries already exist. Nothing to add.'));
  } else {
    printSuccess(`Scaffolded ${count} entries.`);
  }

  return count;
}

function scaffoldProject(): void {
  const discovered = scanCodebase(process.cwd());
  mergeScaffoldEntries(discovered);
}
