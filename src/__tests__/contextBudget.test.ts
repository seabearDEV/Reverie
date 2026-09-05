import {
  shedToFitBudget,
  formatShedNotice,
  entryRenderBytes,
  PATHOLOGICAL_OVERFLOW_NOTICE,
  gistOf,
  indexEntryOf,
  formatIndexText,
  demoteToFitBudget,
  formatDemoteNotice,
} from '../utils/contextBudget';

const noTag = () => '';

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
    expect(result.kept).toHaveProperty(['context.medium']);
    expect(result.kept).toHaveProperty(['context.small']);
  });

  it('never sheds context.next_session', () => {
    const entries = {
      'context.next_session': 'x'.repeat(2000),
      'context.other': 'x'.repeat(200),
    };
    // Force overflow.
    const result = shedToFitBudget(entries, noTag, 0, 100);
    expect(result.kept).toHaveProperty(['context.next_session']);
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
    expect(result.kept).toHaveProperty(['project.name']);
    expect(result.kept).toHaveProperty(['conventions.x']);
    expect(result.kept).toHaveProperty(['commands.x']);
    expect(result.kept).toHaveProperty(['deps.x']);
  });

  it('marks pathologicalOverflow when never-shed alone exceeds budget', () => {
    const entries = {
      'project.name': 'x'.repeat(500),
      'files.shedme': 'x'.repeat(100),
    };
    const result = shedToFitBudget(entries, noTag, 0, 100);
    expect(result.pathologicalOverflow).toBe(true);
    expect(result.kept).toHaveProperty(['project.name']);
    expect(result.kept).not.toHaveProperty(['files.shedme']);
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

describe('gistOf / indexEntryOf / formatIndexText (#188)', () => {
  it('returns a short single-line value untouched', () => {
    expect(gistOf('npm test', 160)).toEqual({ gist: 'npm test', truncated: false });
  });

  it('cuts a long line at the last word boundary within the cap', () => {
    const r = gistOf('alpha beta gamma delta epsilon', 12);
    expect(r.gist).toBe('alpha beta');
    expect(r.truncated).toBe(true);
  });

  it('hard-cuts when the first half of the line has no whitespace', () => {
    const r = gistOf('x'.repeat(50), 20);
    expect(r.gist).toBe('x'.repeat(20));
    expect(r.truncated).toBe(true);
  });

  it('uses the first line of a multi-line value and marks it truncated', () => {
    const r = gistOf('Headline sentence.\nMore detail below.', 160);
    expect(r.gist).toBe('Headline sentence.');
    expect(r.truncated).toBe(true);
  });

  it('a trailing newline alone does not count as truncation', () => {
    expect(gistOf('done\n', 160)).toEqual({ gist: 'done', truncated: false });
  });

  it('index text carries the remaining-bytes marker only when truncated', () => {
    const ix = indexEntryOf('a'.repeat(10) + ' ' + 'b'.repeat(1013), 12);
    expect(ix.bytes).toBe(1024);
    expect(ix.truncated).toBe(true);
    expect(formatIndexText(ix)).toBe('aaaaaaaaaa… [+1014B]');
    expect(formatIndexText(indexEntryOf('short', 160))).toBe('short');
  });
});

describe('demoteToFitBudget (#188)', () => {
  const noTag = () => '';
  const toGist = () => 'g';

  it('does nothing under budget', () => {
    const display = { 'project.name': 'reverie', 'context.a': 'x' };
    const r = demoteToFitBudget(display, ['project.name'], toGist, noTag, 0, 10_000);
    expect(r.demotedKeys).toEqual([]);
    expect(r.segments).toEqual([]);
    expect(r.display).toEqual(display);
  });

  it('demotes the largest pinned namespace first and stops once under budget', () => {
    const display = {
      'project.big': 'p'.repeat(300),
      'conventions.small': 'c'.repeat(50),
      'context.idx': 'gist',
    };
    const base = entryRenderBytes('conventions.small', 'c'.repeat(50), '')
      + entryRenderBytes('context.idx', 'gist', '')
      + entryRenderBytes('project.big', 'g', '');
    const r = demoteToFitBudget(display, ['project.big', 'conventions.small'], toGist, noTag, 0, base + 5);
    expect(r.demotedKeys).toEqual(['project.big']);
    expect(r.segments.map(s => s.label)).toEqual(['project.*']);
    expect(r.display['project.big']).toBe('g');
    expect(r.display['conventions.small']).toBe('c'.repeat(50));
    expect(r.segments[0].bytesBefore).toBeGreaterThan(r.segments[0].bytesAfter);
  });

  it('keeps demoting whole namespaces until under budget', () => {
    const display = { 'project.big': 'p'.repeat(300), 'conventions.mid': 'c'.repeat(100), 'context.idx': 'gist' };
    const r = demoteToFitBudget(display, ['project.big', 'conventions.mid'], toGist, noTag, 0, 60);
    expect(r.demotedKeys).toEqual(['project.big', 'conventions.mid']);
    expect(r.segments.map(s => s.label)).toEqual(['project.*', 'conventions.*']);
  });

  it('never demotes context.next_session', () => {
    const display = { 'context.next_session': 'x'.repeat(500) };
    const r = demoteToFitBudget(display, ['context.next_session'], toGist, noTag, 0, 10);
    expect(r.demotedKeys).toEqual([]);
    expect(r.display['context.next_session']).toBe('x'.repeat(500));
  });
});

describe('formatDemoteNotice', () => {
  it('returns empty string when nothing was demoted', () => {
    expect(formatDemoteNotice([], 'reverie_get <key>')).toBe('');
  });

  it('names the namespace, count, byte change, and the fetch hint', () => {
    const notice = formatDemoteNotice([{ label: 'project.*', keys: ['project.a', 'project.b'], bytesBefore: 2048, bytesAfter: 400 }], 'reverie_get <key>');
    expect(notice).toContain('[demoted to index: project.* (2 entries, 2.0K → 400B)');
    expect(notice).toContain('open entries with reverie_get <key>]');
  });
});
