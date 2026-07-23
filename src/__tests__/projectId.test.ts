import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProjectId, clearProjectIdCache, parseOriginUrl, normalizeGitUrl } from '../utils/projectId';

describe('normalizeGitUrl (#141)', () => {
  it('unifies scp, ssh, and https forms of the same remote', () => {
    const expected = 'github.com/seabeardev/reverie';
    expect(normalizeGitUrl('git@github.com:seabearDEV/Reverie.git')).toBe(expected);
    expect(normalizeGitUrl('https://github.com/seabearDEV/reverie.git')).toBe(expected);
    expect(normalizeGitUrl('ssh://git@github.com/seabearDEV/Reverie')).toBe(expected);
    expect(normalizeGitUrl('https://github.com/seabeardev/reverie/')).toBe(expected);
  });

  it('handles enterprise hosts', () => {
    expect(normalizeGitUrl('git@github.gwd.broadcom.net:kh734385/SED.git'))
      .toBe('github.gwd.broadcom.net/kh734385/sed');
  });

  it('strips ports so port and portless clones of one repo unify', () => {
    expect(normalizeGitUrl('ssh://git@github.com:22/seabearDEV/Reverie.git'))
      .toBe('github.com/seabeardev/reverie');
    expect(normalizeGitUrl('https://git.example.com:8443/owner/repo.git'))
      .toBe('git.example.com/owner/repo');
  });
});

describe('parseOriginUrl (#141)', () => {
  it('reads the origin url and ignores other remotes', () => {
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "upstream"]',
      '\turl = git@github.com:other/upstream.git',
      '[remote "origin"]',
      '\turl = git@github.com:owner/repo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n');
    expect(parseOriginUrl(config)).toBe('git@github.com:owner/repo.git');
  });

  it('returns undefined without an origin remote', () => {
    expect(parseOriginUrl('[core]\n\tbare = false\n')).toBeUndefined();
  });
});

describe('getProjectId (#141)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-projectid-'));
    clearProjectIdCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('derives the id from .git/config origin', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:seabearDEV/Reverie.git\n',
    );
    expect(getProjectId(tmpDir)).toBe('github.com/seabeardev/reverie');
  });

  it('falls back to the path for non-git directories', () => {
    expect(getProjectId(tmpDir)).toBe(tmpDir);
  });

  it('caches per directory', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:a/b.git\n',
    );
    expect(getProjectId(tmpDir)).toBe('github.com/a/b');
    // A config change without cache reset keeps serving the cached id —
    // per-process cache is the documented tradeoff.
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), '');
    expect(getProjectId(tmpDir)).toBe('github.com/a/b');
  });
});
