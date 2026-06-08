import type { Mock } from 'bun:test';
import { DEFAULT_LLM_INSTRUCTIONS, CLI_LLM_INSTRUCTIONS, getCustomInstructions, getEffectiveInstructions } from '../llm-instructions';

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

  // #117 WS2: surface-aware instructions.
  describe('surface-aware instructions', () => {
    it('defaults to the MCP surface', () => {
      mockedGetValue.mockReturnValue(undefined);
      expect(getEffectiveInstructions()).toBe(DEFAULT_LLM_INSTRUCTIONS);
      expect(getEffectiveInstructions('mcp')).toBe(DEFAULT_LLM_INSTRUCTIONS);
    });

    it('returns the CLI blob for the cli surface', () => {
      mockedGetValue.mockReturnValue(undefined);
      expect(getEffectiveInstructions('cli')).toBe(CLI_LLM_INSTRUCTIONS);
    });

    it('CLI instructions reference rvr/--json, not "PREFER MCP TOOLS"', () => {
      // The whole point of #117: a CLI agent cannot reach MCP tools.
      expect(CLI_LLM_INSTRUCTIONS).toContain('rvr');
      expect(CLI_LLM_INSTRUCTIONS).toContain('--json');
      expect(CLI_LLM_INSTRUCTIONS).toContain('rvr manifest');
      expect(CLI_LLM_INSTRUCTIONS).not.toContain('PREFER MCP TOOLS');
    });

    it('appends custom context to the CLI surface too', () => {
      mockedGetValue.mockReturnValue('cli-specific note');
      const result = getEffectiveInstructions('cli');
      expect(result).toBe(`${CLI_LLM_INSTRUCTIONS}\n\nPROJECT CONTEXT:\ncli-specific note`);
    });
  });
});
