# Differential check for the run-confirmation gate

> **Use `scripts/gate-fuzz/` for the run gate itself.** This harness never runs the code that decides a run. `probe.mjs` rebuilds the gate expression from each build's shared modules and evaluates that. A break in `runKeys` (`src/commands/entries.ts`) or `runGated` (`src/mcp-server.ts`) is therefore invisible to it: a build whose reference gate was a no-op scored 0 hits in 120 trials (#290). It also covers no `--chain` and no MCP, and it finds only differences between two builds.
>
> The end-to-end fuzzer runs the built CLI and MCP server and scores on what actually ran, against its own model of the rules. It needs one build, and CI runs it. Keep this harness for what the fuzzer does not do: random sequences of the commands that change the confirmation list (`rename`, `remove`, `copy`, `confirm set`/`remove`, `alias set`), over two projects, with Unicode-form keys. The fuzzer's write mix checks only that no command other than `confirm remove` drops a flag.

A change to the confirmation gate (`src/confirm.ts`, `src/utils/entryIdentity.ts`, the `run` gates, `rename`, `remove`, `confirm set`) has one rule to meet:

> Every entry the old build gates is still gated on the new build, after any command.

Unit tests and mutation checks did not find the violations of that rule in #234. Running the same random commands through both builds and comparing what each gates afterwards did, three times. These are the scripts that did it. They are not part of `bun run test`: a run takes minutes and needs two builds.

## What a run does

Each trial builds two identical worlds, one per build: two projects (`p1`, `p2`), a directory outside any project, and one shared global store. It runs the same random sequence of `set`, `confirm set`, `confirm remove`, `rename`, `remove`, `copy` and `alias set` commands in both, from random directories, with and without `-G`. The keys differ by case and by Unicode form on purpose.

Afterwards `probe.mjs` evaluates the `run` gate with each build's own modules, for every key a sequence can produce — each namespace of the mix with each leaf name, since renaming or copying a namespace carries its leaf names into another, and the alias — from each of the three directories, in the default scope and with `-G`. A **hit** is a key the old build reports `GATED` and the new one does not. The harness also compares the entry files of the two worlds.

The gate itself changed in #279 and #280: it checks a key as typed as well as its alias target (and its global alias target), and a value's references resolve in the store the value came from. `probe.mjs` asks each build which gate it has (a build that exports `getValueWithStore` and `gateNamesFor` has the new one) and evaluates that one. With `PROBE_TRACE=1` it also lists the keys each result checked; the harness compares plain results, so set it only when probing a world by hand.

## Running it

Build the old code somewhere (a worktree of `main` is enough) and the new code in this checkout, then:

```bash
bun scripts/gate-differential/all-commands.mjs <oldDist> <newDist> <workDir> 150 7
```

`<oldDist>` and `<newDist>` are `dist/` directories. `<workDir>` is created and emptied. `150` is the number of trials, `7` the seed; an optional sixth argument caps the commands per trial (default 12). Each trial takes two to three seconds. The four scripts differ in which commands they draw:

| Script | Draws |
|---|---|
| `all-commands.mjs` | everything, over a wide set of keys, including bare `confirm set` and flag-only `set --confirm` |
| `flags-with-value.mjs` | the same, but flags are only set together with a value |
| `rename-heavy.mjs` | mostly renames, of entries and of namespaces |
| `two-projects.mjs` | one namespace shared by both projects and the global store |

They are independent and can run side by side with different work directories.

## Reading the result

The last line is the summary:

```
done: 150 trials, seed 7; trials with a main-gated/head-ungated key: 9 {"refusal":9}; entry-file differences: 0
```

("main" is the old build, "head" the new one.) Each hit trial is printed with its commands, both builds' exit codes, and both flag lists. The class is a hint, not a verdict:

- `refusal`: the new build refused a flag-setting command the old one accepted. Since #234 `confirm set` refuses a key that names no entry, and a namespace; a flag set that way on the old build gates the entry once it is created. That one difference is accepted. Check it with `replay.mjs`, which re-runs the hit trials and reports any refused `confirm set` whose key did name an entry at the time:

  ```bash
  bun scripts/gate-differential/replay.mjs <newDist> <harness output file> <workDir>
  ```

- `nsRename`: the trial renamed a namespace. Before the rule that a rename never removes a flag, these were real losses.
- `NEITHER`: nothing explains it. Treat it as a regression until shown otherwise.
  One kind is expected since #280, and only this one: a global entry whose `${…}` or `$(…)` read a project entry of the same name, which reached a flagged command. The new build reads the global store there, so that command is not part of what the run executes, and is not gated. Show it before calling it that: with `PROBE_TRACE=1` the flagged key is in the old build's list and not the new one's, and `rvr --json run -G <key> --dry` on each build shows the old one running the project's text.

`entry-file differences` should be 0: the two builds are expected to store the same entries.

## Limits

- It evaluates a rebuilt gate, not `runKeys`/`runGated` (see the note at the top).
- CLI only. `reverie_run` and the other MCP tools are not exercised.
- It finds differences between two builds. A hole both builds share is invisible to it.
- What a filesystem folds decides what the keys with other spellings do. Run it on the filesystem you care about; the results in #234 are from case-insensitive APFS.

## The filesystem probe

`fs-identity-probe.mjs` checks the assumption the gate rests on: that comparing device and inode says "same file" exactly when another spelling of a name opens the stored file. It was run on APFS (case-insensitive and case-sensitive), HFS+, exFAT and FAT32.

```bash
bun scripts/gate-differential/fs-identity-probe.mjs <a directory on the filesystem to test>
```

Every line should end in `ok`. To test a filesystem you do not have mounted, on macOS:

```bash
hdiutil create -size 120m -fs "ExFAT" -volname probe probe.dmg
hdiutil attach probe.dmg -mountpoint ./probe-mnt -nobrowse
bun scripts/gate-differential/fs-identity-probe.mjs ./probe-mnt
hdiutil detach ./probe-mnt
```

Other values for `-fs`: `"HFS+"`, `"MS-DOS FAT32"`, `"APFS"`, `"Case-sensitive APFS"`. Windows and Linux folding mounts have not been tested.
