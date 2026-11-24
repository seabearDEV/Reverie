import { deriveAgentIdentity, detectHarness, HARNESS_SESSION_VARS } from '../utils/agentIdentity';

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

describe('detectHarness (#207)', () => {
  it('matches the fingerprint even when RVR_AGENT_NAME names the agent', () => {
    // The fleet sets RVR_AGENT_NAME on every machine; it replaces the
    // detected name, not the fact that a harness is running.
    const env = { RVR_AGENT_NAME: 'fable', CLAUDECODE: '1' };
    expect(deriveAgentIdentity(env).agent).toBe('fable');
    expect(detectHarness(env)?.name).toBe('claude-code');
  });

  it('carries the session variable for Claude Code', () => {
    expect(detectHarness({ CLAUDE_CODE_ENTRYPOINT: 'cli' })?.sessionVar).toBe('CLAUDE_CODE_SESSION_ID');
  });

  it('has no session variable where the harness has not been identified to export one', () => {
    expect(detectHarness({ CODEX_SANDBOX: 'seatbelt' })?.name).toBe('codex');
    expect(detectHarness({ CODEX_SANDBOX: 'seatbelt' })?.sessionVar).toBeUndefined();
  });

  it('returns undefined on a clean environment', () => {
    expect(detectHarness({ PATH: '/usr/bin' })).toBeUndefined();
  });

  it('lists every session variable, for the test bootstrap to scrub', () => {
    expect([...HARNESS_SESSION_VARS]).toEqual(['CLAUDE_CODE_SESSION_ID']);
    // _setup.ts has already scrubbed it from this process.
    expect(process.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });
});
