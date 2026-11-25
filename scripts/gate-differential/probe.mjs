// Gate probe for one build, run with cwd = where `rvr run` would be run.
// Reproduces runCommand's gate expression (entries.ts, unchanged between the builds)
// with THIS build's own modules: resolved key + referenced keys, hasConfirm, unreadable list.
// usage: bun scripts/gate-differential/probe.mjs <distDir> '<json array of keys>'   (run by the harness scripts)
const [distDir, keysJson] = process.argv.slice(2);
const { getValue } = await import(distDir + '/storage.js');
const { resolveKey } = await import(distDir + '/alias.js');
const { hasConfirm } = await import(distDir + '/confirm.js');
const { collectReferencedKeys } = await import(distDir + '/utils/interpolate.js');
const { confirmListUnreadable } = await import(distDir + '/utils/unreadable.js');
const out = {};
for (const scope of [undefined, 'global']) {
  for (const key of JSON.parse(keysJson)) {
    const id = `${scope ?? 'auto'}|${key}`;
    try {
      const rk = resolveKey(key, scope);
      const v = getValue(rk, scope);
      if (typeof v !== 'string') { out[id] = v === undefined ? 'missing' : 'namespace'; continue; }
      const keys = new Set([rk, ...collectReferencedKeys(v)]);
      const gated = [...keys].some(k => hasConfirm(k)) || confirmListUnreadable();
      out[id] = gated ? 'GATED' : 'runs';
    } catch (e) {
      out[id] = 'throws';
    }
  }
}
console.log(JSON.stringify(out));
