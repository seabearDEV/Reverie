/**
 * Agent attribution (#138). RVR_AGENT_NAME is the explicit, per-harness
 * identity (fleet policy: 'fable' = Claude Code, 'sol' = Codex) — but it has
 * to be re-configured on every machine and silently fails open to
 * unattributed (the cross-machine dataset showed a whole machine of
 * unattributed rows). When it is unset, fall back to detecting the harness
 * from env fingerprints. Detected identities are generic harness names, not
 * fleet pet names, and rows carry agentDetected:true so downstream consumers
 * know the confidence level.
 */

export interface AgentIdentity {
  agent: string | undefined;
  /** True when agent came from env fingerprinting, absent when explicit. */
  agentDetected: true | undefined;
}

/** Ordered fingerprint table: first match wins. Best-effort, expandable. */
const FINGERPRINTS: { name: string; matches: (env: NodeJS.ProcessEnv) => boolean }[] = [
  { name: 'claude-code', matches: env => env.CLAUDECODE !== undefined || env.CLAUDE_CODE_ENTRYPOINT !== undefined },
  { name: 'codex', matches: env => Object.keys(env).some(k => k.startsWith('CODEX_')) },
  { name: 'cursor', matches: env => env.CURSOR_TRACE_ID !== undefined || Object.keys(env).some(k => k.startsWith('CURSOR_AGENT')) },
  { name: 'copilot', matches: env => Object.keys(env).some(k => k.startsWith('COPILOT_AGENT')) },
  { name: 'gemini', matches: env => env.GEMINI_CLI !== undefined },
  { name: 'aider', matches: env => Object.keys(env).some(k => k.startsWith('AIDER_')) },
];

let cached: AgentIdentity | undefined;

export function resolveAgentIdentity(): AgentIdentity {
  if (cached) return cached;
  cached = deriveAgentIdentity(process.env);
  return cached;
}

/** Reset the per-process cache. Used by tests that mutate process.env. */
export function clearAgentIdentityCache(): void {
  cached = undefined;
}

export function deriveAgentIdentity(env: NodeJS.ProcessEnv): AgentIdentity {
  const explicit = env.RVR_AGENT_NAME;
  if (explicit) return { agent: explicit, agentDetected: undefined };
  for (const fp of FINGERPRINTS) {
    if (fp.matches(env)) return { agent: fp.name, agentDetected: true };
  }
  return { agent: undefined, agentDetected: undefined };
}
