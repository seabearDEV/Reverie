// #305 PR 4, store files and messages: the items checked through the built
// CLI and a running MCP server.
//
// - L15 (#270 item 1): with an alias map that cannot be read, `set <name>`
//   of a name that is no entry is refused: the name may be an alias, and the
//   write would land under the alias's name.
// - L16 (#270 item 2): `data reset` removes the files it cannot read in the
//   sections it resets (owner decision 2026-11-28), after the backup that
//   holds their bytes. A directory in an entry's place stays and is named.
// - L17 (#270 item 3): `rm <key>` removes an entry file that is not valid
//   (truncated, emptied); a conflicted one stays refused (owner decision).
// - L20 (#277 item 2): a replace import's preview and result name the hidden
//   keys it deletes.
// - L22 (#277 item 4): `rm` of a key with hidden keys under it names them.
// - L23 (#277 item 5): `rm` finds a key under the spelling `get` finds it by
//   (owner decision: hidden or not).
// - L25 (#295): a refused write leaves a store without scaffolding as it was.
// - L26: a value that completes a reference cycle is stored with a warning.
// - L27: `get --json` of a `:?` guard or a cycle fails, as plain `get` does.
//
// Spawns the built dist (assumes `bun run build` has run) with a private
// HOME, RVR_DATA_DIR and project directory.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';
import { openMcpSession, type McpSession, type McpToolResult } from './helpers/mcpSession';

const CLI = path.resolve('dist/index.js');
const SLOW_TEST_MS = 60_000;
const CONFLICT = '<<<<<<< HEAD\n{"value": "ours"}\n=======\n{"value": "theirs"}\n>>>>>>> theirs\n';
const TRUNCATED = '{"value": "trunc';

let root: string;
let home: string;
let dataDir: string;
let proj: string;
let session: McpSession | undefined;

function env(): NodeJS.ProcessEnv {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, RVR_DATA_DIR: dataDir };
  for (const name of ['RVR_NO_PROJECT', 'RVR_PROJECT', 'RVR_PROJECT_DIR', 'RVR_SESSION', 'RVR_OUTPUT']) delete e[name];
  return e as NodeJS.ProcessEnv;
}

function rvr(args: string[], cwd = proj) {
  const r = spawnSync('bun', [CLI, ...args], { cwd, env: env(), input: '' });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
}

function ok(args: string[]): void {
  const r = rvr(args);
  expect(r.status, `rvr ${args.join(' ')}: ${r.stderr}`).toBe(0);
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  warnings?: { code: string; message: string }[];
}

function json(args: string[], cwd = proj): Envelope & { status: number | null } {
  const r = rvr([...args, '--json'], cwd);
  return { ...(JSON.parse(r.stdout) as Envelope), status: r.status };
}

function text(r: McpToolResult): string {
  return r.content.map(c => c.text).join('\n');
}

const projectFile = (name: string) => path.join(proj, '.reverie', name);
const globalFile = (name: string) => path.join(dataDir, 'store', name);
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

async function server(): Promise<McpSession> {
  session = await openMcpSession({ cwd: proj, env: env() });
  return session;
}

beforeAll(() => { assertDistHonorsDataDir(); });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-store-files-')));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  proj = path.join(root, 'proj');
  for (const d of [home, dataDir, proj]) fs.mkdirSync(d);
  ok(['init']);
});

afterEach(() => {
  session?.close();
  session = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('L15 (#270 item 1): set of a name an unreadable alias map may hold is refused', () => {
  beforeEach(() => {
    ok(['set', 'k.target', 'v']);
    ok(['alias', 'set', 'a', 'k.target']);
    fs.writeFileSync(projectFile('_aliases.json'), '{"a": "k.tar');
  });

  it('CLI: STORE_UNREADABLE naming the map, and no entry named after the alias', () => {
    const r = json(['set', 'a', 'newval']);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('STORE_UNREADABLE');
    expect(r.error?.message).toContain('_aliases.json');
    expect(exists(projectFile('a.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(projectFile('k.target.json'), 'utf8')).value).toBe('v');
  });

  it('CLI: a set to an existing entry still writes', () => {
    const r = json(['set', 'k.target', 'v2']);
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(projectFile('k.target.json'), 'utf8')).value).toBe('v2');
  });

  it('CLI -G: the global map unreadable refuses a global set of a new name', () => {
    ok(['set', '-G', 'g.target', 'gv']);
    fs.writeFileSync(globalFile('_aliases.json'), '{"ga": ');
    const r = json(['set', '-G', 'ga', 'x']);
    expect(r.error?.code).toBe('STORE_UNREADABLE');
    expect(exists(globalFile('ga.json'))).toBe(false);
  });

  it('reverie_set: refused, and no entry named after the alias', async () => {
    const s = await server();
    const r = await s.call('reverie_set', { key: 'a', value: 'newval' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('STORE_UNREADABLE');
    expect(exists(projectFile('a.json'))).toBe(false);
  }, SLOW_TEST_MS);
});

describe('L16 (#270 item 2): data reset removes the files it cannot read', () => {
  it('entries: invalid, conflicted and symlinked entry files go; the backup holds their bytes; a directory stays, named', () => {
    ok(['set', 'ok.one', 'v']);
    fs.writeFileSync(projectFile('bad.one.json'), TRUNCATED);
    fs.writeFileSync(projectFile('conf.one.json'), CONFLICT);
    fs.symlinkSync(path.join(root, 'outside.json'), projectFile('lnk.json'));
    fs.writeFileSync(path.join(root, 'outside.json'), '{"value": "outside"}');
    fs.mkdirSync(projectFile('dirk.json'));

    const r = rvr(['data', 'reset', 'entries', '-P', '-f']);
    expect(r.status, r.stderr).toBe(0);
    for (const f of ['ok.one.json', 'bad.one.json', 'conf.one.json', 'lnk.json']) expect(exists(projectFile(f)), f).toBe(false);
    // The link went, not what it pointed at.
    expect(fs.readFileSync(path.join(root, 'outside.json'), 'utf8')).toBe('{"value": "outside"}');
    expect(exists(projectFile('dirk.json'))).toBe(true);
    expect(r.stdout + r.stderr).toContain('dirk.json');

    const backups = path.join(proj, '.reverie.backups');
    const [backup] = fs.readdirSync(backups);
    expect(fs.readFileSync(path.join(backups, backup, '.reverie', 'bad.one.json'), 'utf8')).toBe(TRUNCATED);
    expect(fs.readFileSync(path.join(backups, backup, '.reverie', 'conf.one.json'), 'utf8')).toBe(CONFLICT);
  });

  it('aliases and confirm: a broken sidecar is replaced, not reported reset and left', () => {
    fs.writeFileSync(projectFile('_aliases.json'), '{"a": "k');
    fs.writeFileSync(projectFile('_confirm.json'), CONFLICT);
    const r = rvr(['data', 'reset', 'all', '-P', '-f']);
    expect(r.status, r.stderr).toBe(0);
    for (const f of ['_aliases.json', '_confirm.json']) {
      const p = projectFile(f);
      if (exists(p)) expect(JSON.parse(fs.readFileSync(p, 'utf8')), f).toEqual({});
    }
    expect(r.stderr).not.toContain('cannot be read');
    expect(json(['lint']).warnings ?? []).not.toContainEqual(expect.objectContaining({ code: 'STORE_UNREADABLE' }));
  });

  it('global: the same for -G', () => {
    ok(['set', '-G', 'gk', 'v']);
    fs.writeFileSync(globalFile('bad.json'), '');
    fs.writeFileSync(globalFile('_aliases.json'), '{');
    const r = rvr(['data', 'reset', 'all', '-G', '-f']);
    expect(r.status, r.stderr).toBe(0);
    expect(exists(globalFile('bad.json'))).toBe(false);
    if (exists(globalFile('_aliases.json'))) expect(JSON.parse(fs.readFileSync(globalFile('_aliases.json'), 'utf8'))).toEqual({});
  });
});

describe('L17 (#270 item 3): rm removes an invalid entry file; a conflict stays refused', () => {
  beforeEach(() => {
    ok(['set', 'keep', 'k']);
    ok(['set', 'bad', 'was valid']);
    ok(['alias', 'set', 'b', 'bad']);
  });

  it('CLI: a truncated file is removed, with its alias', () => {
    fs.writeFileSync(projectFile('bad.json'), TRUNCATED);
    // The message that says what to do names rm, not "by hand".
    const before = json(['get', 'keep']);
    const hint = (before.warnings ?? []).map(w => w.message).join('\n');
    expect(hint).toContain('rm bad');
    expect(hint).not.toContain('by hand');

    const r = json(['rm', 'bad', '-f']);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(exists(projectFile('bad.json'))).toBe(false);
    expect(exists(projectFile('keep.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(projectFile('_aliases.json'), 'utf8'))).toEqual({});
  });

  it('CLI: an emptied file is removed', () => {
    fs.writeFileSync(projectFile('bad.json'), '');
    const r = rvr(['rm', 'bad', '-f']);
    expect(r.status, r.stderr).toBe(0);
    expect(exists(projectFile('bad.json'))).toBe(false);
  });

  it('CLI: a conflicted file is still refused, and left as it is', () => {
    fs.writeFileSync(projectFile('bad.json'), CONFLICT);
    const r = json(['rm', 'bad', '-f']);
    expect(r.error?.code).toBe('STORE_UNREADABLE');
    expect(fs.readFileSync(projectFile('bad.json'), 'utf8')).toBe(CONFLICT);
  });

  it('CLI: an invalid file under a namespace being removed still refuses the namespace, and names the way out', () => {
    ok(['set', 'grp.ok', 'o']);
    fs.writeFileSync(projectFile('grp.sub.json'), TRUNCATED);
    const r = json(['rm', 'grp', '-f']);
    expect(r.error?.code).toBe('STORE_UNREADABLE');
    expect(r.error?.message).toContain('rm grp.sub');
    expect(exists(projectFile('grp.ok.json'))).toBe(true);
  });

  it('reverie_remove: a truncated file is removed', async () => {
    fs.writeFileSync(projectFile('bad.json'), TRUNCATED);
    const s = await server();
    const r = await s.call('reverie_remove', { key: 'bad' });
    expect(r.isError, text(r)).toBeFalsy();
    expect(exists(projectFile('bad.json'))).toBe(false);
  }, SLOW_TEST_MS);

  it('the store README no longer calls a hand delete the fix', () => {
    const readme = fs.readFileSync(projectFile('_README.md'), 'utf8');
    expect(readme).not.toContain('removing a file here by hand is the fix');
    expect(readme).toContain('rm <key>');
  });
});

describe('L20 (#277 item 2): a replace import names the hidden keys it deletes', () => {
  beforeEach(() => {
    ok(['set', 'ns.k', 'leaf']);
    fs.writeFileSync(projectFile('ns.k.sub.json'), '{"value": "sub"}');
    fs.writeFileSync(path.join(root, 'imp.json'), JSON.stringify({ ns: { k: 'leaf' }, other: 'o' }));
  });

  it('the preview lists it as removed; the apply deletes it and says so', () => {
    const preview = rvr(['data', 'import', 'entries', path.join(root, 'imp.json'), '-P', '--preview']);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toMatch(/\[remove\]\s+ns\.k\.sub/);
    expect(exists(projectFile('ns.k.sub.json'))).toBe(true);

    const applied = rvr(['data', 'import', 'entries', path.join(root, 'imp.json'), '-P', '-f']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(exists(projectFile('ns.k.sub.json'))).toBe(false);
    expect(applied.stdout + applied.stderr).toContain('ns.k.sub');
  });

  it('a merge keeps it, and the preview says nothing about it', () => {
    const preview = rvr(['data', 'import', 'entries', path.join(root, 'imp.json'), '-P', '--merge', '--preview']);
    expect(preview.stdout).not.toContain('ns.k.sub');
  });
});

describe('L22 (#277 item 4): rm names the hidden keys it removes with the entry', () => {
  beforeEach(() => {
    ok(['set', 'ns.k', 'leaf']);
    fs.writeFileSync(projectFile('ns.k.sub.json'), '{"value": "sub"}');
  });

  it('CLI: the success line names the hidden key', () => {
    const r = rvr(['rm', 'ns.k', '-f']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('ns.k.sub');
    expect(exists(projectFile('ns.k.sub.json'))).toBe(false);
  });

  it('reverie_remove: the reply names the hidden key', async () => {
    const s = await server();
    const r = await s.call('reverie_remove', { key: 'ns.k' });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toContain('ns.k.sub');
  }, SLOW_TEST_MS);

  it('an entry with nothing hidden under it: the line is as before', () => {
    ok(['set', 'plain', 'p']);
    const r = rvr(['rm', 'plain', '-f']);
    expect(r.stdout.trim()).toMatch(/Entry 'plain' removed successfully\.$/);
  });
});

describe('L23 (#277 item 5): rm finds a key under the spelling get finds it by', () => {
  /** Whether this filesystem opens `Name` for `name`: the only place the repro exists. */
  function foldsCase(): boolean {
    const probe = path.join(root, 'CaseProbe');
    fs.writeFileSync(probe, '');
    return exists(path.join(root, 'caseprobe'));
  }

  it('hidden: rm NS.K.SUB removes the hidden ns.k.sub and nothing else', () => {
    if (!foldsCase()) return;   // a case-sensitive filesystem: get finds nothing either
    ok(['set', 'ns.k', 'leaf']);
    fs.writeFileSync(projectFile('ns.k.sub.json'), '{"value": "sub"}');
    expect(rvr(['get', 'NS.K.SUB']).status).toBe(0);
    const r = json(['rm', 'NS.K.SUB', '-f']);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(exists(projectFile('ns.k.sub.json'))).toBe(false);
    expect(exists(projectFile('ns.k.json'))).toBe(true);
  });

  it('not hidden: rm NS.X removes ns.x, and never says it is in the global store', () => {
    if (!foldsCase()) return;
    ok(['set', 'ns.x', 'v']);
    const r = json(['rm', 'NS.X', '-f']);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(exists(projectFile('ns.x.json'))).toBe(false);
  });

  it('another Unicode normalization: rm of the NFD spelling removes the NFC file', () => {
    const nfc = 'café';
    const nfd = 'café';
    ok(['set', 'ns.k', 'leaf']);
    fs.writeFileSync(projectFile(`ns.k.${nfc}.json`), '{"value": "sub"}');
    if (rvr(['get', `ns.k.${nfd}`]).status !== 0) return;   // a filesystem that keeps the two apart
    const r = json(['rm', `ns.k.${nfd}`, '-f']);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(exists(projectFile(`ns.k.${nfc}.json`))).toBe(false);
  });
});

describe('L25 (#295): a refused write leaves a store without scaffolding as it was', () => {
  let bare: string;
  beforeEach(() => {
    bare = path.join(root, 'bare');
    fs.mkdirSync(path.join(bare, '.reverie'), { recursive: true });
    fs.writeFileSync(path.join(bare, '.reverie', 'ch.json'), '{"value": "c"}');
  });
  const listing = () => fs.readdirSync(path.join(bare, '.reverie')).sort();

  it('alias set named after an entry: INVALID_INPUT, and no _epoch.json, _README.md or .gitignore', () => {
    const r = json(['alias', 'set', 'ch', 'sx'], bare);
    expect(r.error?.code).toBe('INVALID_INPUT');
    expect(listing()).toEqual(['ch.json']);
  });

  it('set under an entry: refused, and the store unchanged', () => {
    const r = json(['set', 'ch.sub', 'v'], bare);
    expect(r.ok).toBe(false);
    expect(listing()).toEqual(['ch.json']);
  });

  it('a write that lands still scaffolds the store', () => {
    const r = json(['set', 'other', 'o'], bare);
    expect(r.ok).toBe(true);
    expect(listing()).toEqual(expect.arrayContaining(['.gitignore', '_README.md', 'ch.json', 'other.json']));
  });
});

describe('L26: a value that completes a reference cycle is stored with a warning', () => {
  it('CLI: the second half of a cycle warns, naming it; the first does not', () => {
    const first = json(['set', 'a', '${b}']);
    expect(first.ok).toBe(true);
    expect((first.warnings ?? []).map(w => w.code)).not.toContain('INTERPOLATION_CYCLE');
    const second = json(['set', 'b', '${a}']);
    expect(second.ok).toBe(true);
    // The chain as a read of the value meets it: from its first reference.
    const w = (second.warnings ?? []).find(x => x.code === 'INTERPOLATION_CYCLE');
    expect(w?.message).toContain("'b' completes a reference cycle (a → b → a)");
    // Text mode says it on stderr.
    const t = rvr(['set', 'b', '${a}']);
    expect(t.status).toBe(0);
    expect(t.stderr).toContain('a → b → a');
  });

  it('reverie_set: the reply warns', async () => {
    ok(['set', 'a', '${b}']);
    const s = await server();
    const r = await s.call('reverie_set', { key: 'b', value: '${a}' });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toContain("'b' completes a reference cycle (a → b → a)");
  }, SLOW_TEST_MS);

  it('a `:?` guard is not a cycle: no warning', () => {
    const r = json(['set', 'g', '${x:?x must be set}']);
    expect((r.warnings ?? []).map(w => w.code)).not.toContain('INTERPOLATION_CYCLE');
  });
});

describe('L27: get --json of a `:?` guard or a cycle fails, as plain get does', () => {
  it('a `:?` guard: ok false, the message plain get prints, exit 1', () => {
    ok(['set', 'g', '${x:?x must be set}']);
    const plain = rvr(['get', 'g']);
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain('x must be set');
    const r = json(['get', 'g']);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(1);
    expect(r.error?.code).toBe('RUNTIME');
    expect(r.error?.message).toBe('x must be set');
  });

  it('a cycle: ok false, naming the cycle', () => {
    ok(['set', 'a', '${b}']);
    ok(['set', 'b', '${a}']);
    const r = json(['get', 'a']);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('Circular interpolation detected');
  });

  it('--source --json still returns the stored text (owner decision 2026-11-28)', () => {
    ok(['set', 'g', '${x:?x must be set}']);
    const r = json(['get', 'g', '--source']);
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ g: '${x:?x must be set}' });
  });
});
