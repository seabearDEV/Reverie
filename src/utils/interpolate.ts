import { execSync } from 'child_process';
import { resolveKey } from '../alias';
import { getValue } from '../storage';
import { flattenObject } from './objectPath';
import { isEncrypted } from './crypto';
import { CodexValue } from '../types';

const MAX_DEPTH = 10;

/**
 * Errors thrown for *load-bearing* interpolation failures — the user
 * explicitly opted into "fail loudly" semantics, so callers that fall back
 * to the raw template on a normal error must NOT swallow these.
 *
 * Two cases qualify:
 *   1. `${key:?msg}` required-check on a missing key. The user marked the
 *      key as required precisely because the literal template would be
 *      meaningless if rendered.
 *   2. Circular reference detection. Returning the literal `${a}` after
 *      we caught `a → b → a` would mask a real configuration bug.
 *
 * Plain "key not found" errors (no `:?`, no cycle) are not StrictInterpolationError
 * — those are still swallowed by interpolateObject's fallback so a get on a
 * subtree with one broken template doesn't fail the whole subtree.
 */
export class StrictInterpolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictInterpolationError';
  }
}

/**
 * Parse a ref string for conditional modifiers (`:-` default, `:?` error).
 * Returns the key and optional modifier with its value.
 *
 * Examples:
 *   "key"              → { key: "key" }
 *   "key:-fallback"    → { key: "key", modifier: ":-", modValue: "fallback" }
 *   "key:?must be set" → { key: "key", modifier: ":?", modValue: "must be set" }
 */
function parseRef(ref: string): { key: string; modifier?: ':-' | ':?'; modValue?: string } {
  // Scan left-to-right, skipping nested ${...} blocks, to find the first top-level :- or :?
  let depth = 0;

  for (let i = 0; i < ref.length - 1; i++) {
    if (ref[i] === '$' && ref[i + 1] === '{') {
      depth++;
      i++;
      continue;
    }

    if (ref[i] === '}' && depth > 0) {
      depth--;
      continue;
    }

    if (depth === 0 && ref[i] === ':' && (ref[i + 1] === '-' || ref[i + 1] === '?')) {
      const modifier = ref.slice(i, i + 2) as ':-' | ':?';
      return { key: ref.slice(0, i), modifier, modValue: ref.slice(i + 2) };
    }
  }

  return { key: ref };
}

/**
 * Resolve a `${key}` reference: look up stored value, validate, and recurse.
 * Supports conditional modifiers:
 *   `${key:-default}` — use default if key is not found
 *   `${key:?error}`   — throw custom error if key is not found
 */
function resolveRef(ref: string, maxDepth: number, seen: Set<string>, execCache: Map<string, string>, allowExec: boolean): string {
  const { key: rawKey, modifier, modValue } = parseRef(ref);
  const resolvedKey = resolveKey(rawKey.trim());

  if (seen.has(resolvedKey)) {
    const chain = [...seen, resolvedKey].join(' → ');
    // Strict: a cycle is a structural bug, not a "missing data" condition.
    // Subtree fallbacks would mask real misconfigurations.
    throw new StrictInterpolationError(`Circular interpolation detected: ${chain}`);
  }

  const resolved = getValue(resolvedKey);

  if (resolved === undefined) {
    if (modifier === ':-') {
      // Default value — interpolate it in case it contains ${} references
      return interpolate(modValue ?? '', maxDepth, seen, execCache, allowExec);
    }
    if (modifier === ':?') {
      // Strict: the user opted in to fail-loud by writing `:?`. If we
      // returned the raw template here, the loudness would be silent.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string should also use generic message
      throw new StrictInterpolationError(modValue || `"${rawKey.trim()}" is required but not set`);
    }
    throw new Error(`Interpolation failed: "${rawKey.trim()}" not found`);
  }

  if (typeof resolved !== 'string') {
    throw new Error(`Interpolation failed: "${rawKey.trim()}" is not a string value`);
  }

  if (isEncrypted(resolved)) {
    throw new Error(`Interpolation failed: "${rawKey.trim()}" is encrypted`);
  }

  if (maxDepth <= 0) {
    throw new Error(`Interpolation depth limit exceeded`);
  }

  const nextSeen = new Set(seen);
  nextSeen.add(resolvedKey);
  return interpolate(resolved, maxDepth - 1, nextSeen, execCache, allowExec);
}

/**
 * Resolve a `$(key)` exec reference: look up stored command, interpolate it,
 * execute via shell, and return trimmed stdout. Results are cached per pass.
 *
 * Only ever called when `allowExec` is true (the explicit `run`-execution
 * path). Read/display/dry/preview passes leave `$(key)` literal instead — see
 * the SECURITY note on `interpolate()`.
 */
function resolveExecRef(ref: string, maxDepth: number, seen: Set<string>, execCache: Map<string, string>): string {
  const resolvedKey = resolveKey(ref.trim());

  if (seen.has(resolvedKey)) {
    const chain = [...seen, resolvedKey].join(' → ');
    throw new StrictInterpolationError(`Circular interpolation detected: ${chain}`);
  }

  // Return cached result if already executed in this pass
  if (execCache.has(resolvedKey)) {
    return execCache.get(resolvedKey)!;
  }

  const resolved = getValue(resolvedKey);

  if (resolved === undefined) {
    throw new Error(`Exec interpolation failed: "${ref}" not found`);
  }

  if (typeof resolved !== 'string') {
    throw new Error(`Exec interpolation failed: "${ref}" is not a string value`);
  }

  if (isEncrypted(resolved)) {
    throw new Error(`Exec interpolation failed: "${ref}" is encrypted`);
  }

  if (maxDepth <= 0) {
    throw new Error(`Interpolation depth limit exceeded`);
  }

  // Interpolate the command itself first (so stored commands can use ${} or $()).
  // We are already on the exec path, so nested refs resolve in exec mode too.
  const nextSeen = new Set(seen);
  nextSeen.add(resolvedKey);
  const command = interpolate(resolved, maxDepth - 1, nextSeen, execCache, true);

  // Execute
  const shell = process.env.SHELL ?? '/bin/sh';
  try {
    const stdout = execSync(command, { encoding: 'utf-8', shell, timeout: 10000 });
    // Trim trailing newline (shell commands typically append one)
    const result = stdout.replace(/\n$/, '');
    execCache.set(resolvedKey, result);
    return result;
  } catch (err: unknown) {
    const code = (err && typeof err === 'object' && 'status' in err) ? Number((err as { status: number }).status) : 1;
    // No `cause` on purpose: the ExecSyncError carries the child's stdout/stderr
    // buffers, and this message is deliberately terse (exit code only). Attaching
    // the original error would let any handler that inspects the cause chain
    // surface command output the message intentionally withholds.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Exec interpolation failed: "${ref}" exited with code ${code}`);
  }
}

/**
 * Interpolate `${key_or_alias}` and `$(key_or_alias)` references within a string value.
 *
 * - `${key}` resolves to the stored value of a key (recursive).
 * - `$(key)` executes the stored command and substitutes its stdout — ONLY when
 *   `allowExec` is true.
 *
 * SECURITY (read = RCE, fixed): executing `$(key)` is a side effect of
 * substitution, and substitution happens on read/list/json/lint/dry/preview
 * paths — not just `run`. A hostile `.reverie/` store shipped in a cloned repo
 * could therefore achieve code execution the moment an agent merely *read* an
 * entry (`rvr get`, `reverie_get`, `--values`), or during a "safe" `--dry`
 * preview. To close this, exec resolution is OPT-IN: `allowExec` defaults to
 * false (the safe path leaves `$(key)` literal), and only the actual
 * `run`-execution moment — past the confirm gate, with `dry` false — passes
 * true. Any new call site that forgets the flag is safe by default.
 *
 * References are resolved at read time via the data store and alias map.
 * Supports recursive resolution with circular reference detection.
 */
export function interpolate(
  value: string,
  maxDepth: number = MAX_DEPTH,
  seen = new Set<string>(),
  execCache = new Map<string, string>(),
  allowExec = false,
): string {
  // Early return if no interpolation markers present
  if (!value.includes('${') && !value.includes('$(')) return value;

  // Phase 1: resolve ${key} references (brace-aware to support nested ${} in defaults)
  // Backslash escape: \${...} emits literal ${...}, \$(...) emits literal $(...)
  let result = value;
  if (result.includes('${')) {
    let out = '';
    let i = 0;
    while (i < result.length) {
      // Escaped value ref: \${...} → literal ${...}
      if (result[i] === '\\' && result[i + 1] === '$' && result[i + 2] === '{') {
        let depth = 1;
        let j = i + 3;
        while (j < result.length && depth > 0) {
          if (result[j] === '{' && j > 0 && result[j - 1] === '$') depth++;
          else if (result[j] === '}') depth--;
          if (depth > 0) j++;
        }
        if (depth === 0) {
          out += result.slice(i + 1, j + 1); // emit ${...} literally, consume backslash
          i = j + 1;
        } else {
          out += result[i];
          i++;
        }
        continue;
      }
      if (result[i] === '$' && result[i + 1] === '{') {
        // Scan for matching closing brace, tracking nesting depth
        let depth = 1;
        let j = i + 2;
        while (j < result.length && depth > 0) {
          if (result[j] === '{' && j > 0 && result[j - 1] === '$') depth++;
          else if (result[j] === '}') depth--;
          if (depth > 0) j++;
        }
        if (depth === 0) {
          const ref = result.slice(i + 2, j);
          out += ref === '' ? '${}' : resolveRef(ref, maxDepth, seen, execCache, allowExec);
          i = j + 1;
        } else {
          // Unclosed brace — leave as-is
          out += result[i];
          i++;
        }
      } else {
        out += result[i];
        i++;
      }
    }
    result = out;
  }

  // Phase 2: resolve $(key) exec references
  if (result.includes('$(')) {
    let out = '';
    let i = 0;
    while (i < result.length) {
      // Escaped exec ref: \$(...) → literal $(...)
      if (result[i] === '\\' && result[i + 1] === '$' && result[i + 2] === '(') {
        const close = result.indexOf(')', i + 3);
        if (close !== -1) {
          out += result.slice(i + 1, close + 1); // emit $(...) literally, consume backslash
          i = close + 1;
        } else {
          out += result[i];
          i++;
        }
        continue;
      }
      if (result[i] === '$' && result[i + 1] === '(') {
        const close = result.indexOf(')', i + 2);
        if (close !== -1) {
          if (allowExec) {
            const ref = result.slice(i + 2, close);
            out += resolveExecRef(ref, maxDepth, seen, execCache);
          } else {
            // SECURITY: safe (non-exec) pass — leave `$(key)` literal rather
            // than executing the referenced stored command. Reads, --dry, and
            // confirm previews take this branch.
            out += result.slice(i, close + 1);
          }
          i = close + 1;
        } else {
          out += result[i];
          i++;
        }
      } else {
        out += result[i];
        i++;
      }
    }
    result = out;
  }

  return result;
}

/**
 * Exec-enabled interpolation: resolve `${key}` value refs AND execute `$(key)`
 * exec refs. This is the ONLY entry point that runs stored commands — reserve
 * it for the explicit `run`-execution moment, past the confirm gate and with
 * `dry` false. Everything else must use `interpolate()` (safe default).
 */
export function interpolateExec(value: string): string {
  return interpolate(value, MAX_DEPTH, new Set<string>(), new Map<string, string>(), true);
}

/**
 * Interpolate all leaf string values in a nested object (subtree).
 * Returns a new object with interpolated values.
 * Shares a single execCache across all leaves so exec results are cached.
 *
 * SECURITY: safe by default — leaves `$(key)` literal (no execution). Used by
 * read/display paths (`get --values`, MCP subtree); they must never execute.
 */
export function interpolateObject(obj: Record<string, CodexValue>): Record<string, CodexValue> {
  const flat = flattenObject(obj);
  const result: Record<string, CodexValue> = {};
  const execCache = new Map<string, string>();

  for (const [key, value] of Object.entries(flat)) {
    if (typeof value === 'string' && !isEncrypted(value)) {
      try {
        result[key] = interpolate(value, MAX_DEPTH, new Set<string>(), execCache);
      } catch (err) {
        // StrictInterpolationError signals load-bearing failures (`:?`
        // required check, circular reference) — the user explicitly opted
        // in to fail loudly, so don't swallow them under the subtree fallback.
        if (err instanceof StrictInterpolationError) throw err;
        // For everything else (key not found, not-a-string, encrypted),
        // keep the raw template so a single broken leaf doesn't fail the
        // whole subtree get.
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}
