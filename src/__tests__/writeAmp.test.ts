import path from 'path';
import { recordWrite, formatWriteAmpWarning, clearWriteAmpState, isWriteAmpExempt, writeAmpSlot, writeAmpStore } from '../utils/writeAmp';
import { HANDOFF_KEY } from '../utils/handoff';

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

describe('exempt keys', () => {
  it('the handoff never trips, however often it is rewritten', () => {
    for (let i = 0; i < 6; i++) {
      expect(recordWrite('s1', HANDOFF_KEY, 1_000_000 + i * 1_000)).toBeNull();
    }
  });

  it('the exemption is the exact key, not a prefix or a namespace', () => {
    expect(isWriteAmpExempt(HANDOFF_KEY)).toBe(true);
    for (const key of ['context.next_sessionX', 'context.next_session.draft', 'context', 'context.handoff', 'next_session']) {
      expect(isWriteAmpExempt(key)).toBe(false);
      clearWriteAmpState();
      recordWrite('s1', key, 1_000_000);
      recordWrite('s1', key, 1_001_000);
      expect(recordWrite('s1', key, 1_002_000)?.count).toBe(3);
    }
  });

  it('handoff writes do not disturb the counters of other keys in the session', () => {
    recordWrite('s1', 'files.x', 1_000_000);
    recordWrite('s1', HANDOFF_KEY, 1_000_500);
    recordWrite('s1', 'files.x', 1_001_000);
    recordWrite('s1', HANDOFF_KEY, 1_001_500);
    expect(recordWrite('s1', 'files.x', 1_002_000)?.count).toBe(3);
  });

  it('the handoff is exempt whichever store it is written to', () => {
    for (let i = 0; i < 4; i++) {
      expect(recordWrite('s1', HANDOFF_KEY, 1_000_000 + i * 1_000, '/proj/a')).toBeNull();
    }
  });
});

describe('per-store counting', () => {
  // An entry is a key in one store. Counted on the key name alone, a key
  // written once in each of three projects read as one entry written three
  // times.
  it('the same key in two stores keeps two counters', () => {
    expect(recordWrite('s1', 'project.inFlight', 1_000_000, '/proj/a')).toBeNull();
    expect(recordWrite('s1', 'project.inFlight', 1_001_000, '/proj/a')).toBeNull();
    expect(recordWrite('s1', 'project.inFlight', 1_002_000, '/proj/b')).toBeNull();
    expect(recordWrite('s1', 'project.inFlight', 1_003_000, 'global')).toBeNull();
    // The third write to the first store is the one that trips.
    expect(recordWrite('s1', 'project.inFlight', 1_004_000, '/proj/a')?.count).toBe(3);
  });

  it('writeAmpStore names where the write landed', () => {
    const projectFile = path.join(path.sep, 'proj', 'a', '.reverie');
    const root = path.join(path.sep, 'proj', 'a');
    expect(writeAmpStore('auto', projectFile)).toBe(root);
    expect(writeAmpStore('project', projectFile)).toBe(root);
    expect(writeAmpStore('global', projectFile)).toBe('global');
    expect(writeAmpStore('auto', null)).toBe('global');
    // Two projects are two stores.
    expect(writeAmpStore('auto', path.join(path.sep, 'proj', 'b', '.reverie'))).not.toBe(root);
  });

  it('slots do not collide when a store or key holds the other half\'s characters', () => {
    const slots = [
      writeAmpSlot('k', '/proj/a'),
      writeAmpSlot('a.k', '/proj'),
      writeAmpSlot('k', '/proj/a@global'),
      writeAmpSlot('k@global', '/proj/a'),
      writeAmpSlot('k', 'global'),
      writeAmpSlot('k', ''),
      writeAmpSlot('["global","k"]', ''),
    ];
    expect(new Set(slots).size).toBe(slots.length);
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
