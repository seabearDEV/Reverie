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

- **`bun audit`** weekly CI cron (`security-scan.yml`): the only scan that sees
  the whole dependency tree. It fails on any known advisory and opens an issue
  titled "Security scan: bun audit reports advisories", or comments on the open
  one; a green run on main closes it. It failed every week from its first run
  until #236 and nobody saw it — read the issue, not the tab.
- **Dependabot** version updates (weekly PRs). Its *alerts* do not cover this
  tree: GitHub's dependency graph does not read `bun.lock`, so it sees only
  `package.json`'s direct dependencies as ranges, and the Security tab's
  Dependabot list stays empty whatever the lockfile holds.
- **CodeQL** weekly (free for public repos).
- **Regression tests as permanent tripwires**: every confirmed vulnerability
  gets a test that encodes the exploit. Existing: `safe interpolate() never
  executes $(key)` (interpolate.test), `exec-ref safety` (mcp-advanced), the
  inverted `get does NOT execute` (commands.test), and the non-TTY confirm
  fail-closed test. A future refactor that re-opens a fixed vuln fails CI.

- **End-to-end fuzzer for the run gate** (`scripts/gate-fuzz/`, README there;
  `gate-fuzz.yml`). It drives the built CLI and MCP server through random
  two-store worlds, and every generated command writes a marker to a log. An
  invocation fails the check when it was not approved and ran a command the
  documented rules say it must ask about. Not approved means a CLI run without
  `--yes`, or an MCP call without `force` and without a valid
  `confirm_token`. The rules come from the fuzzer's own model, never from `src/`. It also
  checks:
  - that a global-scope run never runs a project entry;
  - that reads never execute;
  - that refused or failed commands leave both stores unchanged, with an even
    epoch and no lock;
  - that no command other than `confirm remove` or `set --no-confirm` removes
    a flag;
  - that an approved canary run logs its marker in every world, so a build
    whose runs the fuzzer cannot see fails instead of passing.

  It needs one build. CI runs the quick mode on every pull request that
  touches `src/` or the fuzzer, and the long mode weekly. Locally,
  `bun run fuzz:gate` takes about 3 minutes and `bun run fuzz:gate:long`
  about 30. Before a minor release, the long mode must be green on the
  release commit: run it, or point to that commit's weekly run. A violation
  prints a one-line replay and a shrunk world. A scratch version of it, used
  in a review, found #289, a gate bypass that the differential check below
  did not see (#290). This one reproduces #289, #280 and both halves of #279
  (an alias named after a flagged key, and a flagged chain entry) on a build
  from before their fix.
- **Differential check for the run gate** (`scripts/gate-differential/`, README
  there). A change to how `rename`, `remove` or `confirm set` touch the
  confirmation list has to keep every entry the previous build gates gated.
  The scripts run the same random command sequences through both builds and
  compare what each gates. Run it before merging such a change. It is not in
  CI: it needs two builds and takes minutes. It found three regressions in
  #234 that tests, mutation checks and the author's own review had passed.

  **Blind spot (#290):** it evaluates the gate by rebuilding the gate
  expression from the build's shared modules. It never runs the code that
  decides a run (`runKeys`, `runGated`), and it covers no chains and no MCP.
  It reported 0 hits against a build whose reference gate was a no-op. Use it
  for list changes; the fuzzer above is the check on the run gate itself.

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
