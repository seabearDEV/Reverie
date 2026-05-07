# Release Checklist

Manual steps for cutting a new Reverie release. Follow these in order.

## Pre-tag verification

Before tagging, run the full quality bar:

```bash
npm run check    # = npm run build && npm run lint && npm test
```

All of the following must be true:

- [ ] `tsc` produces no errors
- [ ] `eslint src/` produces no errors
- [ ] Full test suite passes (currently 1394 tests across 59 files; updated each release)
- [ ] `git status` is clean (no uncommitted work)
- [ ] You're on `main` and synced with `origin/main`
- [ ] All issues in the milestone are CLOSED via merged PRs

```bash
gh issue list --milestone "v$VERSION" --state open
# should return zero open issues
```

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
npm install   # updates package-lock.json
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release vX.Y.Z"
git push origin main
```

## Tag and release

The release alias from the codex (`commands.release`) handles this:

```bash
git push origin main && \
  VERSION=`node -p "require('./package.json').version"` && \
  git tag "v$VERSION" && \
  git push origin "v$VERSION" && \
  echo "🚀 Released v$VERSION"
```

CI will pick up the tag and build/publish artifacts.

## Post-tag manual smoke

After CI publishes, do these manual checks against the released binary. The exact commands depend on what's in the release — fill in the per-release section below.

### Generic smoke (every release)

```bash
rvr --version          # prints the new version
rvr info               # data path, config path, completions status
rvr set smoke.test "hello"
rvr get smoke.test     # → hello
rvr get smoke.test -p  # plain output, no ANSI codes
rvr find smoke         # finds the entry
rvr remove smoke.test -f
rvr context            # shows project context summary
```

### MCP server smoke

```bash
# Start the MCP server in dev mode and verify it responds to listTools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | rvr-dev-mcp
```

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
- [ ] `CODEX_DATA_DIR=./relative rvr info` errors with "must be an absolute path"
- [ ] `CODEX_DATA_DIR=/tmp/codex-test rvr info` shows `(CODEX_DATA_DIR)` annotation on the Data line
- [ ] `rvr get -a` and `rvr rename -a foo bar` and `rvr remove -a foo` still work (legacy back-compat) but don't appear in `rvr get --help`

#### v1.14.0

- [ ] `cd /tmp && CODEX_NO_PROJECT=1 rvr set foo bar` refuses with `PROJECT_UNRESOLVED`-shaped error including resolver-chain diagnostic and recovery actions (#99)
- [ ] `CODEX_BOOTSTRAP_MAX_BYTES=500 rvr context -p` (in a populated repo) prepends a `[trimmed: …]` notice naming `files.*` / `arch.*` / `context.*` with byte counts; if even after shedding it's still over budget, prepends a second `[warning: codex_context payload still exceeds budget …]` notice with the expanded never-shed list (#100)
- [ ] `CODEX_BOOTSTRAP_MAX_BYTES=500 rvr context -p --tier full` (in the same repo) bypasses the shed entirely — no trimmed notice, full payload renders (#100)
- [ ] `rvr config set bootstrap_max_response_bytes 102400` accepts the value; `rvr config get bootstrap_max_response_bytes` returns it; an invalid value (negative, non-integer) is rejected with a clear error
- [ ] (manual via MCP client) Three `codex_set` calls to the same key within 30 minutes — third response includes a `warning:` line naming the count and time-since-first-write (#101)

## Rollback (if a release goes wrong)

Tagged releases are immutable on GitHub, but you can ship a follow-up patch:

```bash
git checkout -b hotfix/vX.Y.Z+1
# fix the issue
npm run check
# bump version to X.Y.Z+1 in package.json + CHANGELOG
git commit -m "chore: release vX.Y.Z+1"
git push origin hotfix/...
gh pr create
# merge, then run the tag-and-release sequence above
```

For a truly broken release, mark it as a draft on GitHub Releases and post
an advisory in the next minor version's CHANGELOG.

## Post-release

- [ ] Update `project.<version>` codex entry (or create the next one) with status
- [ ] Close the milestone
- [ ] Open issues for any deferred items mentioned in the release notes
