# Dogfooding: How Reverie Found and Fixed Its Own Bugs

Reverie is a persistent knowledge store for AI agents. During the v1.11.1 release cycle, we used Reverie's own MCP tools to develop, debug, and validate Reverie itself. The tool caught three independent MCP server freeze bugs, stored the diagnosis for future sessions, and then stress-tested itself to confirm the fixes held.

This is the story of that loop.

## The setup

v1.11.0 shipped on April 8, 2026 with a file-per-entry storage layout, file locking, and unified audit/telemetry. Within hours of live MCP testing against the new release, the server started freezing mid-session. The symptom was always the same: the server appeared to hang, and reconnecting (`/mcp` in Claude Code) "fixed" it because it spawned a fresh process.

One symptom. Three independent causes. All found by an AI agent using Reverie's own tools.

## Three freezes, three fixes

### 1. Directory scan on every read

Every `codex_get`, `codex_context`, `codex_stale`, and `codex_stats` call triggered a full `readdir` + per-file `stat` of the store directory. With 40+ entries, parallel bulk calls stacked up and wall time climbed.

**Fix:** Dir-mtime fast-skip. If the store directory's own `mtime` hasn't changed since the last scan, no atomic write has touched any file inside it (because `atomicWriteFileSync`'s create-tmp + rename bumps the dir mtime). Skip the scan entirely. One `stat` syscall instead of ~80.

### 2. Full audit log re-read on every query

`audit.jsonl` is append-only and was re-parsed from the top on every `loadAuditLog()` call. After a few hundred operations, `codex_audit` and `codex_stats` dominated wall time.

**Fix:** Incremental tail cache. Cache the parsed entries plus the byte offset of the last read. On subsequent calls, `pread()` just the new tail. Cache resets on shrink or rotation.

### 3. Object.prototype poisoning

This was the subtle one. A telemetry entry with `__proto__` as its namespace hit `nsCoverage[e.ns]++` in `computeStats`, where `nsCoverage` was a plain `{}`. That one line poisoned `Object.prototype` for the entire process — every fresh `{}` inherited counter properties. The MCP SDK's internal request dispatch silently broke on the next tool call. The server didn't crash; it just stopped responding.

**Fix:** Switch all dict accumulators in `computeStats` to `Object.create(null)`.

## The dogfooding loop

Here's what made this different from a normal bug-fix cycle:

1. **Bootstrap.** The agent called `codex_context` at session start and loaded the full project knowledge — architecture, conventions, file locations, gotchas — in one call instead of exploring the codebase from scratch.

2. **Diagnose.** Each freeze was found during live MCP testing. The agent read the relevant source files (already knew where to look from `files.telemetry`, `files.audit`, `files.store`) and identified the root cause.

3. **Fix and test.** Each fix landed with regression tests. Test count went from 1,167 to 1,226.

4. **Store the findings.** The diagnosis — all three causes, their symptoms, and grep recipes for ruling them out if a fourth freeze ever appears — was stored back into the codex as `context.mcpServerFreezeDiagnosis`. Future agents loading this project will know about these failure modes without re-discovering them.

5. **Validate.** A stress test (`scripts/stress-test.mjs`) hammered the MCP server with ~42,000 tool calls across three configurations. Zero errors, zero timeouts, max latency 77ms. All on Node.js with JSON files over stdio.

6. **Soak.** The beta was used extensively in a separate real-world project for 24+ hours with no issues before tagging stable.

## The numbers

| Metric | Value |
|---|---|
| Freeze causes found | 3 |
| Beta iterations | 8 (beta.0 through beta.8) |
| Regression tests added | +59 |
| Stress test tool calls | ~42,000 |
| Stress test errors | 0 |
| Max latency under stress | 77ms |
| Time from v1.11.0 to v1.11.1 | 2 days |

## What this demonstrates

**Persistent context pays compound interest.** The agent didn't spend tokens re-exploring the codebase each session. It loaded `codex_context`, knew the architecture, knew the conventions, and went straight to the problem. Every insight stored in one session accelerated the next.

**Stored diagnosis prevents re-discovery.** The `context.mcpServerFreezeDiagnosis` entry is a playbook. If a future agent sees a freeze, it checks the three known causes before assuming it's a fourth. That's hours of debugging compressed into a few hundred bytes.

**The stack is simpler than you'd think.** 42,000 MCP tool calls against a Node.js process reading and writing JSON files over stdio. No database, no daemon, no cache layer. The performance ceiling is higher than it looks — you just have to not do O(N) work on every call.

## Try it

```bash
brew install seabearDEV/reverie/rvr   # or npm install -g reverie
cd your-project
rvr init                            # scan codebase, populate .codexcli/
```

Add the MCP server to your AI agent configuration and call `codex_context` at session start. Every session gets smarter.
