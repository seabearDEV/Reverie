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

export interface HarnessFingerprint {
  name: string;
  matches: (env: NodeJS.ProcessEnv) => boolean;
  /** Env var the harness exports with its own per-session id (#207). Add one
   *  as each harness's variable is identified; Codex's is not known yet. */
  sessionVar?: string;
}

/** Ordered fingerprint table: first match wins. Best-effort, expandable. */
const FINGERPRINTS: HarnessFingerprint[] = [
  { name: 'claude-code', matches: env => env.CLAUDECODE !== undefined || env.CLAUDE_CODE_ENTRYPOINT !== undefined, sessionVar: 'CLAUDE_CODE_SESSION_ID' },
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

/**
 * The harness whose env fingerprint matches, independent of RVR_AGENT_NAME.
 * An explicit agent name replaces the detected *name*, not the fact that a
 * harness is running — session detection (#207) needs the latter, and the
 * fleet sets RVR_AGENT_NAME on every machine.
 */
export function detectHarness(env: NodeJS.ProcessEnv): HarnessFingerprint | undefined {
  return FINGERPRINTS.find(fp => fp.matches(env));
}

/** Every harness session variable in the table — the test bootstrap scrubs
 *  these so the suite behaves the same inside and outside an agent harness. */
export const HARNESS_SESSION_VARS: readonly string[] =
  FINGERPRINTS.flatMap(fp => (fp.sessionVar ? [fp.sessionVar] : []));

export function deriveAgentIdentity(env: NodeJS.ProcessEnv): AgentIdentity {
  const explicit = env.RVR_AGENT_NAME;
  if (explicit) return { agent: explicit, agentDetected: undefined };
  const harness = detectHarness(env);
  if (harness) return { agent: harness.name, agentDetected: true };
  return { agent: undefined, agentDetected: undefined };
}
