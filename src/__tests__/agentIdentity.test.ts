import { deriveAgentIdentity } from '../utils/agentIdentity';

describe('deriveAgentIdentity (#138)', () => {
  it('explicit RVR_AGENT_NAME always wins over fingerprints', () => {
    const id = deriveAgentIdentity({ RVR_AGENT_NAME: 'fable', CLAUDECODE: '1' });
    expect(id.agent).toBe('fable');
    expect(id.agentDetected).toBeUndefined();
  });

  it('detects Claude Code from CLAUDECODE', () => {
    const id = deriveAgentIdentity({ CLAUDECODE: '1' });
    expect(id.agent).toBe('claude-code');
    expect(id.agentDetected).toBe(true);
  });

  it('detects Codex from CODEX_* vars', () => {
    const id = deriveAgentIdentity({ CODEX_SANDBOX: 'seatbelt' });
    expect(id.agent).toBe('codex');
    expect(id.agentDetected).toBe(true);
  });

  it('detects the remaining fingerprint table entries', () => {
    expect(deriveAgentIdentity({ CURSOR_TRACE_ID: 'abc' }).agent).toBe('cursor');
    expect(deriveAgentIdentity({ CURSOR_AGENT_MODE: '1' }).agent).toBe('cursor');
    expect(deriveAgentIdentity({ COPILOT_AGENT_ID: 'x' }).agent).toBe('copilot');
    expect(deriveAgentIdentity({ GEMINI_CLI: '1' }).agent).toBe('gemini');
    expect(deriveAgentIdentity({ AIDER_MODEL: 'gpt' }).agent).toBe('aider');
  });

  it('returns unattributed on a clean environment', () => {
    const id = deriveAgentIdentity({ PATH: '/usr/bin', HOME: '/home/u' });
    expect(id.agent).toBeUndefined();
    expect(id.agentDetected).toBeUndefined();
  });
});
