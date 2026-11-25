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
 * A `${name}` that cannot be resolved: no such key, a group of entries where
 * a value is needed, or an encrypted value (#202). Distinct from
 * StrictInterpolationError, which the author asked for with `:?` or caused
 * with a cycle.
 *
 * `run` still fails on it — a command must not execute with a hole in it. A
 * read does not: the entry exists and its text is what was stored, so read
 * paths return it as written and say so (interpolateForRead). The message is
 * unchanged from when this was a plain Error.
 */
export class UnresolvedReferenceError extends Error {
  readonly ref: string;
  readonly reason: 'missing' | 'not-a-value' | 'encrypted';

  constructor(message: string, ref: string, reason: 'missing' | 'not-a-value' | 'encrypted') {
    super(message);
    this.name = 'UnresolvedReferenceError';
    this.ref = ref;
    this.reason = reason;
  }
}

/** A read that fell back to the stored text, and why. */
export interface UnresolvedOnRead {
  /** The reference as written, without the `${}`; undefined when the failure was not about one reference. */
  ref?: string;
  /** One clause: what is wrong with it. Never contains the phrase the MCP miss detector keys on. */
  why: string;
}

/**
 * Interpolate a value for a READ (#202): `get`, a subtree listing, the MCP
 * read tools. Never executes — the default, safe `interpolate`. A value that
 * cannot be fully resolved is returned exactly as stored, with the reason, so
 * every read path gives the same answer and the caller can warn. Before this,
 * one stored value gave four answers: `set` accepted it silently, plain `get`
 * failed with exit 1, `get --json` returned it raw without a word, and `lint`
 * passed.
 *
 * StrictInterpolationError still propagates: `${key:?message}` and a cycle
 * are the author asking for a loud failure.
 */
export function interpolateForRead(value: string, execCache = new Map<string, string>()): { value: string; unresolved?: UnresolvedOnRead } {
  try {
    return { value: interpolate(value, MAX_DEPTH, new Set<string>(), execCache) };
  } catch (err) {
    if (err instanceof StrictInterpolationError) throw err;
    return { value, unresolved: describeFailure(err) };
  }
}

function describeFailure(err: unknown): UnresolvedOnRead {
  if (err instanceof UnresolvedReferenceError) {
    const why = err.reason === 'missing' ? 'is not a stored key'
      : err.reason === 'not-a-value' ? 'is a group of entries, not a value'
      : 'is encrypted';
    return { ref: err.ref, why };
  }
  return { why: 'nests references too deeply to resolve' };
}

/**
 * The warning for an entry whose value was returned as written. Says what to
 * do in both cases: fix the reference, or escape text that only looks like one.
 */
export function unresolvedWarning(key: string, u: UnresolvedOnRead): string {
  if (u.ref === undefined) return `'${key}' ${u.why}. Its value is returned as written.`;
  return `'${key}' refers to \${${u.ref}}, which ${u.why}. Its value is returned as written. `
    + `If that is literal text, store it escaped: \\\${${u.ref}}.`;
}

/** Envelope warning code for unresolvedWarning. */
export const UNRESOLVED_WARNING_CODE = 'INTERPOLATION_UNRESOLVED';

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
function resolveRef(ref: string, maxDepth: number, seen: Set<string>, execCache: Map<string, string>, allowExec: boolean, visited?: Set<string>, noExec = false): string {
  const { key: rawKey, modifier, modValue } = parseRef(ref);
  const resolvedKey = resolveKey(rawKey.trim());
  // #158: record every key reached through interpolation so the run-path
  // confirm gate can consult keys pulled in transitively, not just the
  // top-level segments. Recorded before the existence check so a `${gated}`
  // ref counts even via a `:-`/`:?` path.
  visited?.add(resolvedKey);

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
      return interpolate(modValue ?? '', maxDepth, seen, execCache, allowExec, visited, noExec);
    }
    if (modifier === ':?') {
      // Strict: the user opted in to fail-loud by writing `:?`. If we
      // returned the raw template here, the loudness would be silent.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string should also use generic message
      throw new StrictInterpolationError(modValue || `"${rawKey.trim()}" is required but not set`);
    }
    throw new UnresolvedReferenceError(`Interpolation failed: "${rawKey.trim()}" not found`, rawKey.trim(), 'missing');
  }

  if (typeof resolved !== 'string') {
    throw new UnresolvedReferenceError(`Interpolation failed: "${rawKey.trim()}" is not a string value`, rawKey.trim(), 'not-a-value');
  }

  if (isEncrypted(resolved)) {
    throw new UnresolvedReferenceError(`Interpolation failed: "${rawKey.trim()}" is encrypted`, rawKey.trim(), 'encrypted');
  }

  if (maxDepth <= 0) {
    throw new Error(`Interpolation depth limit exceeded`);
  }

  const nextSeen = new Set(seen);
  nextSeen.add(resolvedKey);
  // #158 (audit round 2): thread noExec so a `${value}` → `$(exec)` chain
  // stays in collect mode. Dropping it here left the nested exec ref literal
  // during enumeration while the real run (allowExec) still executed it — the
  // exact enumeration≠execution divergence the confirm gate must not have.
  return interpolate(resolved, maxDepth - 1, nextSeen, execCache, allowExec, visited, noExec);
}

/**
 * Resolve a `$(key)` exec reference: look up stored command, interpolate it,
 * execute via shell, and return trimmed stdout. Results are cached per pass.
 *
 * Only ever called when `allowExec` is true (the explicit `run`-execution
 * path). Read/display/dry/preview passes leave `$(key)` literal instead — see
 * the SECURITY note on `interpolate()`.
 */
function resolveExecRef(ref: string, maxDepth: number, seen: Set<string>, execCache: Map<string, string>, visited?: Set<string>, noExec = false): string {
  const resolvedKey = resolveKey(ref.trim());
  // #158: an exec ref pulls in a key transitively too — record it for the
  // confirm gate.
  visited?.add(resolvedKey);

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
    // Collect mode (#158): a missing exec ref is not fatal — we are only
    // enumerating keys for the gate, not producing a command.
    if (noExec) return '';
    throw new Error(`Exec interpolation failed: "${ref}" not found`);
  }

  if (typeof resolved !== 'string') {
    if (noExec) return '';
    throw new Error(`Exec interpolation failed: "${ref}" is not a string value`);
  }

  if (isEncrypted(resolved)) {
    if (noExec) return '';
    throw new Error(`Exec interpolation failed: "${ref}" is encrypted`);
  }

  if (maxDepth <= 0) {
    throw new Error(`Interpolation depth limit exceeded`);
  }

  // Interpolate the command itself first (so stored commands can use ${} or $()).
  // We are already on the exec path, so nested refs resolve in exec mode too.
  const nextSeen = new Set(seen);
  nextSeen.add(resolvedKey);
  const command = interpolate(resolved, maxDepth - 1, nextSeen, execCache, !noExec, visited, noExec);

  // Collect mode (#158): recurse to enumerate nested keys but never execute.
  if (noExec) return '';

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
  visited?: Set<string>,
  noExec = false,
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
          out += ref === '' ? '${}' : resolveRef(ref, maxDepth, seen, execCache, allowExec, visited, noExec);
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
          if (allowExec || noExec) {
            // noExec (#158): enter the ref to enumerate keys for the confirm
            // gate, but resolveExecRef skips execSync in that mode.
            const ref = result.slice(i + 2, close);
            out += resolveExecRef(ref, maxDepth, seen, execCache, visited, noExec);
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
 * Enumerate every stored key a value would touch when run — both `${key}`
 * value refs and `$(key)` exec refs, transitively — WITHOUT executing
 * anything (#158). Uses the same scanner as interpolate() so the key set can
 * never diverge from what execution actually reaches; that shared-scanner
 * property is the whole point — a bespoke parser would be one crafted ref away
 * from missing a gated key. The run-path confirm gate unions this with the
 * top-level keys so a confirm-gated command pulled in via interpolation still
 * forces the prompt / refusal.
 */
export function collectReferencedKeys(value: string): Set<string> {
  const visited = new Set<string>();
  try {
    interpolate(value, MAX_DEPTH, new Set<string>(), new Map<string, string>(), false, visited, true);
  } catch {
    // Collection is best-effort for gating: a cycle or depth-limit throw still
    // leaves `visited` populated with everything reached so far, and the gate
    // errs toward MORE keys, never fewer.
  }
  return visited;
}

/**
 * Interpolate all leaf string values in a nested object (subtree).
 * Returns a new object with interpolated values.
 * Shares a single execCache across all leaves so exec results are cached.
 *
 * SECURITY: safe by default — leaves `$(key)` literal (no execution). Used by
 * read/display paths (`get --values`, MCP subtree); they must never execute.
 */
export function interpolateObject(
  obj: Record<string, CodexValue>,
  onUnresolved?: (key: string, unresolved: UnresolvedOnRead) => void,
): Record<string, CodexValue> {
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
        // whole subtree get — and tell the caller, so it can warn (#202).
        result[key] = value;
        onUnresolved?.(key, describeFailure(err));
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}
