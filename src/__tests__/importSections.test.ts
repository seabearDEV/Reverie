import { describe, it, expect } from 'bun:test';
import { computeImportSections } from '../utils/importSections';
import type { CodexData } from '../types';

const current = {
  entries: () => ({ project: { name: 'existing' } }) as CodexData,
  aliases: () => ({ bn: 'project.name' }),
  confirm: () => ({ 'commands.deploy': true }) as Record<string, true>,
};

describe('computeImportSections — #133 cross-surface contract', () => {
  it('replace with entries-only input leaves aliases and confirm untouched', () => {
    const next = computeImportSections(
      { entries: { 'project.name': 'imported' } },
      false,
      current,
    );
    expect(next.entries).toEqual({ project: { name: 'imported' } } as CodexData);
    // The contract: omitted sections are absent from the payload entirely,
    // never cleared to {} — saveAll treats absent as "don't touch".
    expect('aliases' in next).toBe(false);
    expect('confirm' in next).toBe(false);
  });

  it('replace with aliases-only input leaves entries and confirm untouched', () => {
    const next = computeImportSections(
      { aliases: { short: 'arch.pattern' } },
      false,
      current,
    );
    expect(next.aliases).toEqual({ short: 'arch.pattern' });
    expect('entries' in next).toBe(false);
    expect('confirm' in next).toBe(false);
  });

  it('replace substitutes present sections wholesale', () => {
    const next = computeImportSections(
      { aliases: { other: 'files.map' } },
      false,
      current,
    );
    expect(next.aliases).toEqual({ other: 'files.map' });
  });

  it('merge folds present sections into current state', () => {
    const next = computeImportSections(
      {
        entries: { 'arch.pattern': 'MVC' },
        aliases: { ap: 'arch.pattern' },
      },
      true,
      current,
    );
    expect(next.entries).toEqual({
      project: { name: 'existing' },
      arch: { pattern: 'MVC' },
    } as CodexData);
    expect(next.aliases).toEqual({ bn: 'project.name', ap: 'arch.pattern' });
    expect('confirm' in next).toBe(false);
  });

  it('never loads current state for sections the input omits', () => {
    let loads = 0;
    const counting = {
      entries: () => { loads++; return {} as CodexData; },
      aliases: () => { loads++; return {}; },
      confirm: () => { loads++; return {} as Record<string, true>; },
    };
    computeImportSections({ entries: { k: 'v' } }, false, counting);
    expect(loads).toBe(0);
  });
});
