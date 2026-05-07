import { describe, it, expect } from 'vitest';
import { computeTopologyFromEntries, topologyToDot } from '../commands/topology';
import { AuditEntry } from '../utils/audit';

function makeEntry(partial: Partial<AuditEntry>): AuditEntry {
  return {
    ts: Date.now(),
    session: 's1',
    src: 'mcp',
    tool: 'reverie_get',
    op: 'read',
    success: true,
    hit: true,
    key: 'some.key',
    ...partial,
  };
}

describe('computeTopologyFromEntries', () => {
  it('returns empty topology for no entries', () => {
    const stats = computeTopologyFromEntries([]);
    expect(stats).toMatchObject({
      sessionCount: 0,
      entryCount: 0,
      pairs: [],
      isolated: [],
    });
  });

  it('counts one session with two focused reads as one pair', () => {
    const entries = [
      makeEntry({ session: 's1', key: 'arch.a' }),
      makeEntry({ session: 's1', key: 'arch.b' }),
    ];
    const stats = computeTopologyFromEntries(entries);
    expect(stats.sessionCount).toBe(1);
    expect(stats.entryCount).toBe(2);
    expect(stats.pairs).toEqual([{ a: 'arch.a', b: 'arch.b', sessions: 1 }]);
    expect(stats.isolated).toEqual([]);
  });

  it('deduplicates repeat reads within a session', () => {
    // Same key read three times in the same session should still count as
    // one "appearance" — the pair signal is about distinct-entries-together,
    // not frequency-within-a-session.
    const entries = [
      makeEntry({ session: 's1', key: 'arch.a' }),
      makeEntry({ session: 's1', key: 'arch.a' }),
      makeEntry({ session: 's1', key: 'arch.a' }),
      makeEntry({ session: 's1', key: 'arch.b' }),
    ];
    const stats = computeTopologyFromEntries(entries);
    expect(stats.pairs).toEqual([{ a: 'arch.a', b: 'arch.b', sessions: 1 }]);
  });

  it('accumulates pair counts across sessions', () => {
    const entries = [
      makeEntry({ session: 's1', key: 'arch.a' }),
      makeEntry({ session: 's1', key: 'arch.b' }),
      makeEntry({ session: 's2', key: 'arch.a' }),
      makeEntry({ session: 's2', key: 'arch.b' }),
      makeEntry({ session: 's3', key: 'arch.a' }),
      makeEntry({ session: 's3', key: 'arch.b' }),
    ];
    const stats = computeTopologyFromEntries(entries);
    expect(stats.pairs).toEqual([{ a: 'arch.a', b: 'arch.b', sessions: 3 }]);
    expect(stats.sessionCount).toBe(3);
  });

  it('excludes reverie_context bootstraps', () => {
    // Two sessions where reverie_context was called alongside a focused get.
    // The context call must NOT contribute an edge to every entry the
    // bootstrap returned — that would drown out the focused-read signal.
    const entries = [
      makeEntry({ session: 's1', tool: 'reverie_context', key: undefined }),
      makeEntry({ session: 's1', tool: 'reverie_get', key: 'arch.a' }),
      makeEntry({ session: 's2', tool: 'reverie_context', key: undefined }),
      makeEntry({ session: 's2', tool: 'reverie_get', key: 'arch.a' }),
    ];
    const stats = computeTopologyFromEntries(entries);
    expect(stats.pairs).toEqual([]);
    expect(stats.isolated).toEqual(['arch.a']);
  });

  it('excludes reverie_find, reverie_stale, reverie_export, reverie_alias_list', () => {
    const entries = [
      makeEntry({ session: 's1', tool: 'reverie_find', key: 'query' }),
      makeEntry({ session: 's1', tool: 'reverie_stale' }),
      makeEntry({ session: 's1', tool: 'reverie_export' }),
      makeEntry({ session: 's1', tool: 'reverie_alias_list' }),
      makeEntry({ session: 's1', tool: 'reverie_get', key: 'arch.a' }),
    ];
    const stats = computeTopologyFromEntries(entries);
    expect(stats.sessionCount).toBe(1);
    expect(stats.isolated).toEqual(['arch.a']);
    expect(stats.pairs).toEqual([]);
  });

  it('excludes misses (hit: false) — no signal from "entry not found"', () => {
    const entries = [
      makeEntry({ session: 's1', key: 'arch.a', hit: true }),
      makeEntry({ session: 's1', key: 'arch.missing', hit: false }),
    ];
    const stats = computeTopologyFromEntries(entries);
    expect(stats.entryCount).toBe(1);
    expect(stats.pairs).toEqual([]);
    expect(stats.isolated).toEqual(['arch.a']);
  });

  it('canonicalizes alias → resolved key when aliasResolved is set', () => {
    // Session 1 uses the alias; session 2 uses the canonical name. The
    // topology should treat them as the same entry and report a pair.
    const entries = [
      makeEntry({ session: 's1', key: 'chk', aliasResolved: 'commands.check' }),
      makeEntry({ session: 's1', key: 'arch.a' }),
      makeEntry({ session: 's2', key: 'commands.check' }),
      makeEntry({ session: 's2', key: 'arch.a' }),
    ];
    const stats = computeTopologyFromEntries(entries);
    expect(stats.pairs).toEqual([{ a: 'arch.a', b: 'commands.check', sessions: 2 }]);
  });

  it('reports isolated entries (read once, no pair)', () => {
    const entries = [
      makeEntry({ session: 's1', key: 'arch.a' }),
      makeEntry({ session: 's1', key: 'arch.b' }),
      makeEntry({ session: 's2', key: 'arch.solo' }),
    ];
    const stats = computeTopologyFromEntries(entries);
    expect(stats.pairs).toEqual([{ a: 'arch.a', b: 'arch.b', sessions: 1 }]);
    expect(stats.isolated).toEqual(['arch.solo']);
  });

  it('sorts pairs by session count descending', () => {
    const entries = [
      // a↔b: 1 session
      makeEntry({ session: 's1', key: 'arch.a' }),
      makeEntry({ session: 's1', key: 'arch.b' }),
      // a↔c: 3 sessions
      makeEntry({ session: 's2', key: 'arch.a' }),
      makeEntry({ session: 's2', key: 'arch.c' }),
      makeEntry({ session: 's3', key: 'arch.a' }),
      makeEntry({ session: 's3', key: 'arch.c' }),
      makeEntry({ session: 's4', key: 'arch.a' }),
      makeEntry({ session: 's4', key: 'arch.c' }),
    ];
    const stats = computeTopologyFromEntries(entries);
    expect(stats.pairs[0]).toMatchObject({ a: 'arch.a', b: 'arch.c', sessions: 3 });
    expect(stats.pairs[1]).toMatchObject({ a: 'arch.a', b: 'arch.b', sessions: 1 });
  });

  it('records period label from input', () => {
    const stats = computeTopologyFromEntries([], 7);
    expect(stats.period).toBe('7d');
    const statsAll = computeTopologyFromEntries([]);
    expect(statsAll.period).toBe('all');
  });
});

describe('topologyToDot', () => {
  it('emits a graph block with nodes and labeled edges', () => {
    const stats = computeTopologyFromEntries([
      { ts: 0, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', success: true, hit: true, key: 'arch.a' },
      { ts: 0, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', success: true, hit: true, key: 'arch.b' },
    ]);
    const dot = topologyToDot(stats);
    expect(dot).toMatch(/graph codexTopology \{/);
    expect(dot).toContain('"arch.a"');
    expect(dot).toContain('"arch.b"');
    expect(dot).toContain('"arch.a" -- "arch.b" [label="1", weight=1]');
    expect(dot.trim()).toMatch(/\}$/);
  });

  it('filters out pairs below minSessions when rendering DOT', () => {
    const stats = computeTopologyFromEntries([
      { ts: 0, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', success: true, hit: true, key: 'arch.a' },
      { ts: 0, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', success: true, hit: true, key: 'arch.b' },
    ]);
    const dot = topologyToDot(stats, 2);
    expect(dot).not.toContain('"arch.a"');
    expect(dot).not.toContain('"arch.b"');
  });
});
