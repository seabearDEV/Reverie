// Which keys open the same entry file is the filesystem's answer, so this
// asks a real one: a store directory in a temp dir. The cases that need a
// filesystem that folds names check first that this one does, and otherwise
// assert the opposite — two spellings that are two files are two entries.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let projectDir: string | null = null;
let globalDir = '';

vi.mock('../utils/paths', () => ({
  findProjectStoreDir: vi.fn(() => projectDir),
  getGlobalStoreDirPath: vi.fn(() => globalDir),
}));

import { keysOpeningSameEntry } from '../utils/entryIdentity';

describe('keysOpeningSameEntry', () => {
  let root: string;
  const put = (dir: string, key: string) => fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ value: key }));
  /** Does this filesystem open `stored`'s file for `asked`? */
  const folds = (dir: string, asked: string, stored: string): boolean => {
    try {
      return fs.readFileSync(path.join(dir, `${asked}.json`), 'utf8') === JSON.stringify({ value: stored });
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-identity-'));
    globalDir = path.join(root, 'global');
    projectDir = path.join(root, 'project');
    fs.mkdirSync(globalDir);
    fs.mkdirSync(projectDir);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a key does not report itself, and different entries are different files', () => {
    put(projectDir!, 'commands.deploy');
    put(projectDir!, 'commands.status');
    expect(keysOpeningSameEntry('commands.deploy', ['commands.deploy', 'commands.status'])).toEqual([]);
    expect(keysOpeningSameEntry('commands.status', ['commands.deploy'])).toEqual([]);
  });

  it('a key that opens no file, a namespace, and a key that is not storable match nothing', () => {
    put(projectDir!, 'commands.deploy');
    expect(keysOpeningSameEntry('commands.nosuch', ['commands.deploy'])).toEqual([]);
    expect(keysOpeningSameEntry('commands', ['commands.deploy'])).toEqual([]);
    expect(keysOpeningSameEntry('../escape', ['commands.deploy'])).toEqual([]);
    expect(keysOpeningSameEntry('commands.deploy', ['__proto__', '../escape', ''])).toEqual([]);
  });

  // Each spelling is one the filesystem under this temp dir may or may not
  // fold. Whatever it does, the answer has to agree with it: the same entry
  // exactly when the spelling opens the stored key's file.
  const spellings: [label: string, asked: string, stored: string][] = [
    ['another case', 'commands.DEPLOY', 'commands.deploy'],
    ['U+017F LONG S for s', 'commandſ.deploy', 'commands.deploy'],
    ['U+FB01 ligature for fi', 'commands.ﬁx', 'commands.fix'],
    ['sharp s for ss', 'jobs.paß', 'jobs.pass'],
    ['NFD for NFC', 'café.go', 'café.go'],
  ];
  for (const [label, asked, stored] of spellings) {
    it(`${label}: the same entry exactly when the filesystem opens the stored file for it`, () => {
      put(globalDir, stored);
      const opensStored = folds(globalDir, asked, stored);
      expect(keysOpeningSameEntry(asked, [stored, 'unrelated.key'])).toEqual(opensStored ? [stored] : []);
      // And the other way round: the stored key asked about the spelling.
      expect(keysOpeningSameEntry(stored, [asked])).toEqual(opensStored ? [asked] : []);
    });
  }

  it('still agrees after the entry is rewritten through the other spelling', () => {
    // An atomic write replaces the file. On APFS the filesystem then reports
    // the spelling the rename was given as the file's name (realpath), while
    // the listing keeps the old one — the state that defeated a name check.
    put(globalDir, 'commands.deploy');
    const asked = 'commandſ.deploy';
    const opensStored = folds(globalDir, asked, 'commands.deploy');
    const tmp = path.join(globalDir, '.tmp-write');
    fs.writeFileSync(tmp, JSON.stringify({ value: 'rewritten' }));
    fs.renameSync(tmp, path.join(globalDir, `${asked}.json`));
    const oneFile = fs.readdirSync(globalDir).filter(f => f.endsWith('.json')).length === 1;
    expect(oneFile).toBe(opensStored);
    expect(keysOpeningSameEntry(asked, ['commands.deploy'])).toEqual(opensStored ? ['commands.deploy'] : []);
    expect(keysOpeningSameEntry('commands.deploy', [asked])).toEqual(opensStored ? [asked] : []);
  });

  it('looks in each store on its own: the same key in two stores is two files', () => {
    put(projectDir!, 'commands.deploy');
    put(globalDir, 'commands.other');
    // commands.deploy exists only in the project, commands.other only in
    // the global store: neither opens the other's file anywhere.
    expect(keysOpeningSameEntry('commands.deploy', ['commands.other'])).toEqual([]);
  });

  it('finds a match in the global store when there is no project', () => {
    projectDir = null;
    put(globalDir, 'commands.deploy');
    const opensStored = folds(globalDir, 'commands.DEPLOY', 'commands.deploy');
    expect(keysOpeningSameEntry('commands.DEPLOY', ['commands.deploy'])).toEqual(opensStored ? ['commands.deploy'] : []);
  });

  it('a hard link to an entry file is the same entry: the gate errs toward asking', () => {
    put(globalDir, 'commands.deploy');
    fs.linkSync(path.join(globalDir, 'commands.deploy.json'), path.join(globalDir, 'commands.alias.json'));
    expect(keysOpeningSameEntry('commands.alias', ['commands.deploy'])).toEqual(['commands.deploy']);
  });
});
