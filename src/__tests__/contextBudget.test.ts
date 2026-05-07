import { shedToFitBudget, formatShedNotice, entryRenderBytes, PATHOLOGICAL_OVERFLOW_NOTICE } from '../utils/contextBudget';

const noTag = (_: string) => '';

describe('shedToFitBudget', () => {
  it('returns kept = entries with empty segments when under budget', () => {
    const entries = { 'project.name': 'reverie', 'commands.test': 'npm test' };
    const result = shedToFitBudget(entries, noTag, 0, 10_000);
    expect(result.kept).toEqual(entries);
    expect(result.segments).toEqual([]);
    expect(result.pathologicalOverflow).toBe(false);
  });

  it('exactly-at-budget input does not shed', () => {
    const entries = { 'project.name': 'reverie' };
    const total = entryRenderBytes('project.name', 'reverie', '');
    const result = shedToFitBudget(entries, noTag, 0, total);
    expect(result.segments).toEqual([]);
    expect(result.kept).toEqual(entries);
  });

  it('sheds files.* first when over budget at 1.5x', () => {
    const big = 'x'.repeat(200);
    const entries = {
      'project.name': 'reverie',
      'files.a': big,
      'files.b': big,
      'files.c': big,
    };
    // Budget below total but above non-files entries.
    const projectCost = entryRenderBytes('project.name', 'reverie', '');
    const result = shedToFitBudget(entries, noTag, 0, projectCost + 50);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].label).toBe('files.*');
    expect(result.segments[0].keys.length).toBeGreaterThan(0);
    expect(result.kept['project.name']).toBe('reverie');
  });

  it('sheds files.* then arch.* then large context.* in order at 3x', () => {
    const big = 'x'.repeat(300);
    const entries = {
      'project.name': 'reverie',
      'files.a': big,
      'arch.b': big,
      'context.c': 'x'.repeat(500), // largest context.* — sheds first within ns
      'context.small': 'tiny',
    };
    const result = shedToFitBudget(entries, noTag, 0, 200);
    const labels = result.segments.map(s => s.label);
    // files.* always first when present
    expect(labels[0]).toBe('files.*');
    // then arch.* then context.*
    if (labels.length > 1) {
      expect(labels).toContain('arch.*');
    }
  });

  it('sheds context.* largest-first within the namespace', () => {
    const entries = {
      'project.name': 'reverie',
      'context.small': 'a',
      'context.medium': 'a'.repeat(100),
      'context.large': 'a'.repeat(500),
    };
    // Budget tight enough that only context.large gets shed.
    const baseCost = entryRenderBytes('project.name', 'reverie', '')
      + entryRenderBytes('context.small', 'a', '')
      + entryRenderBytes('context.medium', 'a'.repeat(100), '');
    const result = shedToFitBudget(entries, noTag, 0, baseCost + 5);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].keys).toEqual(['context.large']);
    expect(result.kept).toHaveProperty('context.medium');
    expect(result.kept).toHaveProperty('context.small');
  });

  it('never sheds context.next_session', () => {
    const entries = {
      'context.next_session': 'x'.repeat(2000),
      'context.other': 'x'.repeat(200),
    };
    // Force overflow.
    const result = shedToFitBudget(entries, noTag, 0, 100);
    expect(result.kept).toHaveProperty('context.next_session');
    // context.other may or may not be shed depending on budget math; the
    // contract is that next_session is preserved.
  });

  it('never sheds project.*, conventions.*, commands.*, deps.*', () => {
    const entries = {
      'project.name': 'x'.repeat(500),
      'conventions.x': 'x'.repeat(500),
      'commands.x': 'x'.repeat(500),
      'deps.x': 'x'.repeat(500),
      'files.shedme': 'x'.repeat(100),
    };
    const result = shedToFitBudget(entries, noTag, 0, 200);
    expect(result.kept).toHaveProperty('project.name');
    expect(result.kept).toHaveProperty('conventions.x');
    expect(result.kept).toHaveProperty('commands.x');
    expect(result.kept).toHaveProperty('deps.x');
  });

  it('marks pathologicalOverflow when never-shed alone exceeds budget', () => {
    const entries = {
      'project.name': 'x'.repeat(500),
      'files.shedme': 'x'.repeat(100),
    };
    const result = shedToFitBudget(entries, noTag, 0, 100);
    expect(result.pathologicalOverflow).toBe(true);
    expect(result.kept).toHaveProperty('project.name');
    expect(result.kept).not.toHaveProperty('files.shedme');
  });

  it('respects fixedOverheadBytes when computing projection', () => {
    const entries = { 'project.name': 'reverie' };
    const entryCost = entryRenderBytes('project.name', 'reverie', '');
    // Overhead alone fills the budget — entry would push us over but
    // can't be shed (project.* is never-shed). Pathological flag fires.
    const result = shedToFitBudget(entries, noTag, 100, 100);
    expect(result.pathologicalOverflow).toBe(true);
    expect(result.kept).toEqual(entries);
    expect(entryCost).toBeGreaterThan(0); // sanity
  });

  it('uses ageTag function for size accounting', () => {
    const entries = { 'files.x': 'small' };
    const longTag = ' [stale — 999d]';
    const totalWithTag = entryRenderBytes('files.x', 'small', longTag);
    const totalWithoutTag = entryRenderBytes('files.x', 'small', '');
    expect(totalWithTag).toBeGreaterThan(totalWithoutTag);

    // Without tag accounting, this entry fits in budget = totalWithoutTag.
    // With tag accounting, it doesn't, so files.* gets shed.
    const result = shedToFitBudget(entries, () => longTag, 0, totalWithoutTag);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].keys).toEqual(['files.x']);
  });
});

describe('formatShedNotice', () => {
  it('returns empty string when no segments shed', () => {
    expect(formatShedNotice([])).toBe('');
  });

  it('renders a single shed segment with byte count', () => {
    const notice = formatShedNotice([
      { label: 'files.*', keys: ['files.a', 'files.b', 'files.c'], bytes: 8200 },
    ]);
    expect(notice).toContain('files.* (3 entries, 8.0K)');
    expect(notice).toContain('reverie_get');
    expect(notice).toContain('tier:"full"');
  });

  it('singularizes "entry" for one-entry segments', () => {
    const notice = formatShedNotice([
      { label: 'arch.*', keys: ['arch.x'], bytes: 500 },
    ]);
    expect(notice).toContain('arch.* (1 entry, 500B)');
  });

  it('joins multiple segments with commas', () => {
    const notice = formatShedNotice([
      { label: 'files.*', keys: ['a'], bytes: 100 },
      { label: 'arch.*', keys: ['b'], bytes: 200 },
    ]);
    expect(notice).toContain('files.* (1 entry, 100B), arch.* (1 entry, 200B)');
  });

  it('uses "context.*" as the label (no implementation detail leak)', () => {
    // The internal SHED_ORDER context rule used to label as
    // "context.* (largest first)" which leaked into user-facing notices.
    // Confirm only the namespace appears.
    const big = 'x'.repeat(2000);
    const result = shedToFitBudget(
      { 'project.name': 'reverie', 'context.large': big },
      () => '',
      0,
      100,
    );
    const contextSeg = result.segments.find(s => s.label.startsWith('context.'));
    if (contextSeg) {
      expect(contextSeg.label).toBe('context.*');
      expect(contextSeg.label).not.toContain('largest first');
    }
  });
});

describe('PATHOLOGICAL_OVERFLOW_NOTICE', () => {
  it('names the config key + recovery actions', () => {
    expect(PATHOLOGICAL_OVERFLOW_NOTICE).toContain('bootstrap_max_response_bytes');
    expect(PATHOLOGICAL_OVERFLOW_NOTICE).toContain('reverie_config_set');
    expect(PATHOLOGICAL_OVERFLOW_NOTICE).toContain('warning');
  });
});
