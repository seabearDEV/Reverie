import type { Mock } from 'bun:test';
import { DEFAULT_LLM_INSTRUCTIONS, getCustomInstructions, getEffectiveInstructions } from '../llm-instructions';

vi.mock('../storage', () => ({
  getValue: vi.fn(),
}));

import { getValue } from '../storage';
const mockedGetValue = getValue as Mock<typeof getValue>;

describe('llm-instructions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCustomInstructions', () => {
    it('returns undefined when no value is set', () => {
      mockedGetValue.mockReturnValue(undefined);
      expect(getCustomInstructions()).toBeUndefined();
    });

    it('returns the string value when set', () => {
      mockedGetValue.mockReturnValue('custom instructions');
      expect(getCustomInstructions()).toBe('custom instructions');
    });

    it('returns undefined for non-string values', () => {
      mockedGetValue.mockReturnValue(42);
      expect(getCustomInstructions()).toBeUndefined();
    });

    it('returns undefined when getValue throws', () => {
      mockedGetValue.mockImplementation(() => { throw new Error('storage error'); });
      expect(getCustomInstructions()).toBeUndefined();
    });
  });

  describe('getEffectiveInstructions', () => {
    it('returns defaults when no custom instructions are set', () => {
      mockedGetValue.mockReturnValue(undefined);
      const result = getEffectiveInstructions();
      expect(result).toBe(DEFAULT_LLM_INSTRUCTIONS);
    });

    it('appends custom instructions as PROJECT CONTEXT block', () => {
      mockedGetValue.mockReturnValue('Always check arch.modules first');
      const result = getEffectiveInstructions();
      expect(result).toBe(`${DEFAULT_LLM_INSTRUCTIONS}\n\nPROJECT CONTEXT:\nAlways check arch.modules first`);
    });

    it('returns defaults when custom value is a non-string type', () => {
      mockedGetValue.mockReturnValue(123);
      const result = getEffectiveInstructions();
      expect(result).toBe(DEFAULT_LLM_INSTRUCTIONS);
    });

    it('includes the separator and header before custom text', () => {
      mockedGetValue.mockReturnValue('my context');
      const result = getEffectiveInstructions();
      expect(result).toContain('\n\nPROJECT CONTEXT:\n');
      expect(result).toContain('my context');
    });
  });
});
