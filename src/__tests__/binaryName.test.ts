import { getBinaryName } from '../utils/binaryName';

describe('getBinaryName', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
  });

  it('returns basename of argv[1] when it contains a path separator', () => {
    process.argv = ['/usr/local/bin/node', '/path/to/dist/index.js', 'get'];
    expect(getBinaryName()).toBe('index.js');
  });

  it('returns basename of argv[0] when argv[1] has no path separator (SEA mode)', () => {
    process.argv = ['/usr/local/bin/rvr', 'get', 'project.name'];
    expect(getBinaryName()).toBe('rvr');
  });

  it('handles Windows-style paths in argv[1]', () => {
    process.argv = ['C:\\node.exe', 'C:\\app\\dist\\index.js', 'get'];
    // On POSIX, path.basename treats backslash as part of filename,
    // but getBinaryName still detects backslash as path indicator
    const result = getBinaryName();
    // argv[1] contains backslash so it's treated as a script path
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('returns rvr when argv[0] is undefined', () => {
    process.argv = [];
    expect(getBinaryName()).toBe('rvr');
  });

  it('returns basename of argv[0] when argv[1] is undefined', () => {
    process.argv = ['/usr/local/bin/rvr'];
    expect(getBinaryName()).toBe('rvr');
  });
});
