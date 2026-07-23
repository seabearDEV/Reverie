import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWriteFileSync } from '../utils/atomicWrite';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('atomicWriteFileSync', () => {
  it('writes content to the target file', () => {
    const target = path.join(tmpDir, 'test.json');
    atomicWriteFileSync(target, '{"hello":"world"}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"hello":"world"}');
  });

  it('does not leave any .tmp file behind', () => {
    const target = path.join(tmpDir, 'test.json');
    atomicWriteFileSync(target, 'content');
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  // #159 write-side regression: a hostile store pre-plants a symlink at the
  // (formerly predictable) tmp path pointing outside the store. The write
  // must NOT follow it and clobber the target. Randomized tmp suffix + 'wx'
  // (O_EXCL, no-follow) close this.
  it('does not follow a pre-planted symlink at the legacy tmp path (#159)', () => {
    const victim = path.join(tmpDir, 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL');
    const target = path.join(tmpDir, 'entry.json');
    // The old predictable tmp path an attacker would have targeted.
    fs.symlinkSync(victim, target + '.tmp');

    atomicWriteFileSync(target, '{"v":"written"}');

    // Victim untouched; target written correctly.
    expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"v":"written"}');
  });

  it('overwrites existing file atomically', () => {
    const target = path.join(tmpDir, 'test.json');
    fs.writeFileSync(target, 'old');
    atomicWriteFileSync(target, 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
  });

  it('creates file with restrictive permissions (0600)', () => {
    const target = path.join(tmpDir, 'perms.json');
    atomicWriteFileSync(target, 'secret');
    const stat = fs.statSync(target);
    // 0o600 = owner read/write only; mask off file type bits
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('handles unicode content', () => {
    const target = path.join(tmpDir, 'unicode.json');
    const content = '{"emoji":"🚀","chinese":"你好"}';
    atomicWriteFileSync(target, content);
    expect(fs.readFileSync(target, 'utf8')).toBe(content);
  });

  it('handles empty content', () => {
    const target = path.join(tmpDir, 'empty.json');
    atomicWriteFileSync(target, '');
    expect(fs.readFileSync(target, 'utf8')).toBe('');
  });

  it('handles large content', () => {
    const target = path.join(tmpDir, 'large.json');
    const content = 'x'.repeat(1_000_000);
    atomicWriteFileSync(target, content);
    expect(fs.readFileSync(target, 'utf8')).toBe(content);
  });

  it('throws if parent directory does not exist', () => {
    const target = path.join(tmpDir, 'nonexistent', 'test.json');
    expect(() => atomicWriteFileSync(target, 'content')).toThrow();
  });
});
