# Release Checklist

Manual steps for cutting a new codexCLI release. Follow these in order.

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
ccli --version          # prints the new version
ccli info               # data path, config path, completions status
ccli set smoke.test "hello"
ccli get smoke.test     # → hello
ccli get smoke.test -p  # plain output, no ANSI codes
ccli find smoke         # finds the entry
ccli remove smoke.test -f
ccli context            # shows project context summary
```

### MCP server smoke

```bash
# Start the MCP server in dev mode and verify it responds to listTools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | cclid-mcp
```

### Per-release breaking changes

For releases with breaking changes, exercise each one explicitly to confirm
the deprecation/error fires.

#### v1.11.0

- [ ] `ccli get foo --raw` errors with "unknown option" (the deprecated `--raw` was removed)
- [ ] `ccli get foo -p` works (the new `-p` short for `--plain`)
- [ ] `ccli context -p` works (same)
- [ ] `ccli stats -d` errors with "unknown option" (moved to `-D`)
- [ ] `ccli stats -D` works (the new short for `--detailed`)
- [ ] `ccli stats -j` works (newly-added consistency short for `--json`)
- [ ] `CODEX_DATA_DIR=./relative ccli info` errors with "must be an absolute path"
- [ ] `CODEX_DATA_DIR=/tmp/codex-test ccli info` shows `(CODEX_DATA_DIR)` annotation on the Data line
- [ ] `ccli get -a` and `ccli rename -a foo bar` and `ccli remove -a foo` still work (legacy back-compat) but don't appear in `ccli get --help`

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
