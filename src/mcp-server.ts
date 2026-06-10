#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/require-await */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

import { loadData, saveData, getValue, setValue, removeValue, getEntriesFlat, Scope, validateImportEntries, validateImportAliases, validateImportConfirm } from "./storage";
import { isValidEntryKey } from "./utils/directoryStore";
import { CodexData } from "./types";
import {
  flattenObject,
  expandFlatKeys,
  setNestedValue,
} from "./utils/objectPath";
import {
  loadAliases,
  saveAliases,
  setAlias,
  removeAlias,
  resolveKey,
  buildKeyToAliasMap,
  removeAliasesForKey,
  renameAlias,
} from "./alias";
import {
  ensureDataDirectoryExists,
  setProjectRootOverride,
} from "./utils/paths";
import { fileURLToPath } from "url";
import { findProjectFile, loadEntries, saveEntriesAndTouchMeta, saveAll } from "./store";
import { hasConfirm, setConfirm, removeConfirm, loadConfirmKeys, saveConfirmKeys, removeConfirmForKey } from "./confirm";
import { loadConfig, getConfigSetting, setConfigSetting, VALID_CONFIG_KEYS, DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES } from "./config";
import { deepMerge } from "./utils/deepMerge";
import { version as pkgVersion } from "../package.json";
import { wrapExport, tryUnwrapImport } from "./utils/envelope";
import { formatTree, resetColorCache } from "./formatting";
import { isEncrypted, maskEncryptedValues, encryptValue, decryptValue } from "./utils/crypto";
import { interpolate, interpolateExec, interpolateObject, StrictInterpolationError } from "./utils/interpolate";
import { logToolCall, computeStats, classifyOp, getTelemetryPath, getMissPathsPath, TelemetryExtras, MissWindowTracker, appendMissPath, getSessionId, extractNamespace } from "./utils/telemetry";
import { logAudit, queryAuditLog, sanitizeParams, getAuditPath } from "./utils/audit";
import { resolveScopeForWrite, ProjectResolutionError } from "./projectResolution";
import { getEffectiveInstructions } from "./llm-instructions";
import { parsePeriodDays } from "./utils";
import { getBinaryName } from "./utils/binaryName";
import { HANDOFF_KEY, buildHandoffBanner } from "./utils/handoff";
import { recordWrite, formatWriteAmpWarning } from "./utils/writeAmp";
import { AsyncLocalStorage } from "node:async_hooks";

function toScope(scopeParam?: string): Scope {
  return (scopeParam ?? 'auto') as Scope;
}

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function errorResponse(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Render a ProjectResolutionError (#99) as a two-block MCP tool result: the
 * human-readable refusal message in the first content item and a JSON code
 * block carrying `code` + `diagnostic` for programmatic consumers in the
 * second. Both ride the same `isError: true` envelope so the client can
 * surface the failure like any other tool error.
 */
function projectResolutionErrorResponse(err: ProjectResolutionError) {
  const structured = JSON.stringify({ code: err.code, diagnostic: err.diagnostic }, null, 2);
  return {
    content: [
      { type: "text" as const, text: err.message },
      { type: "text" as const, text: '```json\n' + structured + '\n```' },
    ],
    isError: true,
  };
}

ensureDataDirectoryExists();

// --- Confirmation token store for two-step reverie_run ---
// Tokens are one-time-use and expire after 5 minutes.
import crypto from 'crypto';
const CONFIRM_TOKEN_TTL = 5 * 60 * 1000;
const pendingConfirmations = new Map<string, { key: string; command: string; expires: number }>();

// --- Miss-path tracker for observed exploration cost ---
const missTracker = new MissWindowTracker();

function createConfirmToken(key: string, command: string): string {
  // Sweep expired tokens — abandoned previews (token issued, never passed
  // back) would otherwise accumulate for the life of the server. The map
  // stays tiny, so a full sweep per create is fine.
  const now = Date.now();
  for (const [t, entry] of pendingConfirmations) {
    if (now > entry.expires) pendingConfirmations.delete(t);
  }
  const token = crypto.randomBytes(8).toString('hex');
  pendingConfirmations.set(token, { key, command, expires: now + CONFIRM_TOKEN_TTL });
  return token;
}

function consumeConfirmToken(token: string, key: string): string | null {
  const entry = pendingConfirmations.get(token);
  if (!entry) return null;
  pendingConfirmations.delete(token);
  if (Date.now() > entry.expires) return null;
  if (entry.key !== key) return null;
  return entry.command;
}

const llmInstructions = getEffectiveInstructions();

const server = new McpServer(
  { name: "reverie", version: pkgVersion },
  { ...(llmInstructions && { instructions: llmInstructions }) },
);

// Wrap server.tool to auto-log telemetry and audit for every tool call
const _origTool = server.tool.bind(server);
import { SKIP_AUDIT, BULK_OPS, captureValue, captureCopySource, captureBulkCount, deriveAfterValue, isRedundantWrite } from "./utils/instrumentation";

// ── Per-call guardrail signals ──────────────────────────────────────
// Handlers stash guardrail outcomes here (size-budget shedding for #100,
// write-amp warning for #101). AsyncLocalStorage makes each tool-call
// invocation see its own store so concurrent in-flight requests cannot
// bleed signals into each other's telemetry/audit rows.
interface GuardrailSignals {
  degraded?: boolean;
  shedNamespaces?: string[];
  writeAmpWarning?: boolean;
  writeAmpCount?: number;
}
const guardrailStorage = new AsyncLocalStorage<GuardrailSignals>();
function emitGuardrailSignals(signals: GuardrailSignals): void {
  const store = guardrailStorage.getStore();
  if (store) Object.assign(store, signals);
}

function extractKey(name: string, params: Record<string, unknown>): string | undefined {
  if (name === 'reverie_copy') return (params.dest ?? params.source) as string | undefined;
  if (name === 'reverie_alias_set') return params.alias as string | undefined;
  return (params.key ?? params.source ?? params.oldKey ?? params.alias ?? params.query) as string | undefined;
}

// --- Token-efficiency metric helpers ---

/** Extract the text content from an MCP tool result */
function extractResponseText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: { text?: string }[] }).content;
  if (!Array.isArray(content)) return '';
  return content.map(c => c.text ?? '').join('');
}

/** Known empty-result patterns that indicate a read "miss" */
const MISS_PATTERNS = [
  'not found',
  'no entries found',
  'no entries stored',
  'no results found',
  'no aliases defined',
  'no audit entries',
];

/** Determine if a read operation was a hit (returned useful data) */
function determineHit(result: unknown, success: boolean): boolean {
  if (!success) return false;
  const text = extractResponseText(result).toLowerCase();
  return !MISS_PATTERNS.some(p => text.includes(p));
}

/** Try to extract entry count from response text */
function extractEntryCount(text: string): number | undefined {
  // reverie_context footer: "(N entries)"
  const tierMatch = /\((\d+) entries?\)/.exec(text);
  if (tierMatch) return parseInt(tierMatch[1], 10);
  // Count non-empty content lines (rough approximation for listings)
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('[tier:') && !l.startsWith('Aliases:'));
  return lines.length > 0 ? lines.length : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
server.tool = ((...args: any[]) => {
  const name = args[0] as string;
  const origHandler = args[args.length - 1] as (params: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  args[args.length - 1] = async (params: Record<string, unknown>, extra: unknown) => {
    const startTime = Date.now();
    const key = extractKey(name, params);

    const scope = toScope(params.scope as string | undefined);
    const resolvedScope: 'project' | 'global' | undefined =
      scope === 'auto'
        ? (findProjectFile() ? 'project' : 'global')
        : scope;

    // Resolve alias for audit trail. reverie_copy is special-cased: extractKey
    // returns dest for the audit-key field, but the alias that matters is the
    // source alias (dest is usually a new canonical key, not an alias). #94.
    let aliasResolved: string | undefined;
    if (name === 'reverie_copy') {
      const source = params.source as string | undefined;
      if (source) {
        try {
          const resolved = resolveKey(source, scope);
          if (resolved !== source) aliasResolved = resolved;
        } catch { /* ignore — alias resolution is best-effort */ }
      }
    } else if (key) {
      try {
        const resolved = resolveKey(key, scope);
        if (resolved !== key) aliasResolved = resolved;
      } catch { /* ignore — alias resolution is best-effort */ }
    }

    const shouldAudit = !SKIP_AUDIT.has(name);
    if (!shouldAudit) return origHandler(params, extra);

    const op = classifyOp(name);
    const isWrite = op === 'write' || op === 'exec' || op === 'remove';

    // #99: detect the "rescued by explicit scope:'global'" path. If the
    // caller passed scope:'global' AND project resolution would have
    // failed, the call would have refused under scope:'auto'. We capture
    // this so telemetry can measure how often the escape hatch is used.
    const explicitGlobal = (params.scope as string | undefined) === 'global';
    const rescuedByExplicitGlobal = isWrite && explicitGlobal && !findProjectFile() ? true : undefined;

    // Capture before-value for writes
    let before: string | undefined;
    let copySourceValue: string | undefined;
    if (isWrite && !BULK_OPS.has(name)) {
      before = captureValue(name, key, scope);
      if (name === 'reverie_copy') {
        copySourceValue = captureCopySource(params.source as string | undefined, scope);
      }
    } else if (isWrite && BULK_OPS.has(name)) {
      before = captureBulkCount(scope);
    }

    // Execute handler
    let result: unknown;
    let success = true;
    let errorMsg: string | undefined;
    let refusedReason: string | undefined;
    const guardrailSignals: GuardrailSignals = {};
    try {
      result = await guardrailStorage.run(guardrailSignals, () => origHandler(params, extra));
      if (result && typeof result === 'object' && 'isError' in result && (result as { isError: boolean }).isError) {
        success = false;
        const content = (result as { content?: { text?: string }[] }).content;
        errorMsg = content?.[0]?.text;
      }
    } catch (err) {
      success = false;
      errorMsg = String(err);
      // #99: convert project-resolution refusals into the structured
      // two-block response right here, so every write tool surfaces the
      // diagnostic uniformly without each handler having to special-case
      // the error type. Telemetry/audit downstream pick up refusedReason
      // from this branch.
      if (err instanceof ProjectResolutionError) {
        result = projectResolutionErrorResponse(err);
        refusedReason = 'project_unresolved';
      } else {
        throw err;
      }
    } finally {
      const duration = Date.now() - startTime;

      // Capture after-value for writes: shared with the CLI wrapper via
      // deriveAfterValue (derives from params/before rather than re-reading).
      let after: string | undefined;
      if (isWrite && success && !BULK_OPS.has(name)) {
        after = deriveAfterValue(name, {
          writeValue: params.value as string | undefined,
          before,
          copySourceValue,
          aliasPath: params.path as string | undefined,
          key,
          scope,
        });
      } else if (isWrite && BULK_OPS.has(name) && success) {
        after = captureBulkCount(scope);
      }

      // Token-efficiency metrics
      const responseText = extractResponseText(result);
      const responseSize = Buffer.byteLength(responseText, 'utf8');
      const requestSize = Buffer.byteLength(JSON.stringify(params), 'utf8');
      const hit = op === 'read' ? determineHit(result, success) : undefined;
      const tier = name === 'reverie_context' ? (params.tier as string ?? 'standard') : undefined;
      const entryCount = op === 'read' && success ? extractEntryCount(responseText) : undefined;
      const redundant = isRedundantWrite(name, op, params, before, after);

      // Consume any guardrail signals stashed by the handler (#100/#101).
      const guardrails = guardrailSignals;

      // Telemetry (enriched, moved here so we have duration + metrics)
      const projectFile = findProjectFile();
      const telemetryExtras: TelemetryExtras = {
        duration,
        hit,
        redundant,
        responseSize,
        success,
        project: projectFile ? path.dirname(projectFile) : undefined,
        refusedReason,
        rescuedByExplicitGlobal,
        ...guardrails,
      };
      void logToolCall(name, key, 'mcp', resolvedScope, telemetryExtras);

      void logAudit({
        src: 'mcp',
        tool: name,
        op,
        key,
        scope: (params.scope as string) ?? 'auto',
        success,
        before: isWrite ? before : undefined,
        after: isWrite ? after : undefined,
        error: errorMsg,
        params: sanitizeParams(params),
        duration,
        aliasResolved,
        responseSize,
        requestSize,
        hit,
        tier,
        entryCount,
        redundant,
        refusedReason,
        rescuedByExplicitGlobal,
        ...guardrails,
      });

      // Miss-path tracking: feed every call to the tracker
      const closedPaths = missTracker.onToolCall({
        session: getSessionId(),
        tool: name,
        namespace: extractNamespace(key),
        key: key ?? '',
        op,
        hit,
        responseSize,
        agent: process.env.RVR_AGENT_NAME,
      });
      for (const mp of closedPaths) {
        void appendMissPath(mp);
      }
    }

    return result;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  return (_origTool as (...a: any[]) => unknown)(...args);
}) as typeof server.tool;

// --- reverie_set ---
server.tool(
  "reverie_set",
  "Store a project-knowledge entry at a dot-notation key (e.g. arch.api) — persists insights across sessions. For a nickname pointing at an existing key, use reverie_alias_set (aliases store no data).",
  { key: z.string().describe("Dot-notation key (e.g. server.prod.ip)"), value: z.string().describe("Value to store"), alias: z.string().optional().describe("Create an alias for this key"), encrypt: z.boolean().optional().describe("Encrypt the value with the provided password"), password: z.string().optional().describe("Password for encryption (required when encrypt is true)"), scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)") },
  async ({ key, value, alias, encrypt, password, scope: scopeParam }) => {
    try {
      const scope = toScope(scopeParam);
      ensureDataDirectoryExists();
      const resolved = resolveKey(key, scope);
      // Pre-validate the alias name BEFORE any writes. Without this,
      // setValue would persist the entry, then setAlias would throw on a
      // bad alias name, leaving the store in a partial state (entry stored,
      // alias rejected, user gets an error and doesn't realize the entry
      // was already saved).
      if (alias !== undefined && !isValidEntryKey(alias)) {
        return errorResponse(`Invalid alias name: ${JSON.stringify(alias)}`);
      }
      let storedValue = value;
      if (encrypt) {
        if (!password) {
          return errorResponse("Password is required when encrypt is true.");
        }
        storedValue = encryptValue(value, password);
      }
      setValue(resolved, storedValue, scope);
      if (alias) {
        setAlias(alias, resolved, scope);
      }
      // Surface where the write actually landed.
      const projectFile = findProjectFile();
      const wroteTo: 'project' | 'global' =
        scope === 'project' ? 'project' :
        scope === 'global' ? 'global' :
        projectFile ? 'project' : 'global';
      // #125: quiet confirmation — never echo the value back. The agent
      // just sent it; re-paying it in the response costs ~12× the CLI's
      // confirmation on a 1KB seed. Key + byte count + landing scope only.
      const byteCount = Buffer.byteLength(value, 'utf8');
      const lines: string[] = [
        `Set: ${resolved} (${byteCount}B${encrypt ? ', encrypted' : ''}) → ${wroteTo}${wroteTo === 'project' && projectFile ? ` (${projectFile})` : ''}`,
      ];
      if (alias) lines.push(`Alias set: ${alias} -> ${resolved}`);

      // Write-amp guard (#101) — warn when the same key has been written
      // 3+ times in this session within a 30-min window. Informational
      // only; the write itself succeeded.
      const ampResult = recordWrite(getSessionId(), resolved);
      if (ampResult) {
        lines.push(`warning: ${formatWriteAmpWarning(ampResult)}`);
        emitGuardrailSignals({ writeAmpWarning: true, writeAmpCount: ampResult.count });
      }

      return textResponse(lines.join('\n'));
    } catch (err) {
      if (err instanceof ProjectResolutionError) throw err;
      return errorResponse(`Error setting entry: ${String(err)}`);
    }
  }
);

// --- reverie_get ---
server.tool(
  "reverie_get",
  "Retrieve a stored entry by dot-notation key (e.g. arch.api). For browsing everything, use reverie_context; for keyword search, use reverie_find.",
  {
    key: z.string().optional().describe("Dot-notation key to retrieve (omit for all entries)"),
    format: z.enum(["flat", "tree"]).optional().describe("Output format: flat (default) or tree"),
    aliases_only: z.boolean().optional().describe("Show aliases only"),
    values: z.boolean().optional().describe("Include values in output (default: false; leaf values always include their value)"),
    depth: z.coerce.number().optional().describe("Limit key depth (e.g. 1 for top-level only, 2 for two levels)"),
    decrypt: z.boolean().optional().describe("Decrypt an encrypted value"),
    password: z.string().optional().describe("Password for decryption (required when decrypt is true)"),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
    all: z.boolean().optional().describe("Show entries from all scopes (project + global) when listing"),
  },
  async ({ key, format, aliases_only, values, depth, decrypt: decryptOpt, password, scope: scopeParam, all: showAll }) => {
    try {
      const hasProject = !!findProjectFile();
      // For listings: default to project-only when project exists (unless --all or explicit scope)
      const listingScope: Scope = scopeParam ?? ((hasProject && !showAll) ? 'project' : 'auto');
      // For single-key lookups: auto fallthrough
      const lookupScope = toScope(scopeParam);
      const data = loadData(listingScope);
      const keyToAliasMap = buildKeyToAliasMap();

      // No key — return entries and/or aliases
      if (!key) {
        // Aliases only
        if (aliases_only) {
          const aliases = loadAliases(listingScope);
          const entries = Object.entries(aliases);
          if (entries.length === 0) {
            return textResponse("No aliases defined.");
          }
          const lines = entries.map(([a, t]) => `${a} -> ${t}`);
          return textResponse(lines.join("\n"));
        }

        // Show all scopes with section headers
        if (showAll && hasProject) {
          const sections: string[] = [];
          for (const s of ['project', 'global'] as const) {
            const sData = loadData(s);
            const label = s === 'project' ? 'Project' : 'Global';
            sections.push(`${label}:`);
            if (Object.keys(sData).length > 0) {
              const flat = flattenObject(sData, '', depth);
              const showValues = values ?? false;
              if (showValues) {
                const lines = Object.entries(flat).map(([k, v]) => `  ${k}: ${isEncrypted(v) ? '[encrypted]' : v}`);
                sections.push(lines.join("\n"));
              } else {
                sections.push(Object.keys(flat).map(k => `  ${k}`).join("\n"));
              }
            } else {
              sections.push("  No entries found.");
            }
          }
          return textResponse(sections.join("\n"));
        }

        const sections: string[] = [];

        // Entries
        if (Object.keys(data).length > 0) {
          const showValues = values ?? false;
          if (format === "tree") {
            sections.push(formatTree(data, keyToAliasMap, '', '', false, false, undefined, false, !showValues, depth));
          } else {
            const flat = flattenObject(data, '', depth);
            if (showValues) {
              const lines = Object.entries(flat).map(([k, v]) => `${k}: ${isEncrypted(v) ? '[encrypted]' : v}`);
              sections.push(lines.join("\n"));
            } else {
              sections.push(Object.keys(flat).join("\n"));
            }
          }
        } else {
          sections.push("No entries found.");
        }

        return textResponse(sections.join("\n"));
      }

      // Resolve potential alias
      const resolvedKey = resolveKey(key, lookupScope);
      const value = getValue(resolvedKey, lookupScope);

      if (value === undefined) {
        return errorResponse(`Key '${key}' not found.`);
      }

      // Leaf value
      if (typeof value !== "object" || value === null) {
        const strVal = String(value);
        let display: string | number | boolean;
        if (isEncrypted(strVal)) {
          if (decryptOpt) {
            if (!password) {
              return errorResponse("Password is required when decrypt is true.");
            }
            try {
              const decrypted = decryptValue(strVal, password);
              display = decrypted;
            } catch {
              return errorResponse("Decryption failed. Wrong password or corrupted data.");
            }
          } else {
            display = '[encrypted]';
          }
        } else if (typeof value === 'string') {
          try {
            display = interpolate(strVal);
          } catch (err) {
            // StrictInterpolationError = user opted in to fail-loud (`:?`,
            // circular). Surface those instead of silently rendering the
            // raw template.
            if (err instanceof StrictInterpolationError) throw err;
            display = value;
          }
        } else {
          display = value;
        }
        const { loadMeta, loadMetaMerged, getStalenessTag } = await import("./store");
        const getMeta = lookupScope === 'auto' ? loadMetaMerged() : loadMeta(lookupScope);
        const staleTag = getStalenessTag(resolvedKey, getMeta);
        return textResponse(`${resolvedKey}: ${display}${staleTag}`);
      }

      // Object subtree
      const showSubtreeValues = values ?? false;
      if (format === "tree") {
        return textResponse(formatTree(value, keyToAliasMap, '', resolvedKey, false, false, undefined, false, !showSubtreeValues, depth));
      }
      const flat = flattenObject(value, resolvedKey, depth);
      if (showSubtreeValues) {
        const interpFlat = interpolateObject(flat);
        const lines = Object.entries(interpFlat).map(([k, v]) => {
          const strVal = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}: ${isEncrypted(strVal) ? '[encrypted]' : strVal}`;
        });
        return textResponse(lines.join("\n"));
      }
      return textResponse(Object.keys(flat).join("\n"));
    } catch (err) {
      return errorResponse(`Error retrieving entry: ${String(err)}`);
    }
  }
);

// --- reverie_remove ---
server.tool(
  "reverie_remove",
  "Remove an entry by key; aliases pointing at it (or its children) cascade-remove. To remove only a nickname, use reverie_alias_remove or pass is_alias:true.",
  {
    key: z.string().describe("Dot-notation key to remove"),
    is_alias: z.boolean().optional().describe("If true, remove the alias only (keep the entry)"),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
  },
  async ({ key, is_alias, scope: scopeParam }) => {
    try {
      const scope = toScope(scopeParam);
      if (is_alias) {
        const aliases = loadAliases(scope);
        if (!(key in aliases)) {
          return errorResponse(`Alias '${key}' not found.`);
        }
        delete aliases[key];
        saveAliases(aliases, scope);
        return textResponse(`Alias removed: ${key}`);
      }

      const resolvedKey = resolveKey(key, scope);
      const removed = removeValue(resolvedKey, scope);
      if (!removed) {
        return errorResponse(`Key '${key}' not found.`);
      }
      // Cascade delete: remove any aliases and confirm metadata for this key or its children
      removeAliasesForKey(resolvedKey, scope);
      removeConfirmForKey(resolvedKey, scope);
      return textResponse(`Removed: ${resolvedKey}`);
    } catch (err) {
      if (err instanceof ProjectResolutionError) throw err;
      return errorResponse(`Error removing entry: ${String(err)}`);
    }
  }
);

// --- reverie_copy ---
server.tool(
  "reverie_copy",
  "Duplicate an entry's value to a new key. For a nickname without duplication, use reverie_alias_set; for moving, use reverie_rename.",
  {
    source: z.string().describe("Source dot-notation key to copy from"),
    dest: z.string().describe("Destination dot-notation key to copy to"),
    force: z.boolean().optional().describe("Overwrite destination if it already exists"),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
  },
  async ({ source, dest, force, scope: scopeParam }) => {
    try {
      const scope = toScope(scopeParam);
      ensureDataDirectoryExists();
      const resolvedSource = resolveKey(source, scope);
      const value = getValue(resolvedSource, scope);

      if (value === undefined) {
        return errorResponse(`Key '${source}' not found.`);
      }

      const existing = getValue(dest, scope);
      if (existing !== undefined && !force) {
        return errorResponse(`Key '${dest}' already exists. Pass force: true to overwrite.`);
      }

      if (typeof value === "string") {
        setValue(dest, value, scope);
      } else {
        // Batch: load once, set all leaves, save once.
        // Apply the project-resolution guard before the bulk write — this
        // path bypasses storage.ts setValue, so #99's refusal would
        // otherwise be missed.
        const writeScope = resolveScopeForWrite(scope);
        const data = loadEntries(writeScope);
        for (const [flatKey, flatVal] of Object.entries(flattenObject({ [resolvedSource]: value }))) {
          setNestedValue(data, dest + flatKey.slice(resolvedSource.length), String(flatVal));
        }
        saveEntriesAndTouchMeta(data, dest, writeScope);
      }

      return textResponse(`Copied: ${resolvedSource} -> ${dest}`);
    } catch (err) {
      if (err instanceof ProjectResolutionError) throw err;
      return errorResponse(`Error copying entry: ${String(err)}`);
    }
  }
);

// --- reverie_rename ---
server.tool(
  "reverie_rename",
  "Move an entry key to a new name (alias when is_alias:true), preserving value and metadata. reverie_copy duplicates instead.",
  {
    oldKey: z.string().describe("Current dot-notation key (or alias name when is_alias is true)"),
    newKey: z.string().describe("New dot-notation key (or alias name when is_alias is true)"),
    is_alias: z.boolean().optional().describe("If true, rename the alias itself (not the entry key)"),
    alias: z.string().optional().describe("Create a new alias for the renamed entry"),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
  },
  async ({ oldKey, newKey, is_alias, alias, scope: scopeParam }) => {
    try {
      const scope = toScope(scopeParam);

      // Alias rename mode
      if (is_alias) {
        const result = renameAlias(oldKey, newKey, scope);
        if (!result) {
          const aliases = loadAliases(scope);
          if (!(oldKey in aliases)) {
            return errorResponse(`Alias '${oldKey}' not found.`);
          }
          return errorResponse(`Alias '${newKey}' already exists.`);
        }
        return textResponse(`Alias '${oldKey}' renamed to '${newKey}'.`);
      }

      // Entry key rename
      const resolvedOld = resolveKey(oldKey, scope);
      const value = getValue(resolvedOld, scope);
      if (value === undefined) {
        return errorResponse(`Key '${oldKey}' not found.`);
      }

      const existing = getValue(newKey, scope);
      if (existing !== undefined) {
        return errorResponse(`Key '${newKey}' already exists. Remove it first or choose a different key.`);
      }

      // Move the value
      if (typeof value === 'string') {
        setValue(newKey, value, scope);
      } else {
        // Batch: load once, set all leaves, save once. Pre-resolve the
        // scope so the project-resolution guard fires here too (#99).
        const writeScope = resolveScopeForWrite(scope);
        const data = loadEntries(writeScope);
        for (const [flatKey, flatVal] of Object.entries(flattenObject({ [resolvedOld]: value }))) {
          setNestedValue(data, newKey + flatKey.slice(resolvedOld.length), String(flatVal));
        }
        saveEntriesAndTouchMeta(data, newKey, writeScope);
      }
      removeValue(resolvedOld, scope);

      // Update aliases: re-point any alias targeting oldKey (or children) to newKey
      const aliases = loadAliases(scope);
      const oldPrefix = resolvedOld + '.';
      const updates: [string, string][] = [];
      for (const [a, target] of Object.entries(aliases)) {
        if (target === resolvedOld) {
          updates.push([a, newKey]);
        } else if (target.startsWith(oldPrefix)) {
          updates.push([a, newKey + target.slice(resolvedOld.length)]);
        }
      }

      if (updates.length > 0) {
        // Enforce one-alias-per-entry: remove any existing alias already pointing to a new target
        const newTargets = new Set(updates.map(([, t]) => t));
        for (const [a, target] of Object.entries(aliases)) {
          if (newTargets.has(target)) {
            delete aliases[a];
          }
        }
        for (const [a, newTarget] of updates) {
          aliases[a] = newTarget;
        }
        saveAliases(aliases, scope);
      }

      // Move confirm metadata
      if (hasConfirm(resolvedOld)) {
        removeConfirm(resolvedOld, scope);
        setConfirm(newKey, scope);
      }

      // Set a new alias on the renamed key
      if (alias) {
        setAlias(alias, newKey, scope);
      }

      return textResponse(`Renamed: ${resolvedOld} -> ${newKey}`);
    } catch (err) {
      if (err instanceof ProjectResolutionError) throw err;
      return errorResponse(`Error renaming entry: ${String(err)}`);
    }
  }
);

// --- reverie_find ---
server.tool(
  "reverie_find",
  "Search entries by keyword or regex across keys and values — when you know roughly what, not the exact key. Exact key: reverie_get; list all: reverie_context.",
  {
    query: z.string().describe("Query string to find (case-insensitive substring, or regex if regex=true)"),
    regex: z.boolean().optional().describe("Treat query as a regular expression"),
    keysOnly: z.boolean().optional().describe("Match against keys only and return keys without values"),
    valuesOnly: z.boolean().optional().describe("Match against values only (skip keys)"),
    aliasesOnly: z.boolean().optional().describe("Search only in aliases"),
    entriesOnly: z.boolean().optional().describe("Search only in data entries"),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
  },
  async ({ query, regex, keysOnly, valuesOnly, aliasesOnly, entriesOnly, scope: scopeParam }) => {
    try {
      if (keysOnly && valuesOnly) {
        return errorResponse("'keysOnly' and 'valuesOnly' are mutually exclusive.");
      }
      const scope = toScope(scopeParam);
      let match: (text: string) => boolean;
      try {
        if (regex) {
          if (query.length > 500) {
            return errorResponse("Regex pattern too long (max 500 characters).");
          }
          const re = new RegExp(query, 'i');
          match = (text: string) => re.test(text);
        } else {
          const lc = query.toLowerCase();
          match = (text: string) => text.toLowerCase().includes(lc);
        }
      } catch (err) {
        return errorResponse(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      const results: string[] = [];

      if (!aliasesOnly) {
        const flat = getEntriesFlat(scope);
        for (const [k, v] of Object.entries(flat)) {
          const encrypted = isEncrypted(v);
          const keyMatch = !valuesOnly && match(k);
          const valueMatch = !keysOnly && !encrypted && match(String(v));

          if (keyMatch || valueMatch) {
            // keysOnly is a projection too (#127): the caller asked to match
            // on keys, so don't make them pay for the values in the response.
            results.push(keysOnly ? k : `${k}: ${encrypted ? '[encrypted]' : v}`);
          }
        }
      }

      if (!entriesOnly) {
        const aliases = loadAliases(scope);
        for (const [alias, target] of Object.entries(aliases)) {
          if (match(alias) || match(target)) {
            results.push(`[alias] ${alias} -> ${target}`);
          }
        }
      }

      if (results.length === 0) {
        return textResponse(`No results found for '${query}'.`);
      }
      return textResponse(results.join("\n"));
    } catch (err) {
      return errorResponse(`Error searching: ${String(err)}`);
    }
  }
);

// --- reverie_alias_set ---
server.tool(
  "reverie_alias_set",
  "Create a short nickname resolving to an existing entry key (e.g. 'api' -> 'arch.api'). Stores NO data — for new content, use reverie_set.",
  {
    alias: z.string().describe("Alias name"),
    key: z.string().describe("Dot-notation key the alias points to"),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
  },
  async ({ alias, key, scope: scopeParam }) => {
    try {
      const scope = toScope(scopeParam);
      setAlias(alias, key, scope);
      return textResponse(`Alias set: ${alias} -> ${key}`);
    } catch (err) {
      if (err instanceof ProjectResolutionError) throw err;
      return errorResponse(`Error setting alias: ${String(err)}`);
    }
  }
);

// --- reverie_alias_remove ---
server.tool(
  "reverie_alias_remove",
  "Remove a nickname without touching its target entry. Entries themselves: reverie_remove.",
  { alias: z.string().describe("Alias name to remove"), scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)") },
  async ({ alias, scope: scopeParam }) => {
    try {
      const scope = toScope(scopeParam);
      const removed = removeAlias(alias, scope);
      if (!removed) {
        return errorResponse(`Alias '${alias}' not found.`);
      }
      return textResponse(`Alias removed: ${alias}`);
    } catch (err) {
      if (err instanceof ProjectResolutionError) throw err;
      return errorResponse(`Error removing alias: ${String(err)}`);
    }
  }
);

// --- reverie_alias_list ---
server.tool(
  "reverie_alias_list",
  "List all nicknames (alias -> key mappings).",
  { scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)") },
  async ({ scope: scopeParam }) => {
    try {
      const scope = toScope(scopeParam);
      const aliases = loadAliases(scope);
      const entries = Object.entries(aliases);
      if (entries.length === 0) {
        return textResponse("No aliases defined.");
      }
      const lines = entries.map(([a, t]) => `${a} -> ${t}`);
      return textResponse(lines.join("\n"));
    } catch (err) {
      return errorResponse(`Error listing aliases: ${String(err)}`);
    }
  }
);

// Shared dry → confirm → exec gate for both reverie_run paths (single and
// chain). ONE gate sequence on purpose: the v1.2.1 exec-on-read RCE class was
// "two parallel run paths, one fixed" — keeping a single gate means a future
// confirm/interpolation fix cannot miss a branch.
function runGated(
  key: string,
  rawValues: string[],
  needsConfirm: boolean,
  opts: { dry?: boolean | undefined; force?: boolean | undefined; confirm_token?: string | undefined },
) {
  // Safe (non-exec) display command for dry output and the confirm prompt.
  // SECURITY: building the preview must not execute `$(key)` exec refs, so
  // the safe pass (display) and exec pass (interpolateExec) run separately.
  let command: string;
  try {
    command = rawValues.map((cv) => interpolate(cv)).join(' && ');
  } catch (err) {
    return errorResponse(`Interpolation error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (opts.dry) return textResponse(`$ ${command}`);

  if (needsConfirm && !opts.force) {
    if (opts.confirm_token) {
      const validated = consumeConfirmToken(opts.confirm_token, key);
      if (!validated) {
        return errorResponse(`Invalid or expired confirm_token for '${key}'.`);
      }
      // Token valid — fall through to execution
    } else {
      const token = createConfirmToken(key, command);
      return textResponse(
        `⚠ This command requires confirmation before execution:\n$ ${command}\n\nTo execute, call reverie_run again with confirm_token: "${token}"`
      );
    }
  }

  // Past the gates — resolve exec refs for real.
  let execCommand: string;
  try {
    execCommand = rawValues.map((cv) => interpolateExec(cv)).join(' && ');
  } catch (err) {
    return errorResponse(`Interpolation error: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const stdout = execSync(execCommand, {
      encoding: "utf-8",
      shell: process.env.SHELL ?? "/bin/sh",
      timeout: 30000,
    });
    return textResponse(`$ ${command}\n${stdout}`);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      const execErr = err as { status: number; stderr?: string };
      return errorResponse(
        `$ ${command}\nCommand failed (exit ${execErr.status}): ${execErr.stderr ?? ""}`
      );
    }
    return errorResponse(`Error running command: ${String(err)}`);
  }
}

// --- reverie_run ---
server.tool(
  "reverie_run",
  "Execute a stored shell command by key (e.g. commands.build). Supports ${key}/$(key) interpolation, chain:true for &&-chaining, dry:true to preview. Confirm-gated entries are two-step: first call returns a confirm_token + preview; pass the token back to execute.",
  {
    key: z.string().describe("Dot-notation key (or alias) whose value is a shell command"),
    dry: z.boolean().optional().describe("If true, return the command without executing it"),
    force: z.boolean().optional().describe("If true, skip the confirm check for entries marked --confirm"),
    confirm_token: z.string().optional().describe("One-time token from a previous confirmation prompt — pass this to execute a confirmed command"),
    chain: z.boolean().optional().describe("If true, treat stored value as space-separated key references to resolve and &&-chain"),
    capture: z.boolean().optional().describe("Capture output (MCP always captures; included for API consistency)"),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
  },
  async ({ key, dry, force, confirm_token, chain, scope: scopeParam }) => {
    const scope = toScope(scopeParam);
    const resolvedKey = resolveKey(key, scope);
    const value = getValue(resolvedKey, scope);

    if (value === undefined) {
      return errorResponse(`Key '${key}' not found.`);
    }
    if (typeof value !== "string") {
      return errorResponse(`Value at '${key}' is not a string command.`);
    }

    // --chain: split value into key references, resolve each, and &&-chain
    if (chain) {
      const trimmedValue = value.trim();
      if (!trimmedValue) {
        return errorResponse(`Value at '${key}' is empty and cannot be used with chain mode.`);
      }
      const chainKeys = trimmedValue.split(/\s+/).filter(Boolean);
      // First pass: validate every chain key and collect raw values. No
      // interpolation yet — SECURITY: building the preview must not execute
      // `$(key)` exec refs, so we keep the raw values and run the safe pass
      // (display) and exec pass (interpolateExec) separately below.
      const rawValues: string[] = [];
      let anyNeedsConfirm = false;
      for (const ck of chainKeys) {
        const rk = resolveKey(ck, scope);
        const cv = getValue(rk, scope);
        if (cv === undefined) return errorResponse(`Chain key '${ck}' not found.`);
        if (typeof cv !== 'string') return errorResponse(`Chain key '${ck}' is not a string command.`);
        if (isEncrypted(cv)) return errorResponse(`Chain key '${ck}' is encrypted.`);
        if (hasConfirm(rk)) anyNeedsConfirm = true;
        rawValues.push(cv);
      }

      // Confirm if ANY key on the chain is confirm-flagged.
      return runGated(key, rawValues, anyNeedsConfirm, { dry, force, confirm_token });
    }

    if (isEncrypted(value)) {
      return errorResponse(`Value at '${key}' is encrypted. Decryption is not supported via MCP.`);
    }

    return runGated(key, [value], hasConfirm(resolvedKey), { dry, force, confirm_token });
  }
);

// --- reverie_config_get ---
server.tool(
  "reverie_config_get",
  "Get a Reverie user-preference setting (colors, theme). Project knowledge lives in reverie_get.",
  {
    key: z.string().optional().describe("Config key (colors, theme). Omit for all settings."),
  },
  async ({ key }) => {
    try {
      if (!key) {
        const config = loadConfig();
        const lines = Object.entries(config).map(([k, v]) => `${k}: ${v}`);
        return textResponse(lines.join("\n"));
      }

      const value = getConfigSetting(key);
      if (value === null) {
        return errorResponse(`Unknown config key: '${key}'`);
      }
      return textResponse(`${key}: ${value}`);
    } catch (err) {
      return errorResponse(`Error getting config: ${String(err)}`);
    }
  }
);

// --- reverie_config_set ---
server.tool(
  "reverie_config_set",
  "Set a Reverie user-preference setting. Project knowledge writes go through reverie_set.",
  {
    key: z.string().describe("Config key to set (colors, theme)"),
    value: z.string().describe("Value to set"),
  },
  async ({ key, value }) => {
    try {
      if (!(VALID_CONFIG_KEYS as readonly string[]).includes(key)) {
        return errorResponse(
          `Unknown config key: '${key}'. Valid keys: ${VALID_CONFIG_KEYS.join(", ")}`
        );
      }

      setConfigSetting(key, value);
      resetColorCache();
      return textResponse(`Config set: ${key} = ${value}`);
    } catch (err) {
      return errorResponse(`Error setting config: ${String(err)}`);
    }
  }
);

// --- reverie_export ---
server.tool(
  "reverie_export",
  "Export entries/aliases/confirm as a JSON envelope (version + sha256) for backup, sharing, or version control.",
  {
    type: z.enum(["entries", "aliases", "confirm", "all"]).describe("What to export"),
    pretty: z.boolean().optional().describe("Pretty-print the JSON (default false)"),
    includeEncrypted: z.boolean().optional().describe("Emit real ciphertext for encrypted values instead of the [encrypted] placeholder — output contains sensitive material."),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
  },
  async ({ type, pretty, includeEncrypted, scope: scopeParam }) => {
    try {
      const scope = toScope(scopeParam);
      const indent = pretty ? 2 : 0;
      const envelopeScope: 'project' | 'global' =
        scope === 'project' ? 'project' :
        scope === 'global' ? 'global' :
        (findProjectFile() ? 'project' : 'global');
      const maskEntries = (d: Record<string, unknown>) => includeEncrypted ? d : maskEncryptedValues(d);

      const payload: Record<string, unknown> = {};
      if (type === 'entries' || type === 'all') payload.entries = maskEntries(loadData(scope));
      if (type === 'aliases' || type === 'all') payload.aliases = loadAliases(scope);
      if (type === 'confirm' || type === 'all') payload.confirm = loadConfirmKeys(scope);

      const wrapped = wrapExport({
        type,
        scope: envelopeScope,
        includesEncrypted: !!includeEncrypted && (type === 'entries' || type === 'all'),
        payload,
        version: pkgVersion,
      });
      return textResponse(JSON.stringify(wrapped, null, indent));
    } catch (err) {
      return errorResponse(`Error exporting: ${String(err)}`);
    }
  }
);

// --- reverie_import ---
server.tool(
  "reverie_import",
  "Import entries/aliases/confirm from JSON (reverie_export envelope or bare {entries:{...}}). Merges by default (merge:false replaces); preview:true shows the diff without writing.",
  {
    data: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("Data to import — either a JSON string or an object literal"),
    type: z.enum(["entries", "aliases", "confirm", "all"]).optional().describe("What to import (default: entries)"),
    merge: z.boolean().optional().describe("Merge with existing data instead of replacing (default true — pass false to wipe and replace)"),
    preview: z.boolean().optional().describe("Preview changes without modifying data (returns diff text)"),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
  },
  async ({ data, type: typeParam, merge: mergeParam, preview, scope: scopeParam }) => {
    try {
      const type = typeParam ?? "entries";
      const merge = mergeParam ?? true;
      let parsed: unknown;
      if (typeof data === "string") {
        // Size cap (#80) for string payloads — keep OOM out of the MCP
        // server process. Objects passed in-process skip this because
        // the caller already materialized them.
        const configured = Number(getConfigSetting('import_max_bytes'));
        const maxBytes = Number.isFinite(configured) && configured > 0 ? configured : 50 * 1024 * 1024;
        const byteLength = Buffer.byteLength(data, 'utf8');
        if (byteLength > maxBytes) {
          return errorResponse(
            `Import payload too large: ${byteLength} bytes exceeds the ${maxBytes}-byte limit. ` +
            `Raise 'import_max_bytes' via ${getBinaryName()} config set if this is expected.`
          );
        }
        try {
          parsed = JSON.parse(data);
        } catch {
          return errorResponse("Invalid JSON string.");
        }
      } else {
        parsed = data;
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return errorResponse("JSON must be an object.");
      }

      const obj = parsed as Record<string, unknown>;
      const scope = toScope(scopeParam);

      // Try to unwrap the integrity envelope. Throws on shape errors or
      // sha256 mismatch; envelope=null for bare-shape back-compat.
      let envelope;
      let envelopePayload: Record<string, unknown>;
      let envelopeWarnings: string[];
      try {
        const unwrap = tryUnwrapImport(obj, pkgVersion);
        envelope = unwrap.envelope;
        envelopePayload = unwrap.payload;
        envelopeWarnings = unwrap.warnings;
      } catch (err) {
        return errorResponse(`Envelope check failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (envelope && envelope.type !== type && envelope.type !== 'all' && type !== 'all') {
        return errorResponse(`Import type mismatch: file was exported as '${envelope.type}', but import requested '${type}'.`);
      }

      const isAll = type === 'all';
      const entriesSection: Record<string, unknown> | undefined = envelope
        ? ((type === 'entries' || isAll) && envelopePayload.entries && typeof envelopePayload.entries === 'object' && !Array.isArray(envelopePayload.entries)
            ? envelopePayload.entries as Record<string, unknown> : undefined)
        : (type === 'entries' ? obj :
          isAll && obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries)
            ? obj.entries as Record<string, unknown> : undefined);
      const aliasesSection: Record<string, unknown> | undefined = envelope
        ? ((type === 'aliases' || isAll) && envelopePayload.aliases && typeof envelopePayload.aliases === 'object' && !Array.isArray(envelopePayload.aliases)
            ? envelopePayload.aliases as Record<string, unknown> : undefined)
        : (type === 'aliases' ? obj :
          isAll && obj.aliases && typeof obj.aliases === 'object' && !Array.isArray(obj.aliases)
            ? obj.aliases as Record<string, unknown> : undefined);
      const confirmSection: Record<string, unknown> | undefined = envelope
        ? ((type === 'confirm' || isAll) && envelopePayload.confirm && typeof envelopePayload.confirm === 'object' && !Array.isArray(envelopePayload.confirm)
            ? envelopePayload.confirm as Record<string, unknown> : undefined)
        : (type === 'confirm' ? obj :
          isAll && obj.confirm && typeof obj.confirm === 'object' && !Array.isArray(obj.confirm)
            ? obj.confirm as Record<string, unknown> : undefined);

      // Preview mode: compute diff and return without modifying data
      if (preview) {
        // Validate the raw input the same way the apply path does, so a
        // preview never says "here's what would change" for an import
        // that the apply path would reject. Pre-fix, the preview silently
        // dropped bad keys (e.g. __proto__) from the diff because it ran
        // through flattenObject which trips the __proto__ getter trap.
        try {
          if (entriesSection) validateImportEntries(entriesSection);
          if (aliasesSection) {
            const hasNonStringValues = Object.values(aliasesSection).some(v => typeof v !== 'string');
            if (!hasNonStringValues) validateImportAliases(aliasesSection);
          }
          if (confirmSection) validateImportConfirm(confirmSection);
        } catch (err) {
          return errorResponse(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        const lines: string[] = [];
        envelopeWarnings.forEach(w => lines.push(`⚠ ${w}`));
        if (envelope?.includesEncrypted) {
          lines.push('⚠ Import contains decryptable ciphertext (includesEncrypted: true).');
        }

        const diffEntries = (current: Record<string, string>, incoming: Record<string, string>, doMerge: boolean): string[] => {
          const result: string[] = [];
          if (doMerge) {
            const allKeys = new Set([...Object.keys(current), ...Object.keys(incoming)]);
            for (const key of [...allKeys].sort()) {
              if (key in incoming && !(key in current)) {
                result.push(`  [add]    ${key}: ${incoming[key]}`);
              } else if (key in incoming && key in current && current[key] !== incoming[key]) {
                result.push(`  [modify] ${key}: ${current[key]} → ${incoming[key]}`);
              }
            }
          } else {
            for (const key of Object.keys(current).sort()) {
              if (!(key in incoming) || current[key] !== incoming[key]) {
                result.push(`  [remove] ${key}: ${current[key]}`);
              }
            }
            for (const key of Object.keys(incoming).sort()) {
              if (!(key in current) || current[key] !== incoming[key]) {
                result.push(`  [add]    ${key}: ${incoming[key]}`);
              }
            }
          }
          return result;
        };

        if (entriesSection) {
          const importObj = expandFlatKeys(entriesSection);
          const currentFlat = flattenObject(loadData(scope));
          const importFlat = flattenObject(importObj);
          lines.push(`Entries (${merge ? "merge" : "replace"}):`);
          const diff = diffEntries(currentFlat, importFlat, !!merge);
          lines.push(...(diff.length > 0 ? diff : ["  No changes"]));
        }

        if (aliasesSection) {
          const currentAliases = loadAliases(scope);
          const currentFlat: Record<string, string> = {};
          const importFlat: Record<string, string> = {};
          for (const [k, v] of Object.entries(currentAliases)) currentFlat[k] = v;
          for (const [k, v] of Object.entries(aliasesSection)) importFlat[k] = String(v);
          lines.push(`Aliases (${merge ? "merge" : "replace"}):`);
          const diff = diffEntries(currentFlat, importFlat, !!merge);
          lines.push(...(diff.length > 0 ? diff : ["  No changes"]));
        }

        if (confirmSection) {
          const currentConfirm = loadConfirmKeys(scope);
          const currentFlat: Record<string, string> = {};
          const importFlat: Record<string, string> = {};
          for (const k of Object.keys(currentConfirm)) currentFlat[k] = "true";
          for (const k of Object.keys(confirmSection)) importFlat[k] = "true";
          lines.push(`Confirm keys (${merge ? "merge" : "replace"}):`);
          const diff = diffEntries(currentFlat, importFlat, !!merge);
          lines.push(...(diff.length > 0 ? diff : ["  No changes"]));
        }

        lines.push("\nThis is a preview. No data was modified.");
        return textResponse(lines.join("\n"));
      }

      // Apply path. For 'all' imports we still require at least one non-
      // empty section; match the CLI error text for consistency.
      if (isAll && !entriesSection && !aliasesSection && !confirmSection) {
        return errorResponse(
          'Import with type "all" requires {"entries": {...}, "aliases": {...}, "confirm": {...}} (at least one section).'
        );
      }

      // Validate + shape-check everything BEFORE any save. #77: multi-
      // section imports need to be transactional — one validation failure
      // must not leave a half-applied store.
      if (entriesSection) validateImportEntries(entriesSection);
      if (aliasesSection) {
        if (Object.values(aliasesSection).some(v => typeof v !== "string")) {
          return errorResponse("Alias values must all be strings (dot-notation paths).");
        }
        validateImportAliases(aliasesSection);
      }
      if (confirmSection) validateImportConfirm(confirmSection);

      // Compute each section's final value, then commit all sections in a
      // single saveAll cycle. For replace-all semantics (isAll && !merge)
      // any section the import omitted gets cleared to match the CLI-side
      // "replace everything" contract.
      const nextEntries: CodexData | undefined = entriesSection
        ? ((merge
            ? deepMerge(loadData(scope), expandFlatKeys(entriesSection))
            : expandFlatKeys(entriesSection)) as CodexData)
        : undefined;
      const nextAliases: Record<string, string> | undefined = aliasesSection
        ? (merge
            ? { ...loadAliases(scope), ...(aliasesSection as Record<string, string>) }
            : aliasesSection as Record<string, string>)
        : (isAll && !merge ? {} : undefined);
      const nextConfirm: Record<string, true> | undefined = confirmSection
        ? (merge
            ? { ...loadConfirmKeys(scope), ...(confirmSection as Record<string, true>) }
            : confirmSection as Record<string, true>)
        : (isAll && !merge ? {} : undefined);

      saveAll(
        {
          ...(nextEntries !== undefined && { entries: nextEntries }),
          ...(nextAliases !== undefined && { aliases: nextAliases }),
          ...(nextConfirm !== undefined && { confirm: nextConfirm }),
        },
        scope,
      );

      const warningPrefix = envelopeWarnings.length > 0 ? envelopeWarnings.map(w => `⚠ ${w}\n`).join('') : '';
      const typeLabel = { all: "Entries, aliases, and confirm keys", entries: "Entries", aliases: "Aliases", confirm: "Confirm keys" }[type];
      return textResponse(
        `${warningPrefix}${typeLabel} ${merge ? "merged" : "imported"} successfully.`
      );
    } catch (err) {
      if (err instanceof ProjectResolutionError) throw err;
      return errorResponse(`Error importing: ${String(err)}`);
    }
  }
);

// --- reverie_reset ---
server.tool(
  "reverie_reset",
  "Wipe entries/aliases/confirm (type:'all') or clear audit/telemetry/miss-path logs. Destructive and scope-wide — reverie_export first for a backup. Single entries: reverie_remove.",
  {
    type: z.enum(["entries", "aliases", "confirm", "all", "audit", "telemetry", "miss-paths"]).describe("What to reset ('all' covers entries+aliases+confirm, not logs)"),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global). Ignored for audit/telemetry/miss-paths."),
  },
  async ({ type, scope: scopeParam }) => {
    try {
      // Log-file resets — global only
      if (type === "audit" || type === "telemetry" || type === "miss-paths") {
        const file = type === "audit" ? getAuditPath() : type === "telemetry" ? getTelemetryPath() : getMissPathsPath();
        if (fs.existsSync(file)) fs.unlinkSync(file);
        const label = type === "audit" ? "Audit log" : type === "telemetry" ? "Telemetry" : "Miss-path log";
        return textResponse(`${label} has been cleared.`);
      }

      const scope = toScope(scopeParam);
      if (type === "entries" || type === "all") {
        saveData({}, scope);
      }
      if (type === "aliases" || type === "all") {
        saveAliases({}, scope);
      }
      if (type === "confirm" || type === "all") {
        saveConfirmKeys({}, scope);
      }
      const typeLabel = { all: "Entries, aliases, and confirm keys", entries: "Entries", aliases: "Aliases", confirm: "Confirm keys" }[type];
      return textResponse(
        `${typeLabel} reset to empty state.`
      );
    } catch (err) {
      if (err instanceof ProjectResolutionError) throw err;
      return errorResponse(`Error resetting: ${String(err)}`);
    }
  }
);

// --- reverie_context ---

import { filterEntriesByTier, computeContextSizeReport, formatContextSizeReport } from "./commands/context";
import { shedToFitBudget, formatShedNotice, PATHOLOGICAL_OVERFLOW_NOTICE } from "./utils/contextBudget";

server.tool(
  "reverie_context",
  "Compact summary of all stored project knowledge — call FIRST at session start to bootstrap. Tiers: essential (project/commands/conventions only), standard (default, excludes arch.*), full (everything; bypasses the size budget). Tier-vs-task guidance: docs/schema-guide.md.",
  {
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
    tier: z.enum(["essential", "standard", "full"]).optional().describe("Context tier: essential (project/commands/conventions only — for focused work or when standard overflows), standard (default, excludes arch.* — typical session start), full (everything — for refactoring, architectural changes, or onboarding). See docs/schema-guide.md \"Bootstrap tiers\""),
    sizeOnly: z.boolean().optional().describe("Return per-namespace entry/byte counts and the budget instead of content"),
  },
  async ({ scope: scopeParam, tier, sizeOnly }) => {
    try {
      const projectFile = findProjectFile();
      const hasProject = !!projectFile;
      const effectiveScope: Scope = scopeParam ?? (hasProject ? 'project' : 'auto');

      const flat = getEntriesFlat(effectiveScope);
      const effectiveTier = tier ?? 'standard';

      // Size projection (#127): answer "how big is my bootstrap" without
      // paying for the bootstrap. Estimates handoff/alias/footer overhead
      // without rendering.
      if (sizeOnly) {
        const header = hasProject ? `[project: ${projectFile}]` : '[project: NONE]';
        return textResponse(`${header}\n\n${formatContextSizeReport(computeContextSizeReport(flat, effectiveTier, effectiveScope))}`);
      }

      const filtered = filterEntriesByTier(flat, effectiveTier);
      const aliases = loadAliases(effectiveScope);

      // Load meta for age indicators (needed both for banner and entry tags)
      const { loadMeta, loadMetaMerged, getStalenessTag } = await import("./store");
      const meta = effectiveScope === 'auto' ? loadMetaMerged() : loadMeta(effectiveScope);

      // Handoff banner runs against the unfiltered flat map so it appears
      // regardless of tier. When present, the key is dropped from the entries
      // list below so the banner content isn't duplicated (#91).
      const handoff = buildHandoffBanner(flat, meta);
      if (handoff) {
        delete filtered[HANDOFF_KEY];
      }

      if (!handoff && Object.keys(filtered).length === 0 && Object.keys(aliases).length === 0) {
        const header = hasProject
          ? `[project: ${projectFile}]\n\n`
          : `[project: NONE — auto-scope writes will fall through to global. Pin RVR_PROJECT in the MCP server env, or pass scope:"project"/"global" explicitly on writes.]\n\n`;
        return textResponse(`${header}No entries stored. Use reverie_set to add project knowledge.`);
      }

      // Encrypt-display the entry values once so size accounting matches what
      // we render below.
      const displayed: Record<string, string> = {};
      for (const [k, v] of Object.entries(filtered)) {
        displayed[k] = isEncrypted(v) ? '[encrypted]' : v;
      }

      // Apply the size-budget shed (#100) before we render. tier:"full"
      // bypasses entirely — user has opted in to the full payload.
      let shedSegments: import('./utils/contextBudget').ShedSegment[] = [];
      let pathologicalOverflow = false;
      let kept: Record<string, string> = displayed;
      if (effectiveTier !== 'full') {
        const budget = (loadConfig().bootstrap_max_response_bytes) || DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES;
        const envOverride = process.env.RVR_BOOTSTRAP_MAX_BYTES;
        const effectiveBudget = envOverride && Number.isInteger(Number(envOverride)) && Number(envOverride) > 0
          ? Number(envOverride)
          : budget;

        // Estimate non-entry overhead using Buffer.byteLength for accurate UTF-8
        // byte counts — covers header, handoff banner, aliases section, tier footer,
        // and a conservative allowance for the shed-notice line itself.
        let fixedOverheadBytes = 0;
        const headerLine = hasProject
          ? `[project: ${projectFile}]`
          : `[project: NONE — auto-scope writes will fall through to global. Pin RVR_PROJECT in the MCP server env, or pass scope:"project"/"global" explicitly on writes.]`;
        fixedOverheadBytes += Buffer.byteLength(`${headerLine}\n\n`, 'utf8');
        if (handoff) {
          for (const l of handoff.lines) fixedOverheadBytes += Buffer.byteLength(`${l}\n`, 'utf8');
          fixedOverheadBytes += 1; // blank line separator
        }
        if (Object.keys(aliases).length > 0) {
          fixedOverheadBytes += Buffer.byteLength('\nAliases:\n', 'utf8');
          for (const [a, t] of Object.entries(aliases)) {
            fixedOverheadBytes += Buffer.byteLength(`  ${a} -> ${t}\n`, 'utf8');
          }
        }
        // Tier footer always present in this branch (effectiveTier !== 'full').
        // Use pre-shed entry count as an upper bound on footer length.
        const preSheddableCount = Object.keys(displayed).length;
        fixedOverheadBytes += Buffer.byteLength(`\n[tier: ${effectiveTier} (${preSheddableCount} entries) — pass tier:"full" for complete context]\n`, 'utf8');
        // Conservative budget for the shed-notice line (emitted only when shedding
        // occurs, but including it here prevents the notice itself from pushing the
        // final response over budget).
        fixedOverheadBytes += 256;

        const decision = shedToFitBudget(displayed, (k) => getStalenessTag(k, meta), fixedOverheadBytes, effectiveBudget);
        kept = decision.kept;
        shedSegments = decision.segments;
        pathologicalOverflow = decision.pathologicalOverflow;

        if (shedSegments.length > 0 || pathologicalOverflow) {
          emitGuardrailSignals({
            degraded: true,
            shedNamespaces: shedSegments.map(s => s.label),
          });
        }
      }

      const lines: string[] = [];

      // Header: declare resolved project file so agents know where writes will land.
      if (hasProject) {
        lines.push(`[project: ${projectFile}]`);
      } else {
        lines.push(`[project: NONE — auto-scope writes will fall through to global. Pin RVR_PROJECT in the MCP server env, or pass scope:"project"/"global" explicitly on writes.]`);
      }
      lines.push('');

      // Shed notice — first thing after the project banner so agents see
      // exactly what was trimmed and how to retrieve it (#100).
      if (shedSegments.length > 0) {
        lines.push(formatShedNotice(shedSegments));
        lines.push('');
      }
      // Pathological overflow notice — surfaces explicitly that even after
      // shedding everything sheddable, the response still exceeds budget.
      if (pathologicalOverflow) {
        lines.push(PATHOLOGICAL_OVERFLOW_NOTICE);
        lines.push('');
      }

      // Banner before entries — first thing the agent sees after project line.
      if (handoff) {
        lines.push(...handoff.lines);
        if (Object.keys(kept).length > 0 || Object.keys(aliases).length > 0) {
          lines.push('');
        }
      }

      if (Object.keys(kept).length > 0) {
        for (const [k, v] of Object.entries(kept)) {
          const ageTag = getStalenessTag(k, meta);
          lines.push(`${k}: ${v}${ageTag}`);
        }
      }

      if (Object.keys(aliases).length > 0) {
        lines.push('');
        lines.push('Aliases:');
        for (const [a, t] of Object.entries(aliases)) {
          lines.push(`  ${a} -> ${t}`);
        }
      }

      const entryCount = Object.keys(kept).length;
      if (effectiveTier !== 'full') {
        lines.push('');
        lines.push(`[tier: ${effectiveTier} (${entryCount} entries) — pass tier:"full" for complete context]`);
      }

      return textResponse(lines.join("\n"));
    } catch (err) {
      return errorResponse(`Error loading context: ${String(err)}`);
    }
  }
);

// --- reverie_stale ---
server.tool(
  "reverie_stale",
  "List entries not written in N days (default 30) — knowledge that may have drifted. Write-based; a stale entry may still be read often.",
  {
    days: z.coerce.number().int().min(0).optional().describe("Threshold in days (default: 30). Entries not updated in this many days are returned."),
    scope: z.enum(["project", "global"]).optional().describe("Data scope (omit for auto: project if available, else global)"),
  },
  async ({ days, scope: scopeParam }) => {
    try {
      const threshold = days ?? 30;
      const scope = toScope(scopeParam);
      const { loadMeta, loadMetaMerged } = await import("./store");
      const meta = scope === 'auto' ? loadMetaMerged() : loadMeta(scope);
      const flat = getEntriesFlat(scope);
      const cutoff = Date.now() - threshold * 86400000;

      const stale: { key: string; ts: number | undefined }[] = [];
      for (const key of Object.keys(flat)) {
        const ts = meta[key];
        if (ts === undefined || ts < cutoff) {
          stale.push({ key, ts });
        }
      }
      // Sort: untracked first (most suspect), then oldest-first
      stale.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

      if (stale.length === 0) {
        return textResponse(`No entries older than ${threshold} days.`);
      }
      const lines = stale.map(({ key, ts }) => {
        const age = ts ? `${Math.floor((Date.now() - ts) / 86400000)}d ago` : 'untracked';
        return `${key}  (${age})`;
      });
      return textResponse(`${stale.length} entries not updated in ${threshold}+ days:\n${lines.join('\n')}`);
    } catch (err) {
      return errorResponse(`Error checking staleness: ${String(err)}`);
    }
  }
);

// --- reverie_stats ---
server.tool(
  "reverie_stats",
  "Aggregate usage stats — read/write ratio, bootstrap rate, top tools, namespace activity. Per-call history with filters: reverie_audit.",
  {
    period: z.enum(["7d", "30d", "90d", "all"]).optional().describe("Time period to analyze (default: 30d)"),
    detailed: z.boolean().optional().describe("Include namespace activity, project breakdown, and top tools (default: false)"),
  },
  async ({ period, detailed }) => {
    try {
      const stats = computeStats(parsePeriodDays(period));

      if (stats.totalCalls === 0) {
        return textResponse("No telemetry data yet. Usage will be tracked automatically as MCP tools are called.");
      }

      const lines: string[] = [];
      lines.push(`Reverie Usage Stats (${stats.period === 'all' ? 'all time' : `last ${stats.period}`})`);
      lines.push('');
      lines.push(`MCP sessions:    ${stats.mcpSessions}`);
      lines.push(`MCP calls:       ${stats.mcpCalls}`);
      if (stats.mcpSessions > 0) {
        lines.push(`  Bootstrap rate:  ${(stats.bootstrapRate * 100).toFixed(0)}% of MCP sessions call reverie_context first`);
        lines.push(`  Write-back rate: ${(stats.writeBackRate * 100).toFixed(0)}% of MCP sessions store at least 1 entry`);
      }
      lines.push(`CLI calls:       ${stats.cliCalls}`);
      lines.push(`Total calls:     ${stats.totalCalls}`);
      lines.push(`Read:write:      ${stats.readWriteRatio} (${stats.reads} reads, ${stats.writes} writes, ${stats.removes} removes, ${stats.execs} execs)`);

      const { project, global: glob, unscoped } = stats.scopeBreakdown;
      if (project > 0 || glob > 0) {
        const parts = [];
        if (project > 0) parts.push(`${project} project`);
        if (glob > 0) parts.push(`${glob} global`);
        if (unscoped > 0) parts.push(`${unscoped} unscoped`);
        lines.push(`Scope:           ${parts.join(', ')}`);
      }

      if (detailed && Object.keys(stats.namespaceCoverage).length > 0) {
        lines.push('');
        lines.push('Namespace activity:');
        const sorted = Object.entries(stats.namespaceCoverage)
          .sort(([, a], [, b]) => (b.reads + b.writes) - (a.reads + a.writes));
        for (const [ns, data] of sorted) {
          const age = data.lastWrite ? `${Math.floor((Date.now() - data.lastWrite) / 86400000)}d ago` : 'never';
          lines.push(`  ${ns.padEnd(20)} ${String(data.reads).padStart(3)} reads  ${String(data.writes).padStart(3)} writes  last write: ${age}`);
        }
      }

      // Project breakdown
      if (detailed) {
        const projects = Object.entries(stats.projectBreakdown);
        if (projects.length > 0) {
          lines.push('');
          lines.push('Project activity:');
          const sortedProjects = projects.sort(([, a], [, b]) => b - a);
          for (const [proj, count] of sortedProjects) {
            const label = proj.split('/').slice(-2).join('/');  // last 2 path segments
            lines.push(`  ${label.padEnd(30)} ${count} calls`);
          }
        }
      }

      // Session metrics
      if (stats.avgSessionCalls !== undefined || stats.avgSessionDurationMs !== undefined) {
        lines.push('');
        lines.push('Session metrics:');
        if (stats.avgSessionCalls !== undefined)
          lines.push(`  Avg calls/session: ${stats.avgSessionCalls.toFixed(1)}`);
        if (stats.avgSessionDurationMs !== undefined) {
          const secs = stats.avgSessionDurationMs / 1000;
          const label = secs < 60 ? `${secs.toFixed(1)}s` : `${(secs / 60).toFixed(1)}m`;
          lines.push(`  Avg session duration: ${label}`);
        }
      }

      // Token savings
      const hasEfficiency = stats.hitRate !== undefined || stats.redundantRate !== undefined || stats.totalResponseBytes > 0 || stats.avgDurationMs !== undefined;
      if (hasEfficiency) {
        lines.push('');
        lines.push('Token savings:');
        if (stats.hitRate !== undefined)
          lines.push(`  Lookup hit rate:   ${(stats.hitRate * 100).toFixed(0)}% of reads found stored data (${stats.hits} hits, ${stats.misses} misses)`);
        if (stats.redundantRate !== undefined && stats.writes > 0)
          lines.push(`  Duplicate writes:  ${(stats.redundantRate * 100).toFixed(0)}% of writes were already up to date (${stats.redundantWrites} of ${stats.writes})`);
        if (stats.totalResponseBytes > 0) {
          const kb = stats.totalResponseBytes / 1024;
          lines.push(`  Data served:       ${kb >= 1 ? `${kb.toFixed(1)}KB` : `${stats.totalResponseBytes}B`} returned from store${stats.avgResponseBytes !== undefined ? `, ${Math.round(stats.avgResponseBytes)}B avg` : ''}`);
        }
        if (stats.avgDurationMs !== undefined)
          lines.push(`  Avg latency:       ${Math.round(stats.avgDurationMs)}ms per call`);
        if (stats.estimatedTotalTokensSaved > 0) {
          const fmtNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
          lines.push(`  Est. tokens saved: ~${fmtNum(stats.estimatedTotalTokensSaved)} (exploration avoided by using stored knowledge)`);
          lines.push(`    Delivery cost:   ~${fmtNum(stats.deliveryCostTokens)} tokens (context delivered to agent)`);
          lines.push(`    Net savings:     ~${fmtNum(stats.netTokensSaved)} tokens`);
          if (detailed) {
            lines.push('    By namespace:');
            const breakdown = Object.entries(stats.explorationBreakdown)
              .sort(([,a], [,b]) => b.tokensSaved - a.tokensSaved);
            for (const [ns, { hits, tokensSaved }] of breakdown) {
              const perHit = hits > 0 ? Math.round(tokensSaved / hits) : 0;
              const cal = stats.calibration[ns];
              const calTag = cal ? (cal.source === 'observed' ? ` [observed, n=${cal.samples}]` : ' [static]') : '';
              lines.push(`      ${ns.padEnd(15)} ~${fmtNum(tokensSaved)} (${hits} lookup${hits !== 1 ? 's' : ''} × ${fmtNum(perHit)} each)${calTag}`);
            }
            if (stats.estimatedRedundantWriteTokensSaved > 0) {
              lines.push(`    Duplicate writes avoided: ~${fmtNum(stats.estimatedRedundantWriteTokensSaved)} (${stats.redundantWrites} write${stats.redundantWrites !== 1 ? 's' : ''} already up to date)`);
            }
            const calEntries = Object.values(stats.calibration);
            if (calEntries.length > 0) {
              const observed = calEntries.filter(c => c.source === 'observed').length;
              const total = calEntries.length;
              lines.push(`    Calibration: ${observed}/${total} namespaces observed, ${total - observed} static`);
            }
          }
        } else if (stats.estimatedTokensSaved > 0) {
          const fmt = stats.estimatedTokensSaved >= 1000 ? `${(stats.estimatedTokensSaved / 1000).toFixed(1)}K` : String(stats.estimatedTokensSaved);
          lines.push(`  Est. tokens saved: ~${fmt} (cached data served to agents)`);
        }
      }

      const agents = Object.entries(stats.agentBreakdown);
      if (detailed && agents.length > 0) {
        lines.push('');
        lines.push('Agent activity:');
        for (const [agent, data] of agents.sort(([,a],[,b]) => b.calls - a.calls)) {
          lines.push(`  ${agent.padEnd(24)} ${data.calls} calls (${data.reads}R ${data.writes}W)`);
        }
      }

      if (detailed && stats.topTools.length > 0) {
        lines.push('');
        lines.push('Top tools:');
        for (const { tool, count } of stats.topTools) {
          lines.push(`  ${tool.padEnd(24)} ${count} calls`);
        }
      }

      // Trend comparison
      if (stats.trend) {
        const t = stats.trend;
        const fmtDelta = (v: number | undefined, suffix = '%') => {
          if (v === undefined) return undefined;
          const sign = v >= 0 ? '+' : '';
          return `${sign}${v.toFixed(0)}${suffix}`;
        };
        const trendParts: string[] = [];
        const cd = fmtDelta(t.callsDelta);
        if (cd) trendParts.push(`calls ${cd}`);
        const sd = fmtDelta(t.sessionsDelta);
        if (sd) trendParts.push(`sessions ${sd}`);
        const hd = fmtDelta(t.hitRateDelta, 'pp');
        if (hd) trendParts.push(`hit rate ${hd}`);
        const dd = fmtDelta(t.avgDurationDelta);
        if (dd) trendParts.push(`latency ${dd}`);
        if (trendParts.length > 0) {
          lines.push('');
          lines.push(`Trend (vs prev ${stats.period}): ${trendParts.join(', ')}`);
        }
      }

      return textResponse(lines.join('\n'));
    } catch (err) {
      return errorResponse(`Error computing stats: ${String(err)}`);
    }
  }
);

// --- reverie_audit ---
server.tool(
  "reverie_audit",
  "Query the per-call audit log with filters (key prefix, period, writes-only, hits/misses, source). Aggregates: reverie_stats.",
  {
    key: z.string().optional().describe("Filter by exact key or key prefix"),
    period: z.enum(["7d", "30d", "90d", "all"]).optional().describe("Time period to query (default: 30d)"),
    writes_only: z.boolean().optional().describe("Show only write operations"),
    src: z.enum(["mcp", "cli"]).optional().describe("Filter by source: mcp or cli"),
    project: z.string().optional().describe("Filter by project directory path"),
    hits_only: z.boolean().optional().describe("Show only read operations that returned data (hits)"),
    misses_only: z.boolean().optional().describe("Show only read operations that found nothing (misses)"),
    redundant_only: z.boolean().optional().describe("Show only writes where value didn't change"),
    detailed: z.boolean().optional().describe("Show per-entry metrics (duration, sizes, hit/miss) (default: false)"),
    limit: z.coerce.number().int().min(1).max(500).optional().describe("Max entries to return (default: 50)"),
  },
  async ({ key, period, writes_only, src, project, hits_only, misses_only, redundant_only, detailed, limit }) => {
    try {
      const entries = queryAuditLog({ key, periodDays: parsePeriodDays(period), writesOnly: writes_only, src, project, hitsOnly: hits_only, missesOnly: misses_only, redundantOnly: redundant_only, limit: limit ?? 50 });

      if (entries.length === 0) {
        return textResponse("No audit entries found.");
      }

      const lines: string[] = [];
      lines.push(`Audit Log (${entries.length} entries)\n`);

      for (const e of entries) {
        const time = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
        const status = e.success ? 'OK' : 'FAIL';
        const keyStr = e.key ?? '(bulk)';
        const parts = [`${time}  ${e.src}  ${e.tool.padEnd(20)}  ${keyStr}  [${e.scope ?? 'auto'}]  ${status}`];
        if (e.project) parts[0] += `  project=${e.project}`;
        if (e.agent) parts[0] += `  agent=${e.agent}`;
        lines.push(parts[0]);

        if (e.before !== undefined) lines.push(`  - ${e.before}`);
        if (e.after !== undefined) lines.push(`  + ${e.after}`);
        if (e.error) lines.push(`  error: ${e.error}`);

        // Metrics tags (detailed only)
        if (detailed) {
          const tags: string[] = [];
          if (e.duration !== undefined) tags.push(`${e.duration}ms`);
          if (e.aliasResolved) tags.push(`alias->${e.aliasResolved}`);
          if (e.responseSize !== undefined) tags.push(`res=${e.responseSize}B`);
          if (e.requestSize !== undefined) tags.push(`req=${e.requestSize}B`);
          if (e.hit !== undefined) tags.push(e.hit ? 'hit' : 'miss');
          if (e.tier !== undefined) tags.push(`tier=${e.tier}`);
          if (e.entryCount !== undefined) tags.push(`n=${e.entryCount}`);
          if (e.redundant) tags.push('redundant');
          if (tags.length > 0) lines.push(`  [${tags.join(', ')}]`);
        }
      }

      return textResponse(lines.join('\n'));
    } catch (err) {
      return errorResponse(`Error querying audit log: ${String(err)}`);
    }
  }
);

// --- Flush miss-path windows on shutdown ---
process.on('beforeExit', () => {
  for (const mp of missTracker.flushAll()) {
    void appendMissPath(mp, true); // sync write for shutdown — promise resolves immediately
  }
});

// --- Start server ---
/**
 * Try to learn the active project directory from the MCP client's `roots`.
 * Called after the transport is connected and the initialize handshake has
 * completed. Best-effort: failures are silent because not every client
 * implements `roots/list`.
 */
async function applyClientRootsOverride(): Promise<void> {
  // RVR_PROJECT (handled in paths.ts) takes precedence — don't override it.
  if (process.env.RVR_PROJECT) return;
  try {
    // McpServer wraps the low-level Server. Only request roots if the client
    // advertised the capability during initialize — otherwise the request
    // can hang or error on clients that don't implement roots/list.
    const lowLevel = (server as unknown as {
      server: {
        getClientCapabilities: () => { roots?: unknown } | undefined;
        listRoots: () => Promise<{ roots?: { uri: string }[] }>;
      }
    }).server;
    const caps = lowLevel.getClientCapabilities?.();
    if (!caps?.roots) return;

    // Hard timeout in case the client advertises the capability but stalls.
    const timeoutMs = 2000;
    const result = await Promise.race([
      lowLevel.listRoots(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('listRoots timeout')), timeoutMs)),
    ]);
    const first = result?.roots?.[0]?.uri;
    if (!first) return;
    let dir: string;
    if (first.startsWith('file://')) {
      dir = fileURLToPath(first);
    } else if (first.startsWith('/')) {
      dir = first;
    } else {
      return;
    }
    setProjectRootOverride(dir);
  } catch {
    // Client doesn't support roots, or request failed — fall back to cwd.
  }
}

export async function startMcpServer(): Promise<void> {
  // Honor explicit project-dir hints before connect, in case the client
  // doesn't implement roots and the launcher passed RVR_PROJECT_DIR/--cwd.
  const projectDir = process.env.RVR_PROJECT_DIR
    ?? (process.argv.includes('--cwd') ? process.argv[process.argv.indexOf('--cwd') + 1] : undefined);
  if (projectDir) {
    setProjectRootOverride(projectDir);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // After the handshake, prefer client-advertised roots over launcher hints.
  await applyClientRootsOverride();
}

// Auto-start when run directly (e.g. `bun dist/mcp-server.js`, `rvr-dev-mcp`, or production `rvr-mcp`)
// When imported by index.ts for the `mcp-server` subcommand, the caller invokes startMcpServer() explicitly.
if (process.argv[1] && (process.argv[1].endsWith('mcp-server.js') || process.argv[1].endsWith('rvr-dev-mcp') || process.argv[1].endsWith('rvr-mcp'))) {
  startMcpServer().catch((err) => {
    process.stderr.write(`MCP server error: ${err}\n`);
    process.exit(1);
  });
}
