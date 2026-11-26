// #246: a write under a spelling that the filesystem folds onto an existing
// key's file (APFS: `ſ` opens `s`, `ﬁ` opens `fi`) replaced that entry and
// reported success. The name check folds case only. Which spellings fold is
// the filesystem's rule, so each case asks the temp dir's filesystem first:
// where the spelling opens the stored file the write is refused; where it
// does not, the two are separate entries and both writes stand.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

describe('a write under a spelling that opens another entry (#246)', () => {
  let dataDir: string;
  const storeDir = () => path.join(dataDir, 'store');

  const rvr = (args: string[]): { out: string; status: number } => {
    try {
      const out = execFileSync('bun', ['dist/index.js', ...args], {
        env: { ...process.env, RVR_DATA_DIR: dataDir, RVR_NO_PROJECT: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
      return { out, status: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer; status?: number };
      return { out: (err.stdout ?? Buffer.from('')).toString(), status: err.status ?? 1 };
    }
  };
  const json = (args: string[]) => {
    const r = rvr(['--json', ...args]);
    return { status: r.status, env: JSON.parse(r.out) as { ok: boolean; result?: unknown; error?: { code: string; message: string } } };
  };
  const value = (key: string) => (json(['get', '-G', key]).env.result as Record<string, string> | undefined)?.[key];
  /** Does the store directory's filesystem open `stored`'s entry file for `asked`? */
  const folds = (asked: string, stored: string) =>
    path.join(storeDir(), `${asked}.json`) !== path.join(storeDir(), `${stored}.json`)
    && fs.existsSync(path.join(storeDir(), `${asked}.json`))
    && fs.existsSync(path.join(storeDir(), `${stored}.json`))
    && fs.statSync(path.join(storeDir(), `${asked}.json`)).ino === fs.statSync(path.join(storeDir(), `${stored}.json`)).ino;

  beforeAll(() => assertDistHonorsDataDir());
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-fold-')); });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it.each([
    ['long s (U+017F)', 'commands.deploy', 'commandſ.deploy'],
    ['fi ligature (U+FB01)', 'file.name', 'ﬁle.name'],
  ])('set under a %s spelling', (_name, stored, asked) => {
    expect(rvr(['set', '-G', stored, 'ORIGINAL']).status).toBe(0);
    const r = json(['set', '-G', asked, 'OTHER']);
    if (folds(asked, stored)) {
      expect(r.status).toBe(1);
      expect(r.env.error?.code).toBe('INVALID_INPUT');
      expect(r.env.error?.message).toContain(`opens the file of the existing key '${stored}'`);
      expect(value(stored)).toBe('ORIGINAL');
    } else {
      expect(r.env.ok).toBe(true);
      expect(value(stored)).toBe('ORIGINAL');
      expect(value(asked)).toBe('OTHER');
    }
  });

  it('copy onto such a spelling', () => {
    rvr(['set', '-G', 'commands.deploy', 'ORIGINAL']);
    rvr(['set', '-G', 'ops.x', 'COPIED']);
    const r = json(['copy', '-G', 'ops.x', 'commandſ.deploy', '-f']);
    if (folds('commandſ.deploy', 'commands.deploy')) {
      expect(r.env.error?.code).toBe('INVALID_INPUT');
      expect(value('commands.deploy')).toBe('ORIGINAL');
    } else {
      expect(r.env.ok).toBe(true);
      expect(value('commands.deploy')).toBe('ORIGINAL');
    }
  });

  it('rename onto such a spelling', () => {
    rvr(['set', '-G', 'commands.deploy', 'ORIGINAL']);
    rvr(['set', '-G', 'ops.y', 'MOVED']);
    const r = json(['rename', '-G', 'ops.y', 'commandſ.deploy']);
    if (folds('commandſ.deploy', 'commands.deploy')) {
      expect(r.env.error?.code).toBe('INVALID_INPUT');
      expect(value('commands.deploy')).toBe('ORIGINAL');
      expect(value('ops.y')).toBe('MOVED');
    } else {
      expect(r.env.ok).toBe(true);
      expect(value('commands.deploy')).toBe('ORIGINAL');
    }
  });

  // A namespace copy and a merge import write their new keys through the
  // full save, not the single-entry path.
  it('copy of a namespace whose leaves land on such a spelling', () => {
    rvr(['set', '-G', 'commands.deploy', 'ORIGINAL']);
    rvr(['set', '-G', 'ops.deploy', 'COPIED']);
    rvr(['set', '-G', 'ops.status', 'ALSO']);
    const r = json(['copy', '-G', 'ops', 'commandſ', '-f']);
    if (folds('commandſ.deploy', 'commands.deploy')) {
      expect(r.env.error?.code).toBe('INVALID_INPUT');
      expect(r.env.error?.message).toContain("existing key 'commands.deploy'");
      expect(value('commands.deploy')).toBe('ORIGINAL');
      expect(value('commandſ.status')).toBeUndefined();
    } else {
      expect(r.env.ok).toBe(true);
      expect(value('commands.deploy')).toBe('ORIGINAL');
    }
  });

  it('a merge import with such a key', () => {
    rvr(['set', '-G', 'commands.deploy', 'ORIGINAL']);
    const file = path.join(dataDir, 'in.json');
    fs.writeFileSync(file, JSON.stringify({ 'commandſ.deploy': 'IMPORTED', 'other.key': 'x' }));
    const r = json(['data', 'import', 'entries', file, '--merge', '-f', '-G']);
    if (folds('commandſ.deploy', 'commands.deploy')) {
      expect(r.env.error?.code).toBe('INVALID_INPUT');
      expect(value('commands.deploy')).toBe('ORIGINAL');
      expect(value('other.key')).toBeUndefined();
    } else {
      expect(r.env.ok).toBe(true);
      expect(value('commands.deploy')).toBe('ORIGINAL');
    }
  });

  it('the same key in another Unicode normalization is that key, not a collision', () => {
    const nfc = 'café.x';
    const nfd = 'café.x';
    expect(rvr(['set', '-G', nfc, 'one']).status).toBe(0);
    const r = json(['set', '-G', nfd, 'two']);
    expect(r.env.ok).toBe(true);
  });

  it('an ordinary overwrite of the key as stored still works', () => {
    rvr(['set', '-G', 'commands.deploy', 'ORIGINAL']);
    expect(json(['set', '-G', '-f', 'commands.deploy', 'NEW']).env.ok).toBe(true);
    expect(value('commands.deploy')).toBe('NEW');
  });
});
