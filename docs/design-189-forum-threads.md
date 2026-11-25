# Design: Forum threads — replies, the handoff, conflict resolution, open questions, compaction

**Issues:** [#189](https://github.com/seabearDEV/reverie/issues/189) (replies), [#215](https://github.com/seabearDEV/reverie/issues/215) steps 2–3 (routine collisions, resolution path), [#226](https://github.com/seabearDEV/reverie/issues/226) (open questions), [#227](https://github.com/seabearDEV/reverie/issues/227) (compaction) · **Umbrella:** [#186](https://github.com/seabearDEV/reverie/issues/186)
**Status:** PROPOSED 2026-11-24. Seven decisions are open for the owner (below); nothing here is implemented.
**Scope:** all four issues ship in v1.4.0. This document orders the work; it does not move any of it.
**Builds on:** #188 (front page), #222 (an unreadable store file is an error), #216 and #224 (key collisions are refused).

## What is fixed already

These come from #186, #189 and #215 and are not reopened here.

- The agent-facing surface is three verbs: `context` (front page), `get` (open a thread), one reply verb. `set` keeps creating and editing posts.
- The post is the current truth and stays editable. Replies are append-only and never load at bootstrap.
- A reply's identity is the **committer**, not the agent. The agent name identifies the harness, so two people on Claude Code report the same one.
- Per-agent key prefixes are rejected. Store files are never hand-edited.
- A key is a leaf or a parent, never both, and a write that would break that is refused (#224). Keys compare case-insensitively (#216).

## Decisions for the owner

Each has a recommendation. The design below assumes the recommended option.

| # | Question | Options | Recommended |
|---|---|---|---|
| **O1** | What identity is committed in a reply? | (a) a handle plus 4 hex of the email's hash, `kory-3fa2` · (b) the raw git `user.email` · (c) a configured name | **(a)**. The store is committed and shared, so a raw email is published with it. The hash keeps two people with the same handle apart. |
| **O2** | How does `get` show a thread? | (a) text and MCP print the post, then the replies; `-p` stays value-only with a one-line pointer on stderr; `--json` adds `result._replies` · (b) replies only behind `--thread` · (c) `-p` appends replies | **(a)**. Scripts read `-p` as the bare value. `_replies` cannot collide with a key, so `.result[key]` stays a string. A flag would be a fourth thing agents have to know. |
| **O3** | How is the handoff written, and what leads the banner? | (a) `reply context.next_session`; `set` on that key still writes the post and warns; the banner shows the newest of post and notes, with other notes from the last 7 days as one line each · (b) `set` on the handoff key is silently routed to a note file | **(a)**. Under (b), `set` stops writing what `get`, the audit log and the handoff readers expect. See the two exceptions under [Handoff](#215-step-2--the-handoff-and-status-entries). |
| **O4** | How do status entries such as `project.inFlight` stop colliding? | (a) sessions append `changed` replies and the post is rewritten when they are folded in; a post with unfolded `changed` replies carries a visible marker · (b) also render those replies under the pinned post at bootstrap · (c) no mechanism: split the entry into per-topic keys | **(a)**, knowing its limits: it is a convention plus a nudge, the post lags between folds, and two concurrent folds still collide (step 3 handles that). |
| **O5** | How are two edits to one post resolved? | (a) `rvr resolve <key>` prints both sides; `--keep ours\|theirs` writes one and saves the other as a `note` reply · (b) the newer `meta.updated` wins automatically · (c) a git merge driver | **(a)**. #222 made the side the user's call. (b) trusts clocks across machines. (c) needs `git config` in every clone, and the store can only seed files. |
| **O6** | May the front page differ per clone? | (a) local misses, marked as local, plus committed `question` replies · (b) committed questions only | **(a)**. The miss log is per machine; hiding it leaves the section empty for most stores. |
| **O7** | Who declares replies settled, and what happens to the files? | (a) `set <key> … --fold` (MCP `fold: true`) deletes the reply files visible in that clone · (b) a separate verb · (c) any edit of the post retires older replies | **(a)**, with deletion. (c) loses replies nobody incorporated. A comment on #84 already rejected an archive folder: git keeps the history. |

Two points need an explicit yes beyond picking options:

- **O3 deletes files.** Under (a), a writer's older handoff notes are removed when they write a new one. #215 sanctions showing a reply at bootstrap; nothing yet sanctions that deletion.
- **#227 departs from its issue text.** The issue says compaction is "driven by #84's signals". #84 is unbuilt and unmilestoned, and its coldness signal is per machine. The design below defines "settled" from committed state only. If #84 must come first, it joins the milestone.

## #189 — replies

**Layout.** One flat directory per store:

```
.reverie/_replies/<key>@<YYYYMMDDTHHMMSSmmmZ>-<n|v|c|q>-<who>-<6hex>.json
```

- Entry scans skip names that start with `_`, and a key cannot start with `_` (`isEntryFilename`, `isValidEntryKey` in `src/utils/directoryStore.ts`). The post therefore never becomes a parent, and neither function changes.
- A unique name per write means two clones adding replies never conflict in git.
- The suffix is fixed-shape lowercase and parsed from the right, because a key may contain any character except `/` and `\`. The key part compares case-insensitively.
- A per-key directory, as #189's example shows, would need a stat per thread on every bootstrap. The flat directory needs one.

**File.** `{ "reply", "type", "meta": { created, by, agent, commit? } }`. It has no `value` field, so `parseEntryWrapper` can never load one as an entry. Types: `note`, `verified` (carries a commit SHA), `changed`, `question`.

**Cache.** The store's directory-mtime fast skip is untouched. Replies get their own index (count, last date and handle, open questions, unfolded changes), built from filenames only, behind its own mtime token on `_replies/`. An atomic write creates its temp file beside the target, so a new reply moves the mtime of `_replies/` and not the store's. Cost per `context`: one extra stat when nothing changed, one readdir when something did. Reply writes do not bump the epoch.

**Verb.** `rvr reply <key> [--type note|verified|changed|question] [--commit <sha>] <text>` and `reverie_reply`. The key must be an existing leaf, except the handoff key. A reply lands in the store that holds its post.

**`get`** (per O2). Reply text is never interpolated and `run` cannot reach it.

**Front page.** `(3 replies, last 2026-08-28 by kory)` after the age tag on an index line, sized through the same path as the age tag so the budget sees it.

**Identity** (resolved at write time only): `RVR_COMMITTER`, then `git -C <project root> config --get user.email`, then a config key, then `unknown` with a warning. This is the first git subprocess in `src`. The MCP server's working directory is not the project, hence `-C`. #45 can reuse the resolver later.

**Lifecycle.** `rename` moves the thread; `remove` cascades; `copy` does not copy replies; `data reset` deletes them; export and import gain a `replies` section. Backups already recurse.

**An unreadable reply file** is a new kind beside entry and sidecar. `get` and `lint` report it. It never blocks the post.

**Guard and logs.** The write-amp guard counts a reply as a write to the parent key (#189). The reply tool joins `classifyOp`. Audit `before` must not capture the post.

**Handshake budget.** The tool count is pinned at 19 by a test. The built-in instructions are 2,022 of 2,048 bytes, and the tool descriptions are close to their 3,000-byte cap (about 2,800 by the planning pass's count, not re-measured), so the reply clause has to replace words in the hand-off step, not add to them.

## #215 step 2 — the handoff and status entries

The handoff and `project.inFlight` are per-committer state under one shared key, which is why they collide at nearly every merge.

- **Handoff** (per O3): a handoff is a `note` reply on `context.next_session`. The banner shows the newest of the post and the notes. Readers that change: the banner (`src/utils/handoff.ts`), the context composer, the budget's never-dropped rule, and the write-amp exemption (handoff notes stay exempt).
- **Two exceptions to the fixed rules**, both confined to the handoff key: a reply is shown at bootstrap, and a writer's older notes are deleted by their next one. Notes are never retired when the identity is `unknown`.
- **Status entries** (per O4): sessions append `changed` replies; the post is rewritten at fold.
- **Migration:** none on disk. An existing handoff post stays and loses to newer notes. The instruction text ships in the binary, so generated `CLAUDE.md` / `AGENTS.md` files lag until regenerated; `set` on the handoff key keeps working and warns.

## #215 step 3 — `rvr resolve`

For the residual case, two edits to one post.

- `rvr resolve <key>` rebuilds both sides from the conflict markers in the file, falling back to index stages 2 and 3, and prints each side's value and `updated` time. Ours and theirs swap under a rebase, so it shows both and names neither as the default.
- `--keep ours|theirs` writes that side and saves the other as a `note` reply, so nothing is discarded.
- Sidecars: a key-wise merge of both maps; a clash on one name needs `--keep`.
- It is the one writer allowed past #222's refusal, and only while the file classifies as a conflict. It does not run `git add`. CLI only.
- A modify/delete conflict leaves no markers. Only `resolve` and `lint`, through `git ls-files -u`, would see one.

## #226 — open questions on the front page

- A miss row has no project field today. Add it on both surfaces first; without it the section cannot tell stores apart.
- A question is the same key or `find` query missed in two sessions within 14 days, excluding namespace-wide (`*`) rows and anything written back since.
- It is answered by an entry at that key, a later non-question reply, or age.
- At most five lines, after the aliases and before the notices. Under budget pressure the section collapses to one line before any namespace is demoted. It is absent at `essential`.
- Committed `question` replies appear on every clone; local misses are marked as local (O6).

## #227 — compaction

- **Settled** is defined from committed state only. Superseded replies retire mechanically: an older `verified`, and a writer's older handoff notes. Everything else retires by `--fold` (O7).
- A thread is **due** at five replies, or at any `changed` reply on a pinned post. That shows in the index-line tag and in a new section of `rvr stale`.
- Local read counts only order that list. They decide nothing, because they differ per machine.

## Slices

Each is one PR with its own tests.

| # | Slice | Size | Needs |
|---|---|---|---|
| 1 | Store layer: `utils/replies.ts`, `utils/committer.ts` (new files only) | M | nothing |
| 2 | Miss rows carry the project | S | nothing |
| 3 | The reply verb, the remove / rename / reset cascade, orphan `lint` | L | 1; #216 and #224 merged |
| 4 | `get` opens the thread | M | 1; #216 and #224 merged |
| 5 | Front-page reply counts | M | 1 |
| 6 | Handoff thread | M | 3, 5 |
| 7 | `rvr resolve` | M–L | #216 and #224 merged; the keep-the-other-side note needs 3 |
| 8 | Open questions | M | 2, 3, 5 |
| 9 | Compaction | M | 3, 4, 5 |
| 10 | Export / import, docs, smoke lines; close #186 | S–M | all |

Slices 1 and 2 can start now and run in parallel. Slices 3, 4 and 5 can run in parallel once 1 lands. Slice 7 can run beside 4–6. No reply file can exist before slice 3, which carries the cascades, so nothing is orphaned in between.

Which issue each slice closes: #189 after 3–5; #215 after 6 and 7; #226 after 8; #227 after 9; #186 after 10.

## Risks

- **The miss signal is thin.** This machine's log has 43 rows, mostly `find` queries or namespace-wide rows, with three writebacks. The open-questions section will usually be empty until committed `question` replies exist.
- **False misses over MCP.** Hit detection matches "not found" anywhere in a response, so reply text containing that phrase would count a read as a miss.
- **`-p` and stderr.** Agents commonly pass `-p`. Whether a given harness shows stderr to the agent is unverified, so the pointer to a thread may go unseen.
- **Clocks.** Reply order and "newest" trust each machine's clock.
- **Old advice persists.** `_README.md` is seeded without overwriting, so existing stores keep the pre-`resolve` text about conflicts.
- **Security gate.** This adds a clone-supplied read surface (`_replies/`) and the first git subprocess. Both belong in the security audit before the release.
- **Dependencies outside the milestone.** #140 (miss-path surfacing), #84 (entry health) and #45 (attribution) are unmilestoned. This design does not wait for them: #226 reads the miss log itself, #227 does not use #84's signals, and #189 ships its own identity resolver.

## Verified against the code

The claims above about existing code were checked on `main` at `41ce9df`: the `_` filename and key rules, `parseEntryWrapper` requiring `value`, the directory-mtime fast skip, the atomic write's temp-file placement, the miss row's fields, the handshake test's three caps and the current instruction size, the write-amp gate and its handoff exemption, and the absence of any git subprocess in `src`. Not checked by running anything: the shape git leaves in a conflicted entry file beyond what #215 and #222 already reproduced, and the parameter-description budget.
