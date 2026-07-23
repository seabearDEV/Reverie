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

  it('returns unattributed on a clean environment', () => {
    const id = deriveAgentIdentity({ PATH: '/usr/bin', HOME: '/home/u' });
    expect(id.agent).toBeUndefined();
    expect(id.agentDetected).toBeUndefined();
  });
});
