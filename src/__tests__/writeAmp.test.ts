import { recordWrite, formatWriteAmpWarning, clearWriteAmpState } from '../utils/writeAmp';

beforeEach(() => {
  clearWriteAmpState();
});

describe('recordWrite', () => {
  it('returns null on the 1st write', () => {
    const result = recordWrite('s1', 'files.x', 1_000_000);
    expect(result).toBeNull();
  });

  it('returns null on the 2nd write within window', () => {
    recordWrite('s1', 'files.x', 1_000_000);
    const result = recordWrite('s1', 'files.x', 1_001_000);
    expect(result).toBeNull();
  });

  it('returns warning on the 3rd write within window', () => {
    recordWrite('s1', 'files.x', 1_000_000);
    recordWrite('s1', 'files.x', 1_001_000);
    const result = recordWrite('s1', 'files.x', 1_002_000);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
    expect(result!.firstWriteMsAgo).toBe(2_000);
  });

  it('returns warning on the 5th write with count=5', () => {
    recordWrite('s1', 'k', 1_000_000);
    recordWrite('s1', 'k', 1_001_000);
    recordWrite('s1', 'k', 1_002_000);
    recordWrite('s1', 'k', 1_003_000);
    const result = recordWrite('s1', 'k', 1_004_000);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(5);
  });

  it('drops timestamps outside the 30-min window before counting', () => {
    // 1st write 31 minutes before the 2nd; the 1st falls outside the window.
    const t0 = 1_000_000;
    recordWrite('s1', 'k', t0);
    recordWrite('s1', 'k', t0 + 31 * 60 * 1000);
    // After window slide, only 1 timestamp remains. The 3rd "real" write
    // is now the 2nd in-window write — should NOT trip the threshold.
    const result = recordWrite('s1', 'k', t0 + 31 * 60 * 1000 + 1000);
    expect(result).toBeNull();
  });

  it('counts only in-window writes when computing firstWriteMsAgo', () => {
    const t0 = 1_000_000;
    // Out-of-window write that gets dropped.
    recordWrite('s1', 'k', t0);
    // Three in-window writes.
    recordWrite('s1', 'k', t0 + 31 * 60 * 1000);
    recordWrite('s1', 'k', t0 + 31 * 60 * 1000 + 1000);
    const result = recordWrite('s1', 'k', t0 + 31 * 60 * 1000 + 2000);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
    expect(result!.firstWriteMsAgo).toBe(2000);
  });

  it('different sessions get fresh counters', () => {
    recordWrite('s1', 'k', 1_000_000);
    recordWrite('s1', 'k', 1_001_000);
    recordWrite('s1', 'k', 1_002_000); // s1 trips
    const r2 = recordWrite('s2', 'k', 1_003_000);
    expect(r2).toBeNull();
  });

  it('different keys in same session get fresh counters', () => {
    recordWrite('s1', 'a', 1_000_000);
    recordWrite('s1', 'a', 1_001_000);
    const r = recordWrite('s1', 'b', 1_002_000);
    expect(r).toBeNull();
  });

  it('clearWriteAmpState resets all counters', () => {
    recordWrite('s1', 'k', 1_000_000);
    recordWrite('s1', 'k', 1_001_000);
    clearWriteAmpState();
    const r = recordWrite('s1', 'k', 1_002_000);
    expect(r).toBeNull();
  });
});

describe('formatWriteAmpWarning', () => {
  it('renders count, time, and the seedDensity pointer', () => {
    const msg = formatWriteAmpWarning({ count: 3, firstWriteMsAgo: 12 * 60 * 1000 });
    expect(msg).toContain('3 times');
    expect(msg).toContain('12m');
    expect(msg).toContain('conventions.seedDensity');
  });

  it('renders sub-minute durations as seconds', () => {
    const msg = formatWriteAmpWarning({ count: 3, firstWriteMsAgo: 45_000 });
    expect(msg).toContain('45s');
  });
});
