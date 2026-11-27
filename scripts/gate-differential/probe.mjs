// Gate probe for one build, run with cwd = where `rvr run` would be run.
// Reproduces runCommand's gate expression for one key (entries.ts) with THIS build's own modules.
// The expression changed in #279/#280, so the probe asks the build which one it has:
//   - a build with getValueWithStore and gateNamesFor (#279/#280): the key as typed, its alias target
//     and its global alias target (gateNamesFor), plus the keys collectReferencedKeys reaches with the
//     value's own store (a global entry's references read the global store only);
//   - an older build: the resolved key plus collectReferencedKeys(value), unscoped.
// Either way: hasConfirm on each, or an unreadable confirmation list. A build with
// collectRunReferences (#289) also gates a reference walk that stopped past a command (walkUnchecked).
// usage: bun scripts/gate-differential/probe.mjs <distDir> '<json array of keys>'   (run by the harness scripts)
// With PROBE_TRACE=1 each result also lists the keys the gate checked (for classifying a hit).
const [distDir, keysJson] = process.argv.slice(2);
const storage = await import(distDir + '/storage.js');
const { resolveKey } = await import(distDir + '/alias.js');
const { hasConfirm } = await import(distDir + '/confirm.js');
const interp = await import(distDir + '/utils/interpolate.js');
const { confirmListUnreadable } = await import(distDir + '/utils/unreadable.js');
const scoped = typeof storage.getValueWithStore === 'function' && typeof interp.gateNamesFor === 'function';
const trace = process.env.PROBE_TRACE === '1';
const out = {};
for (const scope of [undefined, 'global']) {
  for (const key of JSON.parse(keysJson)) {
    const id = `${scope ?? 'auto'}|${key}`;
    try {
      const rk = resolveKey(key, scope);
      let v, keys, unchecked = false;
      if (scoped) {
        const found = storage.getValueWithStore(rk, scope);
        v = found?.value;
        if (typeof v === 'string' && typeof interp.collectRunReferences === 'function') {
          const walk = interp.collectRunReferences([{ value: v, from: found.store }], true);
          keys = new Set([...interp.gateNamesFor(key, rk, scope !== 'global'), ...walk.keys]);
          unchecked = interp.walkUnchecked(walk);
        } else if (typeof v === 'string') {
          keys = new Set([...interp.gateNamesFor(key, rk, scope !== 'global'), ...interp.collectReferencedKeys(v, found.store)]);
        }
      } else {
        v = storage.getValue(rk, scope);
        if (typeof v === 'string') keys = new Set([rk, ...interp.collectReferencedKeys(v)]);
      }
      if (typeof v !== 'string') { out[id] = v === undefined ? 'missing' : 'namespace'; continue; }
      const gated = [...keys].some(k => hasConfirm(k)) || unchecked || confirmListUnreadable();
      out[id] = (gated ? 'GATED' : 'runs') + (trace ? ` ${JSON.stringify([...keys])}` : '');
    } catch (e) {
      out[id] = 'throws';
    }
  }
}
console.log(JSON.stringify(out));
