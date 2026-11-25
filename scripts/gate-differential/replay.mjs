// Replays each hit trial on the branch build and, at every `confirm set` the branch refused,
// asks whether the key named an entry at that moment (a read from the same directory finds a string).
// usage: bun scripts/gate-differential/replay.mjs <newDist> <harness output file> <workDir>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const [headDist, outFile, workDir] = process.argv.slice(2);
const text = fs.readFileSync(outFile, 'utf8');
const blocks = text.split('### trial ').slice(1).filter(b => b.includes('main gates, head does not'));
const cli = (root, where, args) => {
  const env = { ...process.env, RVR_DATA_DIR: path.join(root, 'data'), RVR_AGENT_NAME: 'fuzz' };
  for (const k of ['RVR_SESSION', 'RVR_NO_PROJECT', 'RVR_PROJECT', 'RVR_OUTPUT']) delete env[k];
  return spawnSync('bun', [path.join(headDist, 'index.js'), ...args], { cwd: path.join(root, where), env, input: '', encoding: 'utf8' });
};
let refusals = 0, namedAnEntry = 0;
for (const b of blocks) {
  const trial = b.split(' ')[0];
  const root = path.join(workDir, 't' + trial);
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of ['p1', 'p2', 'outside', 'data']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const p of ['p1', 'p2']) cli(root, p, ['init', '--no-scan', '--no-claude', '--no-agents']);
  for (const line of b.split('\n').filter(l => l.startsWith('['))) {
    const m = line.match(/^\[(\w+)\] rvr (.*?)\s+\(exit main=(\d) head=(\d)\)$/);
    const where = m[1];
    const args = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(x => x[1] !== undefined ? JSON.parse('"' + x[1] + '"') : x[2]);
    if (args[0] === 'confirm' && args[1] === 'set' && m[3] === '0' && m[4] !== '0') {
      refusals++;
      const key = args[2];
      const got = cli(root, where, ['--json', 'get', key]);
      let named = false;
      try { const env = JSON.parse(got.stdout); named = env.ok === true && typeof env.result?.[key] === 'string'; } catch { /* not found */ }
      const r = cli(root, where, args);
      if (named) { namedAnEntry++; console.log(`trial ${trial}: REFUSED THOUGH IT NAMED AN ENTRY: [${where}] ${args.join(' ')}  -> ${r.stderr.trim().slice(0, 120)}`); }
      continue;
    }
    cli(root, where, args);
  }
}
console.log(`hit trials: ${blocks.length}; confirm set refusals replayed: ${refusals}; refused though the key named an entry: ${namedAnEntry}`);
