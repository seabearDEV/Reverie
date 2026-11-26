import { execSync } from 'child_process';
import { resolveKey } from '../alias';
import { getValueWithStore } from '../storage';
import { flattenObject } from './objectPath';
import { isEncrypted } from './crypto';
import { StoreUnreadableError } from './unreadable';
import { CodexValue } from '../types';

const MAX_DEPTH = 10;

/**
 * The store an entry is in, which decides where the references in its value
 * resolve (#280). A reference resolves in the store of the entry that holds
 * it. A global entry's `${key}` and `$(key)`, and the aliases they name, read
 * the global store only, all the way down: a cloned project's entries never
 * fill in, or run as part of, the user's own global command. A project
 * entry's references read the project, then the global store, as a read by
 * key does. Outside a project the two are the same.
 *
 * Every caller that interpolates a stored value passes the store it read the
 * value from. 'project' is the default only so that a value with no store
 * (a test, a default text) keeps the old lookup.
 */
export type EntryStore = 'project' | 'global';

/** resolveKey as the references of an entry in `from` see the alias maps. */
function resolveIn(name: string, from: EntryStore): string {
  return from === 'global' ? resolveKey(name, 'global') : resolveKey(name);
}

/** The value a reference in an entry of `from` reads, and the store it was found in. */
function readIn(key: string, from: EntryStore): { value: CodexValue | undefined; store: EntryStore } {
  const found = from === 'global' ? getValueWithStore(key, 'global') : getValueWithStore(key);
  return found ?? { value: undefined, store: from };
}

/**
 * One entry, as `store:key`: the same key in the two stores is two entries,
 * with two values and two commands. Cycle detection and the exec cache count
 * entries, not names.
 */
function entryId(store: EntryStore, key: string): string {
  return `${store}:${key}`;
}

function keyOfId(id: string): string {
  return id.slice(id.indexOf(':') + 1);
}

/**
 * The names the confirmation gate asks about for one lookup (#279): the name
 * as written — as resolveKey reads it, a trailing colon dropped — and the key
 * its alias resolves to. A flag gates a name in every project, so a project
 * alias over a flagged name must not take the run past the flag: checking
 * only the target let a cloned repo's `_aliases.json` point the user's
 * flagged name at a command of its own.
 *
 * `projectAliases`: the lookup read the project's alias map. Then the key the
 * global map alone gives the name is checked too — a project alias must not
 * take a name away from the user's own global alias to a flagged command.
 * Each extra name only gates more.
 */
export function gateNamesFor(typed: string, resolved: string, projectAliases = false): string[] {
  const name = typed.replace(/:$/, '');
  const names = new Set([name, resolved]);
  if (projectAliases) names.add(resolveKey(name, 'global'));
  return [...names];
}

/**
 * What a collect pass reaches (#158): what the confirmation gate checks, and
 * what a confirm token approves.
 */
export interface ReferenceTrace {
  /** Every name the run looks up — as written and as its alias resolves (#279). */
  keys: Set<string>;
  /** Every entry read, as `store:key`, with the value read (null: none). For the MCP confirm token (#243). */
  reads: Map<string, CodexValue | null>;
}

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


/** Why a `${name}` does not resolve. */
export type UnresolvedReason = 'missing' | 'not-a-value' | 'encrypted' | 'too-deep';

/**
 * A `${name}` that cannot be resolved: no such key, a group of entries where
 * a value is needed, an encrypted value, or a chain of references longer than
 * the depth limit (#202). Distinct from StrictInterpolationError, which the
 * author asked for with `:?` or caused with a cycle.
 *
 * `run` still fails on it — a command must not execute with a hole in it. A
 * read does not: the entry exists and its text is what was stored, so read
 * paths return it as written and say so (interpolateForRead). The messages
 * are unchanged from when these were plain Errors.
 */
export class UnresolvedReferenceError extends Error {
  /** The reference exactly as written between `\${` and `}`: spaces and any modifier included. */
  readonly ref: string;
  readonly reason: UnresolvedReason;

  constructor(message: string, ref: string, reason: UnresolvedReason) {
    super(message);
    this.name = 'UnresolvedReferenceError';
    this.ref = ref;
    this.reason = reason;
  }
}

/** A read that fell back to the stored text, and why. */
export interface UnresolvedOnRead {
  /**
   * The reference that does not resolve, as written, without the `${}`.
   * Undefined when no one reference is at fault: the chain is too deep, or
   * the entry it names exists and its file cannot be read.
   */
  ref?: string;
  /**
   * Set when the failure is in another entry: the reference written in the
   * value being read that leads there. Escaping `ref` in this entry would
   * fix nothing, so the warning does not suggest it.
   */
  via?: string;
  /** One clause: what is wrong. Never contains the phrase the MCP miss detector keys on. */
  why: string;
}

/**
 * A reference a read kept as written instead of failing on. `nested` is true
 * when it was found in another entry's value, reached through a reference.
 */
interface Tolerated {
  err: UnresolvedReferenceError | StoreUnreadableError;
  nested: boolean;
  via?: string;
}

/**
 * The two failures that mean "this reference does not resolve", which a read
 * answers with the stored text: an UnresolvedReferenceError, and a reference
 * to an entry whose file exists but cannot be read (#215). Nothing else:
 * StrictInterpolationError is the author asking for a loud failure, and any
 * other error is a fault.
 */
function fallsBackOnRead(err: unknown): err is UnresolvedReferenceError | StoreUnreadableError {
  return err instanceof UnresolvedReferenceError || err instanceof StoreUnreadableError;
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
 * Only a reference that does not resolve falls back (fallsBackOnRead), and
 * the scan goes on past it. So a `${key:?message}` or a cycle anywhere in the
 * value, or in an entry it reaches, still fails the read — also when a plain
 * unresolved reference comes first. Any other error propagates too: a fault
 * is not a value to return with a warning that guesses at the cause.
 */
export function interpolateForRead(value: string, from: EntryStore = 'project', execCache = new Map<string, string>()): { value: string; unresolved?: UnresolvedOnRead } {
  const tolerated: Tolerated[] = [];
  // allowExec stays false: this is a read.
  const resolved = interpolate(value, MAX_DEPTH, new Set<string>(), execCache, false, undefined, false, tolerated, from);
  if (tolerated.length === 0) return { value: resolved };
  return { value, unresolved: describeFallback(tolerated[0]) };
}

function describeFallback({ err, via }: Tolerated): UnresolvedOnRead {
  const through = via === undefined ? {} : { via };
  if (err instanceof StoreUnreadableError) {
    // The unreadable file is reported in full, with its fix, by the command
    // itself (a warning on every surface). This only says why the value came
    // back as written, and names the entry so the two can be matched up.
    const entry = err.files.find(f => f.key !== undefined)?.key;
    return { ...through, why: entry === undefined
      ? 'refers to an entry whose store file cannot be read'
      : `refers to entry '${entry}', whose store file cannot be read` };
  }
  switch (err.reason) {
    case 'missing': return { ...through, ref: err.ref, why: 'is not a stored key' };
    case 'not-a-value': return { ...through, ref: err.ref, why: 'is a group of entries, not a value' };
    case 'encrypted': return { ...through, ref: err.ref, why: 'is encrypted' };
    // err.ref is the reference the limit was reached on, ten levels down:
    // naming it would point at an entry that is fine.
    case 'too-deep': return { ...through, why: 'nests references too deeply to resolve' };
  }
}

/**
 * The warning for an entry whose value was returned as written. For a
 * reference written in that entry it says what to do in both cases: fix the
 * reference, or escape text that only looks like one.
 */
export function unresolvedWarning(key: string, u: UnresolvedOnRead): string {
  const tail = 'Its value is returned as written.';
  if (u.ref === undefined) {
    return u.via === undefined
      ? `'${key}' ${u.why}. ${tail}`
      : `'${key}' refers to \${${u.via}}, which ${u.why}. ${tail}`;
  }
  if (u.via !== undefined) {
    return `'${key}' refers to \${${u.via}}, which leads to \${${u.ref}}, and that ${u.why}. ${tail}`;
  }
  return `'${key}' refers to \${${u.ref}}, which ${u.why}. ${tail} `
    + `If that is literal text, store it escaped: \\\${${u.ref}}.`;
}

/** What follows the warnings a listing prints, when more entries than it names hold an unresolved reference. */
export function unresolvedOverflowNote(rest: number): string {
  return `${rest} more ${rest === 1 ? 'entry holds' : 'entries hold'} a reference that does not resolve`;
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
function resolveRef(ref: string, maxDepth: number, seen: Set<string>, execCache: Map<string, string>, allowExec: boolean, trace?: ReferenceTrace, noExec = false, tolerated?: Tolerated[], from: EntryStore = 'project'): string {
  const { key: rawKey, modifier, modValue } = parseRef(ref);
  const name = rawKey.trim();
  // #280: aliases and values as the store of the entry holding this ref sees them.
  const resolvedKey = resolveIn(name, from);
  // #158: record every key reached through interpolation so the run-path
  // confirm gate can consult keys pulled in transitively, not just the
  // top-level segments. Recorded before the existence check so a `${gated}`
  // ref counts even via a `:-`/`:?` path. #279: the name as written too, not
  // only the key its alias names.
  if (trace) for (const k of gateNamesFor(name, resolvedKey, from !== 'global')) trace.keys.add(k);

  const { value: resolved, store } = readIn(resolvedKey, from);
  const id = entryId(store, resolvedKey);
  trace?.reads.set(id, resolved ?? null);

  if (seen.has(id)) {
    const chain = [...[...seen].map(keyOfId), resolvedKey].join(' → ');
    // Strict: a cycle is a structural bug, not a "missing data" condition.
    // Subtree fallbacks would mask real misconfigurations.
    throw new StrictInterpolationError(`Circular interpolation detected: ${chain}`);
  }

  if (resolved === undefined) {
    if (modifier === ':-') {
      // Default value — interpolate it in case it contains ${} references.
      // It is text of the entry holding the ref: it resolves where that does.
      return interpolate(modValue ?? '', maxDepth, seen, execCache, allowExec, trace, noExec, tolerated, from);
    }
    if (modifier === ':?') {
      // Strict: the user opted in to fail-loud by writing `:?`. If we
      // returned the raw template here, the loudness would be silent.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string should also use generic message
      throw new StrictInterpolationError(modValue || `"${name}" is required but not set`);
    }
    throw new UnresolvedReferenceError(`Interpolation failed: "${name}" not found`, ref, 'missing');
  }

  if (typeof resolved !== 'string') {
    throw new UnresolvedReferenceError(`Interpolation failed: "${name}" is not a string value`, ref, 'not-a-value');
  }

  if (isEncrypted(resolved)) {
    throw new UnresolvedReferenceError(`Interpolation failed: "${name}" is encrypted`, ref, 'encrypted');
  }

  if (maxDepth <= 0) {
    throw new UnresolvedReferenceError(`Interpolation depth limit exceeded`, ref, 'too-deep');
  }

  const nextSeen = new Set(seen);
  nextSeen.add(id);
  // #158 (audit round 2): thread noExec so a `${value}` → `$(exec)` chain
  // stays in collect mode. Dropping it here left the nested exec ref literal
  // during enumeration while the real run (allowExec) still executed it — the
  // exact enumeration≠execution divergence the confirm gate must not have.
  // #280: the referenced value's own refs resolve in ITS store — a project
  // entry's ref that lands on a global entry reads global from there on.
  return interpolate(resolved, maxDepth - 1, nextSeen, execCache, allowExec, trace, noExec, tolerated, store);
}

/**
 * Characters the shell treats as syntax (#242, owner rule 2026-11-25). Exec
 * output holding any of them is refused rather than pasted into a command.
 */
const SHELL_SYNTAX = /[`$;&|<>()'"\\#\n]/;

/**
 * Resolve a `$(key)` exec reference: look up stored command, interpolate it,
 * execute via shell, and return trimmed stdout. Results are cached per pass.
 *
 * Only ever called when `allowExec` is true (the explicit `run`-execution
 * path). Read/display/dry/preview passes leave `$(key)` literal instead — see
 * the SECURITY note on `interpolate()`.
 */
function resolveExecRef(ref: string, maxDepth: number, seen: Set<string>, execCache: Map<string, string>, trace?: ReferenceTrace, noExec = false, from: EntryStore = 'project'): string {
  const name = ref.trim();
  // #280: the command a global entry's `$(key)` runs is the global store's.
  const resolvedKey = resolveIn(name, from);
  // #158: an exec ref pulls in a key transitively too — record it for the
  // confirm gate. #279: under the name as written as well.
  if (trace) for (const k of gateNamesFor(name, resolvedKey, from !== 'global')) trace.keys.add(k);

  const { value: resolved, store } = readIn(resolvedKey, from);
  const id = entryId(store, resolvedKey);
  trace?.reads.set(id, resolved ?? null);

  if (seen.has(id)) {
    const chain = [...[...seen].map(keyOfId), resolvedKey].join(' → ');
    throw new StrictInterpolationError(`Circular interpolation detected: ${chain}`);
  }

  // Return cached result if this entry already ran in this pass. Keyed by
  // entry (#280): the project's `x` and the global `x` are two commands.
  if (execCache.has(id)) {
    return execCache.get(id)!;
  }

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
  nextSeen.add(id);
  const command = interpolate(resolved, maxDepth - 1, nextSeen, execCache, !noExec, trace, noExec, undefined, store);

  // Collect mode (#158): recurse to enumerate nested keys but never execute.
  if (noExec) return '';

  // Execute
  const shell = process.env.SHELL ?? '/bin/sh';
  let stdout: string;
  try {
    stdout = execSync(command, { encoding: 'utf-8', shell, timeout: 10000 });
  } catch (err: unknown) {
    const code = (err && typeof err === 'object' && 'status' in err) ? Number((err as { status: number }).status) : 1;
    // No `cause` on purpose: the ExecSyncError carries the child's stdout/stderr
    // buffers, and this message is deliberately terse (exit code only). Attaching
    // the original error would let any handler that inspects the cause chain
    // surface command output the message intentionally withholds.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Exec interpolation failed: "${ref}" exited with code ${code}`);
  }
  // Trailing newlines go, as the shell's own $(...) drops them.
  const result = stdout.replace(/\n+$/, '');
  // #242: the output is pasted into a command that the shell then evaluates,
  // so output holding shell syntax would run as code — whoever controls what
  // the command prints (a file it reads, git metadata, the network) would
  // choose what runs. Refuse it; nothing has executed past this command yet.
  // Plain output (words, paths, versions) passes and still splits into
  // arguments. The output itself stays out of the message, as above.
  const syntax = SHELL_SYNTAX.exec(result);
  if (syntax) {
    const shown = syntax[0] === '\n' ? 'a newline' : `'${syntax[0]}'`;
    throw new Error(`Exec interpolation refused: "${ref}" printed shell syntax (${shown}); pasted into the command, its output would run as code`);
  }
  execCache.set(id, result);
  return result;
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
 * References are resolved at read time via the data store and alias map,
 * in the store of the entry `value` belongs to (`from`, #280). Supports
 * recursive resolution with circular reference detection.
 */
export function interpolate(
  value: string,
  maxDepth: number = MAX_DEPTH,
  seen = new Set<string>(),
  execCache = new Map<string, string>(),
  allowExec = false,
  trace?: ReferenceTrace,
  noExec = false,
  tolerated?: Tolerated[],
  from: EntryStore = 'project',
): string {
  // Early return if no interpolation markers present
  if (!value.includes('${') && !value.includes('$(')) return value;

  // Phase 1: resolve ${key} references (brace-aware to support nested ${} in defaults)
  // Backslash escape: \${...} emits literal ${...}, \$(...) emits literal $(...)
  let result = value;
  // #242: where phase 1 put a referenced value into `result`. That text is
  // already fully interpolated — its own exec refs ran, its escapes were
  // consumed — so phase 2 must not scan it again: re-scanning ran a command's
  // output, and an escaped \$(key), as exec references.
  const substituted: [number, number][] = [];
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
          if (ref === '') {
            out += '${}';
          } else if (tolerated === undefined) {
            const start = out.length;
            out += resolveRef(ref, maxDepth, seen, execCache, allowExec, trace, noExec, undefined, from);
            substituted.push([start, out.length]);
          } else {
            // A read (interpolateForRead): a reference that does not resolve
            // is kept as written and the scan goes on, so that a `:?` or a
            // cycle after it — here or further down the chain — still throws.
            const before = tolerated.length;
            try {
              const start = out.length;
              out += resolveRef(ref, maxDepth, seen, execCache, allowExec, trace, noExec, tolerated, from);
              substituted.push([start, out.length]);
            } catch (err) {
              if (!fallsBackOnRead(err)) throw err;
              tolerated.push({ err, nested: seen.size > 0 });
              out += result.slice(i, j + 1);
            }
            // `seen` is empty only while scanning the value being read (and
            // its `:-` defaults). Whatever failed further down was reached
            // through this reference.
            if (seen.size === 0) {
              for (const t of tolerated.slice(before)) {
                if (t.nested) t.via ??= ref;
              }
            }
          }
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
    let span = 0;
    while (i < result.length) {
      // #242: text a ${key} put here is copied as it is, never scanned again.
      while (span < substituted.length && substituted[span][1] <= i) span++;
      if (span < substituted.length && substituted[span][0] <= i) {
        out += result.slice(i, substituted[span][1]);
        i = substituted[span][1];
        continue;
      }
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
            // #242: a key that a ${key} supplied — `$(${name})` — may come from
            // a command's output, which the gate's collect pass cannot know
            // without running it. Refuse it on the paths that run commands.
            // An empty span counts: in collect mode a nested exec yields ''.
            if (substituted.some(([s, e]) => s <= close && e >= i + 2)) {
              throw new Error(`Exec interpolation refused: "${result.slice(i, close + 1)}" takes its key from a \${…} reference; write the key itself`);
            }
            // noExec (#158): enter the ref to enumerate keys for the confirm
            // gate, but resolveExecRef skips execSync in that mode.
            const ref = result.slice(i + 2, close);
            out += resolveExecRef(ref, maxDepth, seen, execCache, trace, noExec, from);
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
 * The safe (non-exec) pass over a value stored in `from`: what `run` shows
 * for it — the `--dry` text, the confirm prompt, the JSON preview. `$(key)`
 * stays literal.
 */
export function interpolateFrom(value: string, from: EntryStore): string {
  return interpolate(value, MAX_DEPTH, new Set<string>(), new Map<string, string>(), false, undefined, false, undefined, from);
}

/**
 * Exec-enabled interpolation: resolve `${key}` value refs AND execute `$(key)`
 * exec refs. This is the ONLY entry point that runs stored commands — reserve
 * it for the explicit `run`-execution moment, past the confirm gate and with
 * `dry` false. Everything else must use `interpolate()` (safe default).
 *
 * `from` is the store the value was read from (#280). Pass one `execCache`
 * to several calls to run an entry's command once across them (the
 * segments of one `run`).
 */
export function interpolateExec(value: string, from: EntryStore = 'project', execCache = new Map<string, string>()): string {
  return interpolate(value, MAX_DEPTH, new Set<string>(), execCache, true, undefined, false, undefined, from);
}

/**
 * Everything a value would touch when run — both `${key}` value refs and
 * `$(key)` exec refs, transitively — WITHOUT executing anything (#158). Uses
 * the same scanner as interpolate(), with the same `from` (#280), so what it
 * finds can never diverge from what execution actually reaches; that
 * shared-scanner property is the whole point — a bespoke parser would be one
 * crafted ref away from missing a gated key.
 */
export function collectReferences(value: string, from: EntryStore = 'project'): ReferenceTrace {
  const trace: ReferenceTrace = { keys: new Set<string>(), reads: new Map() };
  try {
    interpolate(value, MAX_DEPTH, new Set<string>(), new Map<string, string>(), false, trace, true, undefined, from);
  } catch {
    // Collection is best-effort for gating: a cycle or depth-limit throw still
    // leaves the trace populated with everything reached so far, and the gate
    // errs toward MORE keys, never fewer.
  }
  return trace;
}

/**
 * The names a value would look up when run (collectReferences): what the
 * run-path confirm gate unions with the top-level keys, so a confirm-gated
 * command pulled in via interpolation still forces the prompt / refusal.
 * Each reference counts under the name as written and the key its alias
 * names (#279).
 */
export function collectReferencedKeys(value: string, from: EntryStore = 'project'): Set<string> {
  return collectReferences(value, from).keys;
}

/**
 * Interpolate all leaf string values in a nested object (subtree).
 * Returns a new object with interpolated values.
 * Shares a single execCache across all leaves so exec results are cached.
 *
 * SECURITY: safe by default — leaves `$(key)` literal (no execution). Used by
 * read/display paths (`get --values`, MCP subtree); they must never execute.
 * `from`: the store the subtree was read from (#280).
 */
export function interpolateObject(
  obj: Record<string, CodexValue>,
  onUnresolved?: (key: string, unresolved: UnresolvedOnRead) => void,
  from: EntryStore = 'project',
): Record<string, CodexValue> {
  const flat = flattenObject(obj);
  const result: Record<string, CodexValue> = {};
  const execCache = new Map<string, string>();

  for (const [key, value] of Object.entries(flat)) {
    if (typeof value === 'string' && !isEncrypted(value)) {
      // The read rule, one leaf at a time (interpolateForRead): a reference
      // that does not resolve keeps the raw template, so a single broken
      // leaf doesn't fail the whole subtree get — and the caller is told, so
      // it can warn (#202). A `:?`, a cycle or a fault propagates.
      const read = interpolateForRead(value, from, execCache);
      result[key] = read.value;
      if (read.unresolved) onUnresolved?.(key, read.unresolved);
    } else {
      result[key] = value;
    }
  }

  return result;
}
