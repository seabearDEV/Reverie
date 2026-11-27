#!/usr/bin/env bun
// Compare two gatediff.mjs outputs, line by line: a run that asks on the
// first build and runs on the second is a WEAKENING.
//
//   bun scripts/project-differential/compare.mjs <main.jsonl> <head.jsonl>
//
// Exits 1 when any line differs (outcome or markers), 2 when the two do not
// line up.
import fs from 'node:fs';

export function compareRuns(aText, bText) {
  const read = t => t.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  const [a, b] = [read(aText), read(bText)];
  const lines = [];
  let weak = 0, diff = 0, misaligned = a.length !== b.length;
  if (misaligned) lines.push(`LENGTH DIFF main=${a.length} head=${b.length}`);
  const counts = { main: {}, head: {} };
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const m = a[i], h = b[i];
    if (m) counts.main[m.outcome] = (counts.main[m.outcome] ?? 0) + 1;
    if (h) counts.head[h.outcome] = (counts.head[h.outcome] ?? 0) + 1;
    if (!m || !h) continue;
    if (m.inv !== h.inv || m.phase !== h.phase) { misaligned = true; lines.push(`MISALIGNED ${i}: ${m.inv} vs ${h.inv}`); continue; }
    if (m.outcome === h.outcome && m.markers === h.markers) continue;
    diff++;
    const tag = (m.outcome === 'ASK' && h.outcome.startsWith('RAN')) ? 'WEAKENING' : (m.outcome.startsWith('RAN') && h.outcome === 'ASK') ? 'stricter' : 'diff';
    if (tag === 'WEAKENING') weak++;
    lines.push(`${tag} [${m.phase}] ${m.who} ${m.inv}\n   main=${m.outcome} ${m.markers}${m.msg ? ' ' + m.msg : ''}\n   head=${h.outcome} ${h.markers}${h.msg ? ' ' + h.msg : ''}`);
  }
  lines.push(`SUMMARY diffs=${diff} weakenings=${weak} main=${JSON.stringify(counts.main)} head=${JSON.stringify(counts.head)}`);
  return { lines, diff, weak, misaligned, total: Math.max(a.length, b.length) };
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length !== 2) { console.error('usage: compare.mjs <main.jsonl> <head.jsonl>'); process.exit(2); }
  const r = compareRuns(fs.readFileSync(files[0], 'utf8'), fs.readFileSync(files[1], 'utf8'));
  for (const l of r.lines) console.log(l);
  process.exit(r.misaligned ? 2 : r.diff > 0 ? 1 : 0);
}
