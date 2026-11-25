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
- [ ] `rvr --json manifest` → `result.mcpToolMap` has 19 tools and `result.envelope.version` is `"1"`
- [ ] `rvr config llm-instructions --surface cli` contains no "PREFER MCP TOOLS" and names `rvr` commands
- [ ] `rvr init` (in a temp dir) writes both `CLAUDE.md` and `AGENTS.md`; `rvr init --no-agents` skips `AGENTS.md`
- [ ] `rvr --json run <confirm-entry>` (no `--yes`) → `ok:false`, `error.code:"REQUIRES_CONFIRMATION"`, command in `error.preview`

#### v1.4.0

The bootstrap changed shape on both surfaces, and on a shell machine the MCP server gets no everyday use — exercise `reverie_context` through an MCP client, not only the CLI. Extend this list with the behaviour of anything merged after it was written. The read lines want a populated repo (this one); the lines that write want the scratch project.

- [ ] `rvr context -p` (in a populated repo): the handoff banner is the first thing printed; the pinned namespaces (`project.*`, `commands.*`, `conventions.*`) render in full when they fit the budget; every other entry is one line, a gist ending in `… [+84B]`-style when it was cut; the last line is `[tier: standard (N entries: X in full, Y indexed) — open an entry with rvr get <key>, or use --tier full for everything]` (#188). In this repo `project.*` alone is larger than the default budget leaves room for, so with a default config expect it as index lines too, and a `[demoted to index: project.* …]` notice just above the footer
- [ ] `rvr get <an indexed key>` prints the whole entry; `rvr context -p --tier full` prints everything and has no footer
- [ ] Budget order (#188, #211). `rvr context --size-only` shows the rendered size; then with `RVR_BOOTSTRAP_MAX_BYTES=<n>` set progressively lower: first a `[demoted to index: …]` notice and nothing dropped; then the footer adds `gists cut to 80 chars`, `40 chars`, then `keys only`, with every key still listed; only below that a `[trimmed: …]` notice. Output stays within `<n>` bytes until `<n>` is too small for even the keys that are never dropped, where a `payload still exceeds budget` warning says so. The notices come after the entries
- [ ] `rvr config get bootstrap_max_response_bytes` on a fresh data dir → `28672`; a config that still holds an old default (`51200` or `38912`) also reports `28672` (#212)
- [ ] `rvr context --tier bogus` → `Invalid tier 'bogus'`, exit 1; with `--json`, `error.code:"INVALID_INPUT"`
- [ ] `rvr --json context --tier full` → `result.handoff.value` holds the handoff text (#205)
- [ ] Session detection (#207), inside Claude Code with `RVR_SESSION` unset: write an ordinary key three times within 30 minutes with `rvr --json set` — the third envelope carries a `WRITE_AMP` warning, `~/.reverie/sessions/` holds a `<session-id>.json` for that session, and the telemetry rows carry `sessionDetected: true`. With `RVR_SESSION=x` exported, rows carry session `x` and no `sessionDetected`
- [ ] `_epoch.json` (#187): after `rvr init` in a fresh git repo, `.reverie/.gitignore` lists `_epoch.json`; after an `rvr set`, `git status` shows it neither staged nor untracked. The release notes carry the one-time step for existing repos: `git rm --cached .reverie/_epoch.json`
- [ ] (via an MCP client) `reverie_context` returns the same front page — a `[project: …]` line, then the handoff, the pinned namespaces (in full, or demoted as above) and the index lines — with a footer that names `reverie_get <key>`; `tier:"full"` returns everything
- [ ] Handoff exempt from the write-amp guard (#220), in the scratch project and one session: `rvr --json set -f context.next_session "note"` four times — no envelope carries a `WRITE_AMP` warning
- [ ] Unresolved references (#202), in the scratch project: `rvr set smoke.ref 'Use ${EMPTY} here'` stores it and warns; `rvr get smoke.ref` exits 0, prints the value as written and a `warning:` naming `${EMPTY}`; `rvr get -p smoke.ref 2>/dev/null` prints exactly `Use ${EMPTY} here`; `rvr --json get smoke.ref` has `ok:true` and a warning with code `INTERPOLATION_UNRESOLVED`; `rvr lint` lists the entry and exits 0. On 1.3.0 the plain `get` failed with `Interpolation failed`
- [ ] Stdin values (#221), in the scratch project: a heredoc (`rvr set smoke.multi <<'EOF'`, two lines, `EOF`), a here-string (`rvr set smoke.str <<< "text"`) and a redirected file (`rvr set smoke.file < some-file`) each report `set successfully`, and `rvr get <key> -p` prints the text back, both lines for the heredoc. On 1.3.0 all three failed with `No input received from stdin`
- [ ] Unreadable store file (#222, step 1 of #215), in the scratch project: `rvr set smoke.conflict one`, then overwrite its file the way a merge would — `printf '<<<<<<< ours\n=======\n>>>>>>> theirs\n' > .reverie/smoke.conflict.json`. Now `rvr get smoke.conflict` fails naming the file, and with `--json` `error.code` is `"STORE_UNREADABLE"`, not `"NOT_FOUND"`; `rvr set -f smoke.conflict two` is refused and the file still holds the markers; `rvr context -p` opens with `!! 1 store file cannot be read`; `rvr lint` exits 1; `rvr set smoke.other ok` still succeeds. Delete the file by hand and `rvr lint` exits 0 again

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
