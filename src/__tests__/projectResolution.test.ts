import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveScopeForWrite,
  ProjectResolutionError,
  captureResolverDiagnostic,
} from '../projectResolution';
import {
  setProjectRootOverride,
  getProjectRootOverride,
  clearProjectFileCache,
  clearDataDirectoryCache,
  findProjectFileWithDiagnostic,
  findProjectStoreDir,
} from '../utils/paths';

let tmpDir: string;
let nestedTmpDir: string;
let storeTmpDir: string;
let originalCodexProject: string | undefined;
let originalCodexNoProject: string | undefined;

beforeEach(() => {
  // Snapshot env for restoration. Vitest runs tests serially within a file
  // by default; we still scrub so a failing test cannot leak into the next.
  originalCodexProject = process.env.CODEX_PROJECT;
  originalCodexNoProject = process.env.CODEX_NO_PROJECT;
  delete process.env.CODEX_PROJECT;
  delete process.env.CODEX_NO_PROJECT;

  // Two sibling temp dirs: one bare (no .codexcli), one with .codexcli/.
  // Both live under os.tmpdir(); we trust that ancestors do not contain
  // a stray .codexcli/ — same assumption other tests in this suite make.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resolution-bare-'));
  nestedTmpDir = path.join(tmpDir, 'nested');
  fs.mkdirSync(nestedTmpDir);
  storeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resolution-store-'));
  fs.mkdirSync(path.join(storeTmpDir, '.codexcli'));

  setProjectRootOverride(null);
  clearProjectFileCache();
});

afterEach(() => {
  setProjectRootOverride(null);
  clearProjectFileCache();
  if (originalCodexProject === undefined) delete process.env.CODEX_PROJECT;
  else process.env.CODEX_PROJECT = originalCodexProject;
  if (originalCodexNoProject === undefined) delete process.env.CODEX_NO_PROJECT;
  else process.env.CODEX_NO_PROJECT = originalCodexNoProject;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(storeTmpDir, { recursive: true, force: true });
});

describe('resolveScopeForWrite — scope passthrough', () => {
  it("returns 'project' unchanged when scope is 'project' and resolution succeeds", () => {
    process.env.CODEX_PROJECT = storeTmpDir;
    expect(resolveScopeForWrite('project')).toBe('project');
  });

  it("returns 'project' unchanged when scope is 'project' even if resolution fails (caller's responsibility)", () => {
    process.env.CODEX_NO_PROJECT = '1';
    expect(resolveScopeForWrite('project')).toBe('project');
  });

  it("returns 'global' unchanged when scope is 'global' and resolution succeeds", () => {
    process.env.CODEX_PROJECT = storeTmpDir;
    expect(resolveScopeForWrite('global')).toBe('global');
  });

  it("returns 'global' unchanged when scope is 'global' and resolution fails (rescue path)", () => {
    process.env.CODEX_NO_PROJECT = '1';
    expect(resolveScopeForWrite('global')).toBe('global');
  });
});

describe('resolveScopeForWrite — auto / undefined resolution', () => {
  it("returns 'project' when scope is undefined and CODEX_PROJECT resolves", () => {
    process.env.CODEX_PROJECT = storeTmpDir;
    expect(resolveScopeForWrite(undefined)).toBe('project');
  });

  it("returns 'project' when scope is 'auto' and CODEX_PROJECT resolves", () => {
    process.env.CODEX_PROJECT = storeTmpDir;
    expect(resolveScopeForWrite('auto')).toBe('project');
  });

  it('throws ProjectResolutionError when scope is undefined and resolution fails', () => {
    process.env.CODEX_NO_PROJECT = '1';
    expect(() => resolveScopeForWrite(undefined)).toThrow(ProjectResolutionError);
  });

  it("throws ProjectResolutionError when scope is 'auto' and resolution fails", () => {
    process.env.CODEX_NO_PROJECT = '1';
    expect(() => resolveScopeForWrite('auto')).toThrow(ProjectResolutionError);
  });
});

describe('ProjectResolutionError shape', () => {
  it("carries code 'PROJECT_UNRESOLVED' and the captured diagnostic", () => {
    process.env.CODEX_NO_PROJECT = '1';
    try {
      resolveScopeForWrite(undefined);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectResolutionError);
      const e = err as ProjectResolutionError;
      expect(e.code).toBe('PROJECT_UNRESOLVED');
      expect(e.diagnostic.codexNoProject).toBe(true);
      expect(e.name).toBe('ProjectResolutionError');
    }
  });

  it('error message names the failed branch (CODEX_PROJECT did not resolve)', () => {
    process.env.CODEX_PROJECT = path.join(tmpDir, 'does-not-exist');
    try {
      resolveScopeForWrite(undefined);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as ProjectResolutionError;
      expect(e.message).toContain('CODEX_PROJECT env');
      expect(e.message).toContain('DID NOT RESOLVE TO A .codexcli DIRECTORY');
      expect(e.message).toContain('codex_init');
      expect(e.message).toContain('scope:"global"');
    }
  });

  it('error message names the walk-up branch when env is unset and walk exhausts', () => {
    setProjectRootOverride(nestedTmpDir);
    try {
      resolveScopeForWrite(undefined);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as ProjectResolutionError;
      expect(e.message).toContain('Walk up from');
      expect(e.message).toContain('reached filesystem root without finding .codexcli/');
    }
  });

  it('error message hints at unsetting CODEX_NO_PROJECT when that branch fired', () => {
    process.env.CODEX_NO_PROJECT = '1';
    try {
      resolveScopeForWrite(undefined);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as ProjectResolutionError;
      expect(e.message).toContain('unset CODEX_NO_PROJECT');
    }
  });
});

describe('captureResolverDiagnostic — branch capture', () => {
  it('records codexNoProject when CODEX_NO_PROJECT is set', () => {
    process.env.CODEX_NO_PROJECT = '1';
    const d = captureResolverDiagnostic();
    expect(d.codexNoProject).toBe(true);
    expect(d.codexProject).toBeUndefined();
    expect(d.codexProjectFailed).toBe(false);
    expect(d.walkReachedRoot).toBe(false);
  });

  it('records codexProject value and codexProjectFailed when env points at a non-existent dir', () => {
    const fake = path.join(tmpDir, 'no-such-dir');
    process.env.CODEX_PROJECT = fake;
    const d = captureResolverDiagnostic();
    expect(d.codexProject).toBe(fake);
    expect(d.codexProjectFailed).toBe(true);
  });

  it('records codexProject value and does NOT mark failed when env resolves to a .codexcli dir', () => {
    process.env.CODEX_PROJECT = storeTmpDir;
    const d = captureResolverDiagnostic();
    expect(d.codexProject).toBe(storeTmpDir);
    expect(d.codexProjectFailed).toBe(false);
  });

  it('records rootOverride when one is set and walk exhausts', () => {
    setProjectRootOverride(nestedTmpDir);
    const d = captureResolverDiagnostic();
    expect(d.rootOverride).toBe(nestedTmpDir);
    expect(d.startedFrom).toBe(nestedTmpDir);
    expect(d.walkReachedRoot).toBe(true);
  });

  it('records walkReachedRoot=false when walk hits a project store', () => {
    setProjectRootOverride(storeTmpDir);
    const d = captureResolverDiagnostic();
    expect(d.walkReachedRoot).toBe(false);
  });

  it('records walkStoppedAtGlobalDir when walk reaches the codex global dir before any project store', () => {
    // Pin CODEX_DATA_DIR (=> globalDir) and start the walk at that same dir.
    // First loop iteration matches `dir === globalDir` and short-circuits with
    // walkStoppedAtGlobalDir=true (distinct from walkReachedRoot, which means
    // the walk exhausted to filesystem root).
    const origDataDir = process.env.CODEX_DATA_DIR;
    process.env.CODEX_DATA_DIR = tmpDir;
    clearDataDirectoryCache();
    setProjectRootOverride(tmpDir);
    try {
      const d = captureResolverDiagnostic();
      expect(d.walkStoppedAtGlobalDir).toBe(true);
      expect(d.walkReachedRoot).toBe(false);
    } finally {
      if (origDataDir === undefined) delete process.env.CODEX_DATA_DIR;
      else process.env.CODEX_DATA_DIR = origDataDir;
      clearDataDirectoryCache();
    }
  });
});

describe('paths.ts integration', () => {
  it('getProjectRootOverride returns the value set by setProjectRootOverride', () => {
    expect(getProjectRootOverride()).toBeNull();
    setProjectRootOverride(storeTmpDir);
    expect(getProjectRootOverride()).toBe(storeTmpDir);
  });

  it('findProjectFileWithDiagnostic returns the same path findProjectFile would, with a diagnostic', () => {
    process.env.CODEX_PROJECT = storeTmpDir;
    const result = findProjectFileWithDiagnostic();
    expect(result.path).toBe(path.join(storeTmpDir, '.codexcli'));
    expect(result.diagnostic.codexProject).toBe(storeTmpDir);
    expect(result.diagnostic.codexProjectFailed).toBe(false);
  });

  it('setProjectRootOverride invalidates the findProjectStoreDir cache (PR #104 review fix)', () => {
    // Pre-fix setProjectRootOverride only cleared projectFileCache, leaving
    // projectStoreDirCache stale. A second findProjectStoreDir() after an
    // override change would return the previous resolution. This test
    // sequence fails without the fix and passes with it.
    setProjectRootOverride(storeTmpDir);
    expect(findProjectStoreDir()).toBe(path.join(storeTmpDir, '.codexcli'));

    setProjectRootOverride(nestedTmpDir);
    expect(findProjectStoreDir()).toBeNull();
  });
});
