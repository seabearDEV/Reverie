// Does stat (dev+ino, bigint) say that another spelling of a stored name is the same file?
// usage: bun scripts/gate-differential/fs-identity-probe.mjs <directory on the filesystem to test>
import fs from 'fs'; import path from 'path';
const cp = (...points) => String.fromCodePoint(...points);   // non-ASCII letters are built from code points: two forms of one letter look alike in an editor
const base = process.argv[2];
const dir = fs.mkdtempSync(path.join(base, 'ino-'));
const id = (p) => { try { const s = fs.statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; } catch (e) { return 'ENOENT'; } };
const same = (a, b) => { const x = id(path.join(dir, a)), y = id(path.join(dir, b)); return x !== 'ENOENT' && x === y; };
const put = (name, v = '{}') => fs.writeFileSync(path.join(dir, name), v);
const rows = [];
put('commands.deploy.json'); put('commands.fix.json'); put('jobs.pass.json'); put(`caf${cp(0xe9)}.go.json`); put('other.key.json');
const asks = [
  ['commands.deploy.json', 'commands.deploy.json', 'exact', true],
  ['commands.DEPLOY.json', 'commands.deploy.json', 'case', null],
  [`command${cp(0x17f)}.deploy.json`, 'commands.deploy.json', 'long s', null],
  [`commands.${cp(0xfb01)}x.json`, 'commands.fix.json', 'fi ligature', null],
  [`jobs.pa${cp(0xdf)}.json`, 'jobs.pass.json', 'sharp s', null],
  [`cafe${cp(0x301)}.go.json`, `caf${cp(0xe9)}.go.json`, 'NFD of NFC', null],
  ['other.key.json', 'commands.deploy.json', 'different entry', false],
  ['nosuch.json', 'commands.deploy.json', 'missing', false],
];
for (const [asked, stored, label, expect] of asks) {
  let opens = true; try { fs.readFileSync(path.join(dir, asked)); } catch { opens = false; }
  const s = same(asked, stored);
  // The property the gate needs: whenever the asked path opens the stored entry's file, stat says "same file".
  const ok = expect === null ? (opens === s) : (s === expect);
  rows.push(`${label.padEnd(16)} opens=${String(opens).padEnd(5)} sameFile=${String(s).padEnd(5)} ${ok ? 'ok' : 'MISMATCH'}`);
}
// After an atomic rename-over under another spelling (the second review's finding 2).
const tmp = path.join(dir, '.tmp-x');
fs.writeFileSync(tmp, '{"v":2}');
fs.renameSync(tmp, path.join(dir, `command${cp(0x17f)}.deploy.json`));
const listing = fs.readdirSync(dir).filter(n => n.toLowerCase().includes('deploy'));
rows.push(`after rename-over: listing=${JSON.stringify(listing)}`);
for (const [asked, label] of [['commands.deploy.json', 'stored name'], [`command${cp(0x17f)}.deploy.json`, 'fold name'], ['commands.DEPLOY.json', 'case name']]) {
  let opens = true; try { fs.readFileSync(path.join(dir, asked)); } catch { opens = false; }
  rows.push(`  ${label.padEnd(12)} opens=${opens} sameFileAs(stored)=${same(asked, 'commands.deploy.json')} sameFileAs(fold)=${same(asked, `command${cp(0x17f)}.deploy.json`)} realpath=${(() => { try { return path.basename(fs.realpathSync.native(path.join(dir, asked))); } catch { return '-'; } })()}`);
}
// A rewrite of an entry (atomic write = new inode): do both spellings still agree afterwards?
fs.writeFileSync(tmp, '{"v":3}'); fs.renameSync(tmp, path.join(dir, 'commands.deploy.json'));
rows.push(`after exact rewrite: sameFile(case)=${same('commands.DEPLOY.json', 'commands.deploy.json')} sameFile(fold)=${same(`command${cp(0x17f)}.deploy.json`, 'commands.deploy.json')} opensFold=${(() => { try { fs.readFileSync(path.join(dir, `command${cp(0x17f)}.deploy.json`)); return true; } catch { return false; } })()}`);
console.log(rows.join('\n'));
fs.rmSync(dir, { recursive: true, force: true });
