import { describe, it, expect } from 'vitest';
import { checkSeedQuality } from '../commands/lint';

describe('checkSeedQuality', () => {
  it('returns no issues for an empty store', () => {
    expect(checkSeedQuality({})).toEqual([]);
  });

  it('flags a short generic entry with no project-specific signal', () => {
    const flat = { 'arch.overview': 'This is the architecture.' };
    const issues = checkSeedQuality(flat);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('too-short');
    expect(issues[0].key).toBe('arch.overview');
  });

  it('does not flag short entries that carry project-specific signal', () => {
    // File path counts as signal — even if short, the entry seeds something
    // the LLM could not have generated on its own.
    const flat = { 'files.store': 'src/store.ts' };
    expect(checkSeedQuality(flat)).toEqual([]);
  });

  it('does not flag long generic-sounding entries', () => {
    // Long entries get the benefit of the doubt — the too-short check only
    // fires under 60 chars. Longer entries might still be low-amp but the
    // too-short heuristic stays humble.
    const flat = {
      'arch.overview': 'This is the architecture of the system and it describes how everything fits together across all the modules and layers.',
    };
    const issues = checkSeedQuality(flat);
    // Should NOT trigger too-short (>= 60 chars).
    expect(issues.find(i => i.code === 'too-short')).toBeUndefined();
  });

  it('flags a low-amplification npm-test phrase', () => {
    const flat = { 'arch.tests': 'npm test runs the tests.' };
    const issues = checkSeedQuality(flat);
    // The too-short heuristic fires FIRST (the `continue` in the loop means
    // the low-amp-phrase check is skipped). This is intentional: once an
    // entry's flagged, we report the most actionable finding and move on.
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('too-short');
  });

  it('flags a low-amplification phrase in a longer entry', () => {
    const flat = {
      'arch.tests': 'The project uses Vitest; npm test runs the tests whenever developers change files in the repo.',
    };
    const issues = checkSeedQuality(flat);
    const phraseIssue = issues.find(i => i.code === 'low-amp-phrase');
    expect(phraseIssue).toBeDefined();
    expect(phraseIssue?.key).toBe('arch.tests');
  });

  it('exempts entries under commands.* (literal commands are low-amp by nature)', () => {
    const flat = { 'commands.build': 'npm run build' };
    expect(checkSeedQuality(flat)).toEqual([]);
  });

  it('exempts entries under deps.* (version pins are low-amp by nature)', () => {
    const flat = { 'deps.chalk': 'chalk v4' };
    expect(checkSeedQuality(flat)).toEqual([]);
  });

  it('exempts entries under project.* (metadata is short and declarative)', () => {
    const flat = { 'project.name': 'myapp' };
    expect(checkSeedQuality(flat)).toEqual([]);
  });

  it('exempts context.next_session (ephemeral handoff state)', () => {
    const flat = { 'context.next_session': 'brief note' };
    expect(checkSeedQuality(flat)).toEqual([]);
  });

  it('exempts conventions.seedDensity (the principle entry that cites bad examples)', () => {
    const flat = {
      'conventions.seedDensity': 'Short entries like "npm test runs the tests" are low-amp; avoid them.',
    };
    expect(checkSeedQuality(flat)).toEqual([]);
  });

  it('flags interpolation landmines: a `:?` reference that is not met fails every read', () => {
    const flat = { 'arch.example': 'The deploy host is ${missing_key:?set the host first} and that fails resolution.' };
    const issues = checkSeedQuality(flat);
    const landmine = issues.find(i => i.code === 'interp-landmine');
    expect(landmine).toBeDefined();
    expect(landmine?.message).toMatch(/Interpolation would fail/);
  });

  it('does not flag a plain reference that does not resolve: a read returns it as written (#202)', () => {
    // Every lint lists these on its own; flagging them here listed the entry twice.
    const flat = { 'arch.example': 'The interp syntax is ${missing_key} which a read returns as written.' };
    expect(checkSeedQuality(flat).find(i => i.code === 'interp-landmine')).toBeUndefined();
  });

  it('does not flag backslash-escaped interpolation syntax', () => {
    const flat = { 'arch.example': 'Use \\${key} to reference a value, \\$(key) to exec — these need project-specific anchoring.' };
    const issues = checkSeedQuality(flat);
    expect(issues.find(i => i.code === 'interp-landmine')).toBeUndefined();
  });

  it('recognizes backtick-wrapped identifiers as project-specific signal', () => {
    const flat = { 'arch.bits': '`ScopedStore`' };
    expect(checkSeedQuality(flat)).toEqual([]);
  });

  it('recognizes camelCase identifiers as project-specific signal', () => {
    const flat = { 'arch.fn': 'resolveKey' };
    expect(checkSeedQuality(flat)).toEqual([]);
  });

  it('recognizes snake_case / CONSTANT_CASE as project-specific signal', () => {
    const flat = { 'arch.var': 'MAX_DEPTH' };
    expect(checkSeedQuality(flat)).toEqual([]);
  });

  it('recognizes dot-notation refs to other entries as project-specific signal', () => {
    const flat = { 'arch.a': 'see arch.overview' };
    expect(checkSeedQuality(flat)).toEqual([]);
  });
});
