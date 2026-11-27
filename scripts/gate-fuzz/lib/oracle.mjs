// The verdict on one invocation, from what ran (markers in the log) and the
// model in model.mjs. Nothing here asks the build under test what it thinks.
//
// For an invocation the user did not approve (CLI without --yes, stdin
// closed; MCP without force and without a valid confirm_token) that ran
// anything at all:
//   R1 flagged-entry   an entry whose own key is flagged ran
//   R2 typed-name      a name the invocation looks up at the top is flagged:
//                      the key or each `a:b` segment, a chain entry and each
//                      member; as typed, its alias target, and the global
//                      alias target when project aliases were in play
//   R3 executed-ref    a name written in an entry that ran is flagged (that
//                      entry's whole value was interpolated before it ran,
//                      so every reference in it was looked up)
//   R3r reach-ref      a name anywhere in the run's reach is flagged
//   R5 stopped-walk    the run ended in a reference-walk error (depth limit,
//                      cycle, `${…}` not found, `:?`, a refused `$(${…})`),
//                      or the model finds such an error in reach: the gate
//                      cannot have checked everything, so it must ask first
//   R6 unreadable-list a confirmation list the run reads is unreadable
// For any invocation, approved or not:
//   R4 confinement     a project entry ran under -G or MCP scope "global"
//   R4r reach          an entry ran that the run cannot reach under the
//                      store rules (e.g. a project entry through a global
//                      entry's reference)
//   R7 exec-on-read    a --dry, `get`, MCP dry or reverie_get ran anything
//   R8 store           the stores changed, an odd epoch or a lock was left
// For the writes that follow the runs:
//   R8 store           a refused or failed write changed the stores; an odd
//                      epoch or a lock was left
//   R9 flag-kept       a flag disappeared from a list, by any command other
//                      than `confirm remove` or `--no-confirm` (a rename,
//                      removal or copy never takes a flag away)
import { confirmUnreadable, flagged, markerFile, reach, readWorld, refNames, storedValue, topLevel } from './model.mjs';

const WALK_ERROR = /Interpolation depth limit exceeded|Circular interpolation detected|Interpolation failed: "[^"]*" (not found|is not a string value|is encrypted)|is required but not set|RVQREQ|takes its key from a/;

export function modelInvocation(inv) {
  if (inv.surface === 'cli') return { surface: 'cli', global: inv.global, chain: inv.chain, keys: inv.keys };
  return { surface: 'mcp', scope: inv.args.scope, chain: Boolean(inv.args.chain), key: inv.args.key };
}

export function isRead(inv) {
  if (inv.kind === 'write') return false;
  return inv.surface === 'cli' ? inv.kind !== 'run' : (inv.tool !== 'reverie_run' || Boolean(inv.args.dry));
}

/** A write's verdict, from the stores just before and after it. */
export function judgeWrite(inv, res, before, after, flagsBefore, flagsAfter, left) {
  const v = left.map(p => ({ rule: 'R8-store', detail: p }));
  const failed = res.kind === 'error' || res.kind === 'ask';
  if (failed && before !== after) v.push({ rule: 'R8-store', detail: `a ${res.kind === 'ask' ? 'refused' : 'failed'} write (${res.code}: ${(res.message ?? '').slice(0, 120)}) changed the stores:\n${diffLines(before, after)}` });
  const clears = inv.surface === 'cli' && ((inv.argv[0] === 'confirm' && inv.argv[1] === 'remove') || inv.argv.includes('--no-confirm'));
  if (!clears) {
    for (const s of ['project', 'global']) {
      if (!flagsBefore[s]) continue;
      const lost = flagsBefore[s].filter(k => !(flagsAfter[s] ?? []).includes(k));
      if (lost.length) v.push({ rule: 'R9-flag-kept', detail: `${s} list lost ${lost.join(', ')}` });
    }
  }
  return v;
}

/**
 * Violations for one invocation. `res` is the driver's result; `store`
 * holds the store-invariant problems seen after it.
 */
export function judge(root, spec, inv, res, store = []) {
  const v = [];
  const add = (rule, detail) => v.push({ rule, detail });
  for (const p of store) add('R8-store', p);
  const w = readWorld(root, inv.cwd);
  const executed = res.markers.map(n => {
    const [s, key] = spec.markers[n] ?? ['?', `#${n}`];
    return { n, store: s, key };
  });
  if (isRead(inv)) {
    if (executed.length) add('R7-exec-on-read', `ran ${fmt(executed)}`);
    return v;
  }
  const approved = inv.surface === 'cli' ? inv.yes : res.approved;
  const top = topLevel(w, modelInvocation(inv));
  const r = top.ok ? reach(w, top.roots) : { names: new Set(), errors: [], entries: new Map() };

  const globalOnly = inv.surface === 'cli' ? inv.global : inv.args.scope === 'global';
  if (globalOnly) {
    const project = executed.filter(e => e.store === 'project');
    if (project.length) add('R4-confinement', `global-scope run ran project ${fmt(project)}`);
  }
  const reachable = new Set([...r.entries.values()].map(e => e.file).filter(Boolean));
  const outside = executed.filter(e => !reachable.has(markerFile(w, e.store, e.key)));
  if (outside.length) add('R4r-reach', `ran ${fmt(outside)}, which this run cannot reach${top.ok ? '' : ` (${top.why})`}`);

  if (approved || executed.length === 0) return v;

  if (confirmUnreadable(w)) add('R6-unreadable-list', `a confirmation list is unreadable, and ${fmt(executed)} ran unasked`);
  const typed = [...new Set(top.names)].filter(n => flagged(w, n));
  if (typed.length) add('R2-typed-name', `flagged name looked up at the top: ${typed.join(', ')}; ran ${fmt(executed)}`);
  const own = executed.filter(e => flagged(w, e.key));
  if (own.length) add('R1-flagged-entry', `flagged entry ran: ${fmt(own)}`);
  const refs = new Set();
  for (const e of executed) for (const n of refNames(w, storedValue(w, e.store, e.key), e.store)) if (flagged(w, n)) refs.add(`${n} (in ${e.store}:${e.key})`);
  if (refs.size) add('R3-executed-ref', `flagged reference in an entry that ran: ${[...refs].join(', ')}`);
  const reachFlagged = [...r.names].filter(n => flagged(w, n));
  if (reachFlagged.length) add('R3r-reach-ref', `flagged name in the run's reach: ${reachFlagged.join(', ')}; ran ${fmt(executed)}`);
  if (r.errors.length) add('R5-stopped-walk', `the reference walk cannot complete (${[...new Set(r.errors)].join('; ')}), and ${fmt(executed)} ran unasked`);
  else if (res.code !== 'OK' && WALK_ERROR.test(res.message ?? '')) add('R5-stopped-walk', `ended in a walk error (${(res.message.match(WALK_ERROR) ?? [''])[0]}) after ${fmt(executed)} ran unasked`);
  return v;
}

function fmt(entries) {
  return entries.map(e => `${e.store}:${e.key}`).join(', ');
}

export function diffLines(a, b) {
  const A = new Set(a.split('\n')), B = new Set(b.split('\n'));
  return [...[...A].filter(l => !B.has(l)).map(l => `    - ${l}`), ...[...B].filter(l => !A.has(l)).map(l => `    + ${l}`)].join('\n');
}
