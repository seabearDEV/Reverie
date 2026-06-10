# Reverie security process

Three legs. Automated scanning is the floor; the agentic audit catches the
design-class vulns scanners miss; release integrity ensures what ships is what
was reviewed. Scanning is scheduled; **patching is event-driven** (see
`project.patchPolicy` in the store).

Why bespoke: Reverie's threat model is unusual — `.reverie/` stores ship inside
cloned repos and entries are *agent-trusted instructions*, so a malicious entry
is code execution (or prompt injection) with a persistence layer. Generic
scanners reason about dependency CVEs and tainted sinks; they do not reason
about "should a *read* be able to execute." The v1.2.0 read=RCE proved this — it
was found by the agentic audit, not a scanner.

## Leg A — Continuous automation (the floor)

Tracked by [#131](https://github.com/seabearDEV/reverie/issues/131). Always-on,
cheap, catches known classes and regressions:

- **Dependabot** alerts + security updates.
- **`bun audit`** weekly CI cron (fails on new advisories).
- **CodeQL** weekly (free for public repos).
- **Regression tests as permanent tripwires**: every confirmed vulnerability
  gets a test that encodes the exploit. Existing: `safe interpolate() never
  executes $(key)` (interpolate.test), `exec-ref safety` (mcp-advanced), the
  inverted `get does NOT execute` (commands.test), and the non-TTY confirm
  fail-closed test. A future refactor that re-opens a fixed vuln fails CI.

Note: no npm publishing (`project.distributionChannels`), so npm supply-chain
exposure is limited to the dev/build dependency tree, not a published artifact.

## Leg B — Agentic adversarial audit (advisory gate)

The `security-audit` workflow (`.claude/workflows/security-audit.js`) fans out
one auditor per attack surface under Reverie's threat model, then adversarially
verifies every finding (refute-by-default, confidence ≥ 8 to confirm). Run it:

- **Before every minor release.**
- **After any change to the exec / interpolation / import surfaces.**

It is an **advisory gate**: run it, triage every confirmed finding, but it does
not hard-block the release. Confirmed findings either get fixed before release
or are explicitly accepted with a rationale. Surfaces audited: exec/interpolation,
import/export, MCP params, store/path resolution. Keep the threat model and
surface list in the workflow current as the code grows.

## Leg C — Release integrity

Scanning the code is moot if the wrong commit ships. The v1.2.1 release nearly
shipped a stale tag (`context.releaseTagStaleLocal`). Before a release is
considered done:

1. **Verify the tag commit.** `git rev-parse vX.Y.Z` must equal the intended
   `main` commit. A pre-existing local tag ("tag already exists") is a STOP
   signal — never push a release tag without confirming its SHA.
2. **Confirm the workflow built the right commit.** The release run's `headSha`
   must match.
3. **Smoke-test the shipped binary.** Download the published artifact and run
   the regression exploit against it (e.g. a `$(key)` in a read value must not
   execute; `run --yes` must). `--version` alone is insufficient — exercise real
   runtime behavior (`context.bunCompileGotchas`).
4. **Confirm propagation.** Release published (not draft), all binaries
   attached, Homebrew tap bumped.

## Disclosure

For a sole-maintainer project we skip embargo/coordination (no third-party users
to protect in the fix window) but still publish a GitHub Security Advisory
alongside the patch — it is the honest public record and a procurement asset.
Critical/high → out-of-band patch immediately; moderate/low → next themed minor.
