# Release Checklist

Manual steps for cutting a new Reverie release. Follow these in order.

## Pre-tag verification

Before tagging, run the full quality bar (Bun-only runtime — there is no `check` script, run the three steps):

```bash
bun run build && bun run lint && bun run test
```

All of the following must be true:

- [ ] `tsc` produces no errors (`bun run build`)
- [ ] `eslint src/` produces no errors (`bun run lint`)
- [ ] Full test suite passes (`bun run test`)
- [ ] `git status` is clean (no uncommitted work)
- [ ] You're on `main` and synced with `origin/main`
- [ ] All issues in the milestone are CLOSED via merged PRs
- [ ] Minor release: the security audit has run (`/security-audit`) and every confirmed finding is fixed or explicitly accepted. It is an advisory gate, not a hard block — see [security/release-process.md](security/release-process.md), Leg B

```bash
VERSION=X.Y.Z   # the version being released — package.json is not bumped yet
gh api repos/seabearDEV/reverie/milestones --jq '.[] | "\(.open_issues) open  \(.title)"' | grep " v$VERSION"
# expect exactly one line, reading "0 open"
```

Milestone titles carry the theme (`v1.4.0 — Forum`), and `gh issue list --milestone` matches the whole title: given a bare `v1.4.0` it prints nothing and exits 0, which reads as a pass. In the command above, no line means no milestone matched the version, and two lines mean a second milestone shares it — settle that before tagging. To see what is open: `gh issue list --milestone "<full title>" --state open`.

## CHANGELOG header

The `[Unreleased]` block at the top of `CHANGELOG.md` becomes the new release section, and a fresh empty `[Unreleased]` block goes above it.

```diff
- ## [Unreleased]
+ ## [Unreleased]
+
+ ## [<NEW_VERSION>] - <YYYY-MM-DD>
```

Verify the section has at most one `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security` subsection (per Keep a Changelog). If the section accumulated duplicates from multiple PRs, merge them before tagging.

## Version bump

```bash
# Edit package.json: "version": "X.Y.Z" → "X.Y+1.0" (or appropriate)
# bun.lock records no root version, so a version-only bump needs no `bun install`.
git add package.json CHANGELOG.md
git commit -m "chore: release vX.Y.Z"
git push origin main
```

## Tag and release

The release alias (`commands.release` in Reverie) handles this:

```bash
git push origin main && \
  VERSION=`bun -p "require('./package.json').version"` && \
  git tag "v$VERSION" && \
  git push origin "v$VERSION" && \
  echo "🚀 Released v$VERSION"
```

CI will pick up the tag and build/publish artifacts.

**Release integrity** ([security/release-process.md](security/release-process.md), Leg C). A release tag that already exists locally is a stop signal: check `git tag -l "v$VERSION"` is empty before tagging. After pushing, confirm `git rev-parse "v$VERSION"` equals the intended `main` commit and that the workflow run built that SHA.

## Post-tag manual smoke

After CI publishes, do these manual checks against the released binary — the published artifact, not a local build. `--version` alone proves little about a compiled binary; exercise real behaviour: the blocks below write to a store, run the exec-on-read regression and call the MCP server. The exact commands beyond that depend on what's in the release — fill in the per-release section below.

Run everything that writes in a scratch project, not in this repo: the smoke entries would land in the committed store, and outside any project an unscoped write is refused (#99).

### Generic smoke (every release)

```bash
cd "$(mktemp -d)" && rvr init   # the scratch project
rvr --version          # prints the new version
rvr info               # data path, config path, completions status
rvr set smoke.test "hello"
rvr get smoke.test     # → smoke.test: hello
rvr get smoke.test -p  # plain output, no ANSI codes
rvr find smoke         # finds the entry
rvr remove smoke.test -f
rvr context            # shows project context summary
```

### Exec-on-read regression (every release)

[security/release-process.md](security/release-process.md), Leg C step 3: a read must never execute, and `run --yes` must. In the same scratch project — single quotes, because `$(key)` is Reverie's syntax, not the shell's:

```bash
rvr set smoke.exec 'touch /tmp/rvr-smoke-marker'
rvr set smoke.read 'read $(smoke.exec)'
rvr get smoke.read -p        # → read $(smoke.exec), printed as stored
ls /tmp/rvr-smoke-marker     # → No such file or directory: the read did not execute
rvr set smoke.run 'echo ran $(smoke.exec)'
rvr run smoke.run --yes      # → ran
ls /tmp/rvr-smoke-marker     # → the file is there: run --yes executed
rm /tmp/rvr-smoke-marker
```

### MCP server smoke

```bash
# The released binary's MCP server answers a bare tools/list with one JSON line naming the reverie_* tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | rvr mcp-server
```

### Homebrew tap (stable releases)

The Release workflow's **Update Homebrew Tap** job bumps `Formula/rvr.rb` in `seabearDEV/homebrew-reverie`. It needs the `HOMEBREW_TAP_TOKEN` repo secret (a PAT with `contents:write` on the tap) to be valid.

- [ ] The workflow's "Update Homebrew Tap" job succeeded, and `brew update && brew upgrade rvr` installs the new version.
- **If it failed with `Bad credentials`**, the token expired. Rotate it (`gh secret set HOMEBREW_TAP_TOKEN --repo seabearDEV/Reverie`) and re-run just that job: `gh run rerun <run-id> --failed`. Manual fallback (you need push access to the tap): regenerate `Formula/rvr.rb` from the `release.yml` template with the new `version` and the release assets' `.digest` SHA256s (`gh api repos/seabearDEV/reverie/releases/tags/vX.Y.Z --jq '.assets[]|{name,digest}'`), then push.

### Per-release breaking changes

For releases with breaking changes, exercise each one explicitly to confirm
the deprecation/error fires.

#### v1.11.0

- [ ] `rvr get foo --raw` errors with "unknown option" (the deprecated `--raw` was removed)
- [ ] `rvr get foo -p` works (the new `-p` short for `--plain`)
- [ ] `rvr context -p` works (same)
- [ ] `rvr stats -d` errors with "unknown option" (moved to `-D`)
- [ ] `rvr stats -D` works (the new short for `--detailed`)
- [ ] `rvr stats -j` works (newly-added consistency short for `--json`)
- [ ] `RVR_DATA_DIR=./relative rvr info` errors with "must be an absolute path"
- [ ] `RVR_DATA_DIR=/tmp/rvr-test rvr info` shows `(RVR_DATA_DIR)` annotation on the Data line
- [ ] `rvr get -a` and `rvr rename -a foo bar` and `rvr remove -a foo` still work (legacy back-compat) but don't appear in `rvr get --help`

#### v1.14.0

- [ ] `cd /tmp && RVR_NO_PROJECT=1 rvr set foo bar` refuses with `PROJECT_UNRESOLVED`-shaped error including resolver-chain diagnostic and recovery actions (#99)
- [ ] `RVR_BOOTSTRAP_MAX_BYTES=500 rvr context -p` (in a populated repo) prepends a `[trimmed: …]` notice naming `files.*` / `arch.*` / `context.*` with byte counts; if even after shedding it's still over budget, prepends a second `[warning: reverie_context payload still exceeds budget …]` notice with the expanded never-shed list (#100)
- [ ] `RVR_BOOTSTRAP_MAX_BYTES=500 rvr context -p --tier full` (in the same repo) bypasses the shed entirely — no trimmed notice, full payload renders (#100)
- [ ] `rvr config set bootstrap_max_response_bytes 102400` accepts the value; `rvr config get bootstrap_max_response_bytes` returns it; an invalid value (negative, non-integer) is rejected with a clear error
- [ ] (manual via MCP client) Three `reverie_set` calls to the same key within 30 minutes — third response includes a `warning:` line naming the count and time-since-first-write (#101)

#### v1.1.0

- [ ] `rvr --json get <existing-key>` nests the value under `result` (D3 break — was a bare value/object before 1.1.0); `rvr get <key> --json` still works via the local flag
- [ ] `rvr --json get missing.key` → envelope with `ok:false`, `error.code:"NOT_FOUND"`, and exit code 1
- [ ] `RVR_OUTPUT=json rvr set k v -G` emits a single envelope on stdout (session-wide JSON mode)
- [ ] `rvr --json manifest` → `result.mcpToolMap` has 20 tools (19 before #213 added `reverie_config_unset`) and `result.envelope.version` is `"1"`
- [ ] `rvr config llm-instructions --surface cli` contains no "PREFER MCP TOOLS" and names `rvr` commands
- [ ] `rvr init` (in a temp dir) writes both `CLAUDE.md` and `AGENTS.md`; `rvr init --no-agents` skips `AGENTS.md`
- [ ] `rvr --json run <confirm-entry>` (no `--yes`) → `ok:false`, `error.code:"REQUIRES_CONFIRMATION"`, command in `error.preview`

#### v1.4.0

The bootstrap changed shape on both surfaces, and on a shell machine the MCP server gets no everyday use — exercise `reverie_context` through an MCP client, not only the CLI. Extend this list with the behaviour of anything merged after it was written. The read lines want a populated repo (this one); the lines that write want the scratch project.

- [ ] `rvr context -p` (in a populated repo): the handoff banner is the first thing printed; the pinned namespaces (`project.*`, `commands.*`, `conventions.*`) render in full when they fit the budget; every other entry is one line, a gist ending in `… [+84B]`-style when it was cut; the last line is `[tier: standard (N entries: X in full, Y indexed) — open an entry with rvr get <key>, or use --tier full for everything]` (#188). In this repo `project.*` alone is larger than the default budget leaves room for, so with a default config expect it as index lines too, and a `[demoted to index: project.* …]` notice just above the footer
- [ ] `rvr get <an indexed key>` prints the whole entry; `rvr context -p --tier full` prints everything and has no footer
- [ ] Budget order (#188, #211). `rvr context --size-only` shows the rendered size; then with `RVR_BOOTSTRAP_MAX_BYTES=<n>` set progressively lower: first a `[demoted to index: …]` notice and nothing dropped; then the footer adds `gists cut to 80 chars`, `40 chars`, then `keys only`, with every key still listed; only below that a `[trimmed: …]` notice. Output stays within `<n>` bytes until `<n>` is too small for even the keys that are never dropped, where a `payload still exceeds budget` warning says so. The notices come after the entries
- [ ] Sparse config (#212, #213), with `export RVR_DATA_DIR=$(mktemp -d)` so the real config is untouched: `rvr config get bootstrap_max_response_bytes` → `28672`, and no `config.json` appears in that directory. Write a 1.3.0-style file holding every default (`{"colors":true,"theme":"default","max_backups":10,"import_max_bytes":52428800,"bootstrap_max_response_bytes":38912}`): `rvr config get bootstrap_max_response_bytes` → `28672`, and the file is unchanged. Then `rvr config set bootstrap_max_response_bytes 38912` → the file reads `{"_format": 2, "bootstrap_max_response_bytes": 38912}`, `config.format` exists beside it, and `config get` reports `38912`, also on the next run. `config.format` lists `bootstrap_max_response_bytes`. Overwrite `config.json` with the 1.3.0-style file again (an older writer): `config get bootstrap_max_response_bytes` → `38912` kept as set, with one `Note: … rewritten by an older Reverie` line on stderr, and none on the next run. Then `rvr config unset bootstrap_max_response_bytes` and overwrite with the 1.3.0-style file once more: `config get bootstrap_max_response_bytes` → `28672`, the old writer's default not locked in. Write `{"theme":"dark",}` (broken JSON): `rvr --json config set theme light` → `error.code:"IO"`, exit 1, file unchanged; `rvr config get` prints one `Warning: … is not valid JSON` line and the defaults
- [ ] `config set` refusals (#273): `rvr --json config set theme neon` and `config set max_backups -1` → `error.code:"INVALID_INPUT"`, exit 1, nothing written; `config set nosuch 1` → `NOT_FOUND`. After `rvr config set theme dark`, `rvr config set theme light` leaves an audit row with `before: "dark"`
- [ ] `config unset` (#213), same data dir: `rvr config set theme dark`, then `rvr config unset theme` → `config.json` has no `theme`, `rvr config get theme` → `default`; `rvr --json config unset bogus` → `error.code:"NOT_FOUND"`, exit 1; `rvr --json manifest` lists `unset` under `config`. (via an MCP client) `reverie_config_unset` with `key: "theme"` → `Config unset: theme = default (default)`
- [ ] `rvr context --tier bogus` → `Invalid tier 'bogus'`, exit 1; with `--json`, `error.code:"INVALID_INPUT"`
- [ ] `rvr --json context --tier full` → `result.handoff.value` holds the handoff text (#205)
- [ ] Session detection (#207), inside Claude Code with `RVR_SESSION` unset: write an ordinary key three times within 30 minutes with `rvr --json set` — the third envelope carries a `WRITE_AMP` warning, `~/.reverie/sessions/` holds a `<session-id>.json` for that session, and the telemetry rows carry `sessionDetected: true`. With `RVR_SESSION=x` exported, rows carry session `x` and no `sessionDetected`
- [ ] Rows record what happened (#192, #203, #206), in the scratch project with `rvr set smoke.row hello` done: `rvr --json get smoke.row > out.json`, and the last line of `~/.reverie/telemetry.jsonl` has a `responseSize` equal to `wc -c < out.json`, not 0; `rvr get smoke.absent` exits 1, and the last line of both `telemetry.jsonl` and `audit.jsonl` carries `"errorCode":"NOT_FOUND"`; after `rvr config set bootstrap_gist_chars 160`, the last telemetry line has `"ns":"*"`; `rvr find --regex '['` and `rvr --json find --regex '['` each leave a last telemetry line with `"errorCode":"INVALID_INPUT"`; after `rvr set smoke.ok true`, `rvr --json run smoke.ok` leaves one with `"success":true` and no `errorCode`
- [ ] `_epoch.json` (#187): after `rvr init` in a fresh git repo, `.reverie/.gitignore` lists `_epoch.json`; after an `rvr set`, `git status` shows it neither staged nor untracked. The release notes carry the one-time step for existing repos: `git rm --cached .reverie/_epoch.json`
- [ ] (via an MCP client) `reverie_context` returns the same front page — a `[project: …]` line, then the handoff, the pinned namespaces (in full, or demoted as above) and the index lines — with a footer that names `reverie_get <key>`; `tier:"full"` returns everything
- [ ] Handoff exempt from the write-amp guard (#220), in the scratch project and one session: `rvr --json set -f context.next_session "note"` four times — no envelope carries a `WRITE_AMP` warning
- [ ] Unresolved references (#202), in the scratch project: `rvr set smoke.ref 'Use ${EMPTY} here'` stores it and warns; `rvr get smoke.ref` exits 0, prints the value as written and a `warning:` naming `${EMPTY}`; `rvr get -p smoke.ref 2>/dev/null` prints exactly `Use ${EMPTY} here`; `rvr --json get smoke.ref` has `ok:true` and a warning with code `INTERPOLATION_UNRESOLVED`; `rvr lint` lists the entry and exits 0. On 1.3.0 the plain `get` failed with `Interpolation failed`
- [ ] Stdin values (#221), in the scratch project: a heredoc (`rvr set smoke.multi <<'EOF'`, two lines, `EOF`), a here-string (`rvr set smoke.str <<< "text"`) and a redirected file (`rvr set smoke.file < some-file`) each report `set successfully`, and `rvr get <key> -p` prints the text back, both lines for the heredoc. On 1.3.0 all three failed with `No input received from stdin`
- [ ] Silent stdin (#225), in the scratch project with `rvr set smoke.cmd "echo hi"` done: `sleep 10 | rvr set smoke.cmd --confirm` prints `No value arrived on stdin within 2000ms` and the confirmation line after about two seconds, without waiting for `sleep` to end (the shell prompt itself returns only when `sleep` does — that is the pipeline, not `rvr`); `rvr get smoke.cmd -p` still prints `echo hi`, and `rvr run smoke.cmd < /dev/null` now refuses without `--yes`
- [ ] Unreadable store file (#222, step 1 of #215), in the scratch project: `rvr set smoke.conflict one`, then overwrite its file the way a merge would — `printf '<<<<<<< ours\n=======\n>>>>>>> theirs\n' > .reverie/smoke.conflict.json`. Now `rvr get smoke.conflict` fails naming the file, and with `--json` `error.code` is `"STORE_UNREADABLE"`, not `"NOT_FOUND"`; `rvr set -f smoke.conflict two` is refused and the file still holds the markers; `rvr context -p` opens with `!! 1 store file cannot be read`; `rvr lint` exits 1; `rvr set smoke.other ok` still succeeds. Delete the file by hand and `rvr lint` exits 0 again
- [ ] Key collisions are refused (#216, #224), in the scratch project: `rvr set smoke.col.a one` and `rvr set smoke.col.b two`, then `rvr set smoke.col flat` exits 1 naming `'smoke.col.a', 'smoke.col.b'`; `rvr set smoke.col.a.under x` exits 1 with `'smoke.col.a' holds a value`; `rvr set smoke.col.A other` exits 1 with `differs only by case`; `rvr copy smoke.col.a smoke.col -f` exits 1; with `--json`, `error.code` is `"INVALID_INPUT"`. After all of them `rvr get smoke.col -v` still prints both entries
- [ ] The confirmation gate follows the entry, in the scratch project on a default macOS volume: `rvr set smoke.gate.deploy "touch ran-gate" --confirm`, then `rvr --json run smoke.gate.DEPLOY` → `ok:false`, `error.code:"REQUIRES_CONFIRMATION"`, and no `ran-gate` file; `rvr confirm set smoke.gate` exits 1 with `is a namespace, not an entry`; `rvr confirm set smoke.gate.nosuch` exits 1 with `not found`. Then `rvr rename smoke.gate smoke.moved`: `rvr confirm list` shows both `smoke.moved.deploy` and `smoke.gate.deploy`, `rvr --json run smoke.moved.deploy` → `error.code:"REQUIRES_CONFIRMATION"`, and there is still no `ran-gate` file; `rvr confirm remove smoke.gate.deploy` prints `Confirmation removed`; then `rvr rm smoke.moved -f` warns that the flag listed under `smoke.moved.deploy` stays, and `rvr confirm list` still shows it (#244)
- [ ] A rename is one step (#259, #245, #247), with `RVR_DATA_DIR` pointed at a scratch directory, in the scratch project on a default macOS volume: `rvr set smoke.rn.deploy true --confirm`, then `rvr --json rename smoke.rn.DEPLOY smoke.rn.ship` → `ok:false`, `error.code:"INVALID_INPUT"`, a message ending `did you mean 'smoke.rn.deploy'?`, and no `.reverie/smoke.rn.ship.json`; `rvr set -G smoke.g x`, then put `{` in `$RVR_DATA_DIR/store/_confirm.json` and `rvr rename smoke.rn.deploy smoke.rn.ship` exits 1 with `while the global store's confirmation list cannot be read` and moves nothing; restore the list (`{}`), and the same rename succeeds and `rvr --json run smoke.rn.ship` → `error.code:"REQUIRES_CONFIRMATION"`
- [ ] Where `confirm set` lists a flag (#255, #256, #257, #268), with `RVR_DATA_DIR` pointed at a scratch directory, on a default macOS volume. From a directory outside any project: `rvr set -G smoke.gdeploy "touch ran-g"`. In the scratch project: `rvr confirm set smoke.gdeploy` says `stored only in the global store, so its flag is in the global list`, and `rvr confirm list -G` shows `smoke.gdeploy`; from a second scratch project, `rvr rename -G smoke.gdeploy smoke.gship`; back in the first, `rvr --json run smoke.gship` → `error.code:"REQUIRES_CONFIRMATION"` and no `ran-g` file. `rvr set smoke.fix "true"`, then `rvr confirm set smoke.ﬁx` (fi ligature) prints `Entry 'smoke.fix' (as typed: 'smoke.ﬁx')` and `rvr confirm list` shows `smoke.fix`, not the ligature. `rvr confirm set -G smoke.fix` too, then `rvr confirm remove SMOKE.FIX` exits 1 naming both the project list and the global list; `rvr --json confirm remove -G smoke.fix` → `ok:true`, `result.stillGated:true` and a warning naming the project list

## Rollback (if a release goes wrong)

Tagged releases are immutable on GitHub, but you can ship a follow-up patch:

```bash
git checkout -b hotfix/vX.Y.Z+1
# fix the issue
bun run build && bun run lint && bun run test
# bump version to X.Y.Z+1 in package.json + CHANGELOG
git commit -m "chore: release vX.Y.Z+1"
git push origin hotfix/...
gh pr create
# merge, then run the tag-and-release sequence above
```

For a truly broken release, mark it as a draft on GitHub Releases and post
an advisory in the next minor version's CHANGELOG.

## Post-release

- [ ] Update `project.<version>` Reverie entry (or create the next one) with status
- [ ] Close the milestone
- [ ] Open issues for any deferred items mentioned in the release notes
- [ ] Publish the draft security advisories held for this release: `grep -l "HELD FOR" docs/security/advisory-*.md`. On each GHSA form set the patched version to the tag just pushed, then publish; mark the source record PUBLISHED. For 1.4.0: GHSA-9653-mh42-mfjj (#234, `advisory-confirm-gate-spelling.md`), GHSA-vj74-g5wx-8hvv (#242, `advisory-exec-output.md`), GHSA-qrch-7p2g-xv8q (#241, `advisory-project-confirm-false.md`), GHSA-3g67-gwmx-3xp5 (#279, `advisory-alias-over-flag.md`), GHSA-cpx3-5chf-vwcw (#280, `advisory-reference-scope.md`), GHSA-g233-7583-cf8g (#281, `advisory-wrapper-eval.md`), GHSA-j27x-crw5-35fq (#282, `advisory-symlinked-backups.md`), GHSA-ww8w-4986-74pj (#284, `advisory-global-scope-alias.md`) and GHSA-pmp8-xv6h-2mr9 (#289, `advisory-collect-fail-open.md`)
