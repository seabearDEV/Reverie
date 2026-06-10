export const meta = {
  name: 'security-audit',
  description: 'Whole-repo security audit across Reverie attack surfaces with adversarial verification',
  whenToUse: 'Run before each minor release and after any change to the exec/interpolation/import surfaces. Advisory gate (Leg B) — see docs/security/release-process.md.',
  phases: [
    { title: 'Audit', detail: 'one auditor per attack surface' },
    { title: 'Verify', detail: 'adversarially refute each finding' },
  ],
}

// Reverie's threat model is unusual — stores ship inside cloned repos and
// entries are agent-trusted instructions — so generic scanners (Dependabot,
// CodeQL) under-serve it. This audit reasons from that threat model. Keep it
// in sync with new surfaces and any new incident class.
const THREAT_MODEL = `THREAT MODEL for Reverie (a CLI + MCP knowledge store):
- A cloned repo can ship a HOSTILE .reverie/ store. Entries are agent-trusted instructions and stored shell commands.
- The CLI is a first-class agent surface (#117) invoked NON-INTERACTIVELY (no TTY, piped stdin) by agents and CI.
- rvr run <key> executes stored commands via shell; \${key} interpolates values, $(key) executes stored commands (OPT-IN since v1.2.1: only the run-execution path may execute exec refs). --confirm is the documented tripwire for dangerous entries.
- KNOWN INCIDENT CLASSES (regressions here are high-priority): (1) exec-on-read RCE — $(key) executing as a side effect of value substitution on read/dry/preview paths (v1.2.0, fixed v1.2.1); (2) prototype pollution — obj[userKey]++ on a plain object via __proto__ telemetry namespace; (3) transitive dep advisory.

RULES:
- Env vars and CLI flags are TRUSTED inputs (attacker cannot set them in a secure environment). Untrusted inputs are: store entry contents/keys, imported files/packs, MCP tool params from a client, file contents in a cloned repo.
- EXCLUDE: generic DOS / resource exhaustion, secrets-at-rest, rate limiting, ReDoS, regex injection, log spoofing, outdated-dependency findings, theoretical races.
- Only report HIGH/MEDIUM with a concrete attack path from one of the untrusted inputs above. Read the actual code; do not speculate.`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    surface: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string' },
          description: { type: 'string' },
          exploit: { type: 'string', description: 'concrete attack path from an untrusted input' },
          fix: { type: 'string' },
        },
        required: ['title', 'file', 'line', 'severity', 'category', 'description', 'exploit', 'fix'],
      },
    },
  },
  required: ['surface', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isReal: { type: 'boolean' },
    confidence: { type: 'number', description: '1-10' },
    adjustedSeverity: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    reasoning: { type: 'string' },
  },
  required: ['isReal', 'confidence', 'adjustedSeverity', 'reasoning'],
}

const SURFACES = [
  {
    key: 'exec-interpolation',
    files: 'src/utils/interpolate.ts, src/commands/entries.ts (the run handler, confirm flow, promptAndEncrypt)',
    focus: `Stored-command execution and interpolation. Trace: stored entry value -> interpolate() -> execSync/spawnSync with shell.
REGRESSION WATCH (the v1.2.0 read=RCE): $(key) exec resolution must stay OPT-IN. interpolate() must default to NOT executing (allowExec=false, leaves $(key) literal); only interpolateExec() — called solely on the run-execution path, past the dry/confirm gate — may execute. Confirm NO read/list/json/lint/dry/preview path executes, and that --confirm propagates to keys reached through interpolation.
Also examine: backslash-escape parsing for \${} and $() (can an escape be smuggled?), exec cache poisoning, encrypted-value bypass, the --source shell-eval wrapper path, MAX_DEPTH/cycle guards, the non-TTY confirm fail-closed behavior.`,
  },
  {
    key: 'import-export',
    files: 'src/commands/data-management.ts, plus any export/import helpers it calls',
    focus: `Importing a hostile file/pack into the store and exporting. Examine: path traversal in output/input file paths, the $reverie envelope parser, key-name validation on imported entries (can an imported key be __proto__/constructor/prototype, or contain path separators that escape the file-per-entry layout?), non-string-leaf rejection, decompression/transactional apply. The store is file-per-entry (key -> key.json) — can a crafted key name write outside the store dir? NOTE: pack install (#115) is blocked on import-integrity design — re-audit when it lands.`,
  },
  {
    key: 'mcp-params',
    files: 'src/mcp-server.ts (tool handlers, scope resolution, audit/telemetry wrapper)',
    focus: `External MCP client params reaching store/exec operations. Examine: param validation before use, whether any handler reaches the exec path, prototype-pollution via param-derived object keys (obj[param]++ or obj[param]=... on plain objects — the d773c4d incident class), aliasResolved capture, scope resolution letting a client write outside intended store.`,
  },
  {
    key: 'store-paths',
    files: 'src/store.ts, src/storage.ts, src/utils/paths.ts, src/utils/directoryStore.ts',
    focus: `Store load, path resolution, atomic writes, migration. Examine: RVR_DATA_DIR/project resolution producing a path-traversal or write-outside-store, the file-per-entry key->filename mapping (key sanitization — can a key with ../ or / escape?), prototype pollution when reconstituting nested objects from flat keys (setNested/objectPath on __proto__), migration tmp-dir rename safety, scanAndSync.`,
  },
]

phase('Audit')
const results = await pipeline(
  SURFACES,
  (s) => agent(
    `${THREAT_MODEL}\n\nYou are auditing the "${s.key}" attack surface of Reverie. Read these files in full and reason about data flow:\n${s.files}\n\nFOCUS:\n${s.focus}\n\nRead the actual source (Read/Grep). Report only concrete HIGH/MEDIUM vulnerabilities with a real attack path from an untrusted input. Set surface to "${s.key}". If you find nothing real, return an empty findings array — do not pad.`,
    { label: `find:${s.key}`, phase: 'Audit', schema: FINDINGS_SCHEMA },
  ),
  (review, surface) => parallel((review?.findings ?? []).map((f) => () =>
    agent(
      `${THREAT_MODEL}\n\nAdversarially VERIFY this claimed vulnerability in Reverie. Your job is to REFUTE it. Read the actual code at the cited location before deciding. Default to isReal=false if the attack path is not concrete, relies on a trusted input (env var/CLI flag), or the code already guards against it.\n\nCLAIM:\nTitle: ${f.title}\nFile: ${f.file}:${f.line}\nSeverity: ${f.severity}\nCategory: ${f.category}\nDescription: ${f.description}\nClaimed exploit: ${f.exploit}\n\nVerify on two lenses: (1) CORRECTNESS — does the code actually do what the claim says? (2) REACHABILITY — is there a concrete path from an untrusted input (store/import/MCP param/cloned-repo file), not a trusted env var or flag? Give confidence 1-10. Only confidence >=8 with a concrete path should be isReal=true.`,
      { label: `verify:${surface.key}:${(f.file || '').split('/').pop()}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({ ...f, verdict: v })),
  )),
)

const all = results.flat().filter(Boolean)
const confirmed = all.filter((f) => f.verdict && f.verdict.isReal && f.verdict.confidence >= 8)
const rejected = all.filter((f) => !(f.verdict && f.verdict.isReal && f.verdict.confidence >= 8))

log(`audit complete: ${all.length} raw findings, ${confirmed.length} confirmed (conf>=8), ${rejected.length} rejected`)

return {
  confirmed: confirmed.map((f) => ({ title: f.title, file: `${f.file}:${f.line}`, severity: f.verdict.adjustedSeverity, category: f.category, description: f.description, exploit: f.exploit, fix: f.fix, confidence: f.verdict.confidence })),
  rejected: rejected.map((f) => ({ title: f.title, file: `${f.file}:${f.line}`, claimedSeverity: f.severity, whyRejected: f.verdict ? f.verdict.reasoning : 'no verdict', confidence: f.verdict ? f.verdict.confidence : 0 })),
}
