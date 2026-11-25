# Reverie (`rvr`) — Design Notes: Bootstrap Bloat & Multi-Agent Coordination

**Date:** 2026-09-04
**Source:** Voice conversation between the maintainer (GitHub: `seabearDEV`) and Claude, summarized for handoff to Claude Code.
**Repo:** https://github.com/seabearDEV/reverie

## How to use this document

This is a record of a design discussion, not a spec. Treat everything under *Current state* as claims to verify against the actual source before building on them. Everything else is design direction and open questions — nothing here was decided.

## What Reverie is (maintainer's description)

- A continuity/memory layer for coding-agent sessions. During a session the agent writes facts it judges reasonable or needed for the codebase to JSON entries via the MCP server (or the `rvr` CLI), and recalls them later.
- On a new session, a **bootstrap** loads the accumulated entries so the agent starts with the prior session's context instead of cold.
- Used so far on a single solo project with one user and one agent. The maintainer reports it works extremely well in that setting.

## Current state — verify against the repo

Stated by the maintainer:

- `find` is **exact-key match only**. Fuzzy matching is a planned item for a future version.
- A `stale` function/command exists that checks for stale entries.

From a third-party listing (glama.ai), **not verified against source**:

- Write-amp guard: `reverie_set` / `rvr set` warns on repeated writes of the same key within a session window (informational; the write still succeeds; surfaced as a `WRITE_AMP` warning in the JSON envelope's `warnings[]`).
- `RVR_SESSION=<id>` groups separate CLI invocations into one session so session guardrails apply across invocations.
- `rvr context --size-only` (MCP: `sizeOnly: true`) reports per-namespace entry/byte counts and the effective budget without paying for the bootstrap.
- `find --keys` returns matching keys without values.
- The listing mentions "per-namespace" counts, so some namespace concept already exists. **Check what "namespace" currently means before designing the per-agent namespaces below.**

## Problem 1: Bootstrap bloat

The bootstrap has grown large enough that it consumes significant context at session start, which raises cost and reduces headroom for actual work.

Root cause: entries carry their full payload, and the bootstrap loads all of it eagerly.

### Direction: bootstrap as index, not payload

- Bootstrap becomes a thin manifest per entry: **key + one-line gist + pointer** to the full content.
- Full content is fetched lazily, only when the agent judges it relevant.
- The pointer target does not need to be a database. Content-addressed files on disk (hash → blob) are sufficient; the JSON entry holds key, gist, and path/hash.
- **The hard part is summary quality, not storage.** Lazy fetch only works if the gist is good enough for the agent to know when to fetch. A bad gist means the agent either never fetches (loses the fact) or fetches everything (bloat returns).
- Open question: where gists come from. Options include requiring a gist field on `set`, or deriving one at write time.

## Problem 2: Multi-user / multi-agent use

Today: one user, one agent. Anticipated: multiple people, each running an agent, committing at different times.

Two failure modes were separated:

1. **Overwrites / merge conflicts** — two agents edit the same entry and produce a git conflict.
2. **Duplication** — two agents independently record the same fact, producing redundant entries that add size and complexity.

**The maintainer's primary concern is duplication**, because of its effect on overall entry size and complexity.

### Idea A: Advisory claims board

- Agents post "holding key X, reason, expires in N minutes" to a shared board; every agent reads the board before reading/writing.
- Cheap to build, but advisory only — a non-compliant agent can still stomp.
- Does not address duplication on its own.

### Idea B: Per-agent namespaces — read globally, write locally (preferred)

- Each agent may **read all namespaces** but **write only to its own**. Results are merged on read.
- Entries are append-only. Because no two agents touch the same file, git merges cleanly; overwrites become structurally impossible rather than something to coordinate. This is essentially a CRDT-style pattern.
- **Limitation:** this does not stop duplication by itself. Two agents can write near-identical facts into different namespaces.
- Requires a **read-before-write step**: search across all namespaces for a semantically similar key/entry before writing. On a hit, point to or annotate the existing entry instead of writing fresh.
- **Dependency:** read-before-write needs fuzzy or semantic matching in `find`, which does not exist yet. The fuzzy-matching roadmap item becomes a prerequisite for multi-agent dedup.

### Idea C: Forum / thread model (preferred; composes with B)

- The first agent's entry is the **post** and remains canonical. Later agents append **replies** rather than new top-level entries — e.g. "still true as of commit `abc123`," or "this changed; here is what's different."
- This is an append-only log with a natural parent-child shape. Replies are separate files, so they merge cleanly in git.
- Reply threads double as the dedup signal: the norm becomes "find the existing post and reply," not "write new."
- **Risk: thread rot.** A long thread forces the reader to walk every reply, which reintroduces bloat by another route.

### Compaction: extend `stale`

- Proposal: augment the existing `stale` machinery to also perform compaction, since it already walks entries and judges freshness. Extending it is a smaller leap than building something new.
- Keep two jobs conceptually distinct even if they share machinery:
  - **Staleness** — "is this still true?" A judgement call, made by a human or an agent.
  - **Compaction** — "this thread has N replies; fold the settled ones into the parent and archive the rest." Mechanical, triggered by thread length or age.
- Open question: run automatically (hook or schedule) versus a deliberately invoked command. The cross-cutting concern below argues for automatic.

## Cross-cutting concern: complexity → context → cost

- Every feature added to fight bloat is potentially something the agent must be told about, which grows the instruction surface, which costs tokens. The fix can feed the problem.
- Principle: **keep complexity in the tool, not in the agent's head.** If compaction runs automatically, the agent never needs to know the command exists. Token cost grows only when the agent's instruction surface grows.
- Apply this test to every proposal above: does it add to what the agent has to be told?

## Research items (not yet done)

1. How other agent frameworks and memory systems handle compaction and consolidation (hierarchical summaries, decay, merge-on-read, etc.). The maintainer requested this; it was not researched during the session.
2. Automatic vs. invoked compaction — tradeoffs, and whether a git hook or session-end hook is the right trigger.
3. Fuzzy/semantic matching approach for `find` — lexical fuzzy vs. embeddings, and any local-only constraints.
4. Gist generation and quality guarantees for the manifest.
5. What "namespace" currently means in the codebase and whether it can be reused for per-agent namespaces.

## Suggested next steps for Claude Code

1. Read the repo and confirm or correct the *Current state* section.
2. Measure the current bootstrap: bytes/tokens at session start, and which entries dominate (`rvr context --size-only` if it exists).
3. Prototype the manifest + lazy-fetch split on the maintainer's existing data and measure the reduction in session-start tokens.
4. Draft the reply/thread data model and how it interacts with the existing namespace concept.
5. Draft the `stale` extension for compaction, keeping the judgement step and the mechanical step clearly separated.
