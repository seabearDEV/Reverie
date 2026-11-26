# Differential check for the run-confirmation gate

A change to the confirmation gate (`src/confirm.ts`, `src/utils/entryIdentity.ts`, the `run` gates, `rename`, `remove`, `confirm set`) has one rule to meet:

> Every entry the old build gates is still gated on the new build, after any command.

Unit tests and mutation checks did not find the violations of that rule in #234. Running the same random commands through both builds and comparing what each gates afterwards did, three times. These are the scripts that did it. They are not part of `bun run test`: a run takes minutes and needs two builds.

## What a run does

Each trial builds two identical worlds, one per build: two projects (`p1`, `p2`), a directory outside any project, and one shared global store. It runs the same random sequence of `set`, `confirm set`, `confirm remove`, `rename`, `remove`, `copy` and `alias set` commands in both, from random directories, with and without `-G`. The keys differ by case and by Unicode form on purpose.

Afterwards `probe.mjs` evaluates the `run` gate with each build's own modules, for every key a sequence can produce — each namespace of the mix with each leaf name, since renaming or copying a namespace carries its leaf names into another, and the alias — from each of the three directories, in the default scope and with `-G`. A **hit** is a key the old build reports `GATED` and the new one does not. The harness also compares the entry files of the two worlds.

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

`entry-file differences` should be 0: the two builds are expected to store the same entries.

## Limits

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
