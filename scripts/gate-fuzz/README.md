# End-to-end fuzzer for the run-confirmation gate

`rvr run` and MCP `reverie_run` must ask before they run anything that reaches a flagged key. This fuzzer checks that on the built CLI and MCP server, by what actually ran. It needs one build and knows nothing of the gate's code (#290).

```bash
bun run fuzz:gate          # build, then the quick mode: fixtures + 300 worlds, about 3 minutes on a laptop
bun run fuzz:gate:long     # build, then 3,000 worlds
```

CI runs the quick mode on pull requests that touch `src/` or the fuzzer, with seed 1. It runs the long mode weekly, as four parallel shards of 750 worlds seeded with the run number (`.github/workflows/gate-fuzz.yml`).

## How it scores

Every generated entry's value starts with `echo RVM<n>x` and sends it to a log (`$RLOG`), so after each invocation the log lists the entries whose text actually ran: run as a command, pasted in through `${…}`, or executed through `$(…)`. A command that ran before a later error is in the log too.

The verdict comes from those markers and from the fuzzer's own model of the documented rules (`lib/model.mjs`). The model reads the world from disk with plain `fs` and imports nothing from `src/` or `dist/`: a check that rebuilds the gate from the code it checks shares that code's mistakes. That was `scripts/gate-differential/`'s blind spot.

The rules it models:

- Either store's `_confirm.json` gates with a `true` value. The project's list applies only inside the project.
- A name is gated when it matches a flag, case aside, or when it opens the same entry file as a flag. The fuzzer asks the filesystem which files match, as the gate does.
- An unreadable `_confirm.json` gates every run. An unreadable `_aliases.json` contributes no aliases.
- Aliases resolve one hop, by exact name.
  - The default scope layers the project's map over the global one.
  - `-G` and MCP `scope: "global"` read the global map only.
  - MCP `scope: "project"` reads the project's map only, and outside a project it falls back to the global store.
- A run gates every name it looks up: as typed, its alias target, and the global alias target when project aliases were in play. That covers:
  - the key, and each `a:b` segment;
  - a `--chain` or `chain: true` entry, and each member;
  - every `${…}` and `$(…)` the run reaches.
- A reference resolves in the store of the entry that holds it. A global entry reads the global store only; a project entry reads the project, then the global store. A global chain runs global members.

### Rules

An invocation is unapproved when it is a CLI run without `--yes` and with stdin closed, or an MCP call without `force` and without a valid `confirm_token`. For an unapproved invocation that ran anything:

| Rule | Fires when |
|---|---|
| R1 flagged-entry | an entry whose own key is flagged ran |
| R2 typed-name | a name looked up at the top level is flagged |
| R3 executed-ref | a name written in an entry that ran is flagged (its whole value was interpolated before it ran) |
| R3r reach-ref | a name anywhere in the run's reach is flagged |
| R5 stopped-walk | the run ended in a reference-walk error after something ran, or the model finds such an error in reach (`${…}` not found, `:?`, a cycle, a refused `$(${…})`) |
| R6 unreadable-list | a `_confirm.json` the run reads is unreadable |

R1 needs no model at all, and R2 and R3 need only one lookup each. R3r and the model half of R5 use the reach: the closure of everything the run can look up, which ignores the depth limit, the order and the exec cache. On a correct build, a run that executes anything unasked has a complete collect walk, and a complete walk looks up exactly these names. A walk that stops after a command asks; one that stops before any command runs nothing. Depth-limit stops are caught by the error text, since the reach does not model depth.

Rules for every invocation, approved or not:

| Rule | Fires when |
|---|---|
| R4 confinement | a project entry ran under `-G` or MCP `scope: "global"` |
| R4r reach | an entry ran that the run cannot reach under the store rules, e.g. a project entry through a global entry's reference |
| R7 exec-on-read | `--dry`, `get`, MCP `dry` or `reverie_get` ran anything |
| R8 store | a refused or failed invocation changed either store; any invocation left an odd `_epoch.json` or a lock file |
| R9 flag-kept | a flag left a list through any command other than `confirm remove` or `--no-confirm` |

"Changed" means byte for byte: type, content and symlink target, through `lstat`, plus the `<store>.lock` siblings. It leaves out `_epoch.json`, which a refused commit moves by two and which has its own evenness check. It also leaves out the scaffolding a store's first write creates (`_README.md`, `.gitignore`). Runs never write the store, so every run is held to "unchanged". Writes follow the runs and are each judged against the stores just before them.

## What a world holds

`lib/gen.mjs` draws each world from a PRNG seeded by (seed, world index), so world 57 of seed 1 is always the same world, whatever the mode or the number of workers. A world has two stores and about 150 invocations from inside the project and from a directory outside it.

**Stores**
- Entries in either store or both, with up to three random references each: `${k}`, `$(k)`, `:-` defaults (nested too), `:?`, `$(${k})`, and spaced `${ k }`.
- A deep linear chain `d1 → … → d13`, which reaches the depth limit (10).
- The #289 shape: an exec reference walked shallow first and deep later, then a flagged command.
- A walk that stops after a command already ran, on keys no flag names.
- Chain entries, some of whose members are `a:b` pairs.
- Aliases in both stores: aliases named after entries (legacy, still gated), aliases of aliases, and dangling ones.
- Flags under any spelling, in either list, plus values that are not `true`.
- Irregular sidecars: a directory, a symlink to a valid map, a dangling symlink, unparseable JSON, an array, `null`, an empty file.

Entry keys never differ only by case or Unicode form within one store, since a case-insensitive volume would fold them into one file. Those spellings (`A`, `FL`, `ſx` for `sx`, `N.x`) go into typed names, references, aliases and flags, where the filesystem decides what they open. The results therefore depend on the filesystem: `ſx` opens `sx.json` on APFS and nothing on ext4. The model asks the filesystem, so it is right on both.

**Invocations**
- CLI `run` in `--json`, plain, `--capture` and `--source` mode; for `--source`, stdout is then evaluated by `/bin/sh`, as the shell wrapper would.
- Each CLI run with and without `-G`, plus `a:b`, several keys, `--chain`, and a few `--yes` runs.
- MCP `reverie_run` with scope omitted, `project` and `global`, and with `chain: true`.
- MCP tokens: a valid redeem, a reused token, a bogus one, and another key's token.
- `--dry`, `get`, MCP `dry` and `reverie_get`.
- Then a write mix, much of which the rules refuse:
  - CLI `alias set`, `set -a`, `confirm set`, `confirm remove`, `rename`, `remove`, `copy` and `set`;
  - MCP `reverie_alias_set`, `reverie_set`, `reverie_rename`, `reverie_remove` and `reverie_copy`.

The hand-written worlds in `fixtures/` run before the random ones: #279, #280, #289 (both shapes) and the reference and alias-target gates, each as a fixed world.

## Running it

```bash
bun scripts/gate-fuzz/fuzz.mjs --quick                       # fixtures + 300 worlds, seed 1
bun scripts/gate-fuzz/fuzz.mjs --worlds 1000 --seed 7        # any count and seed
bun scripts/gate-fuzz/fuzz.mjs --world 57 --seed 7 --inv 12  # replay one invocation, printing what ran
bun scripts/gate-fuzz/fuzz.mjs --replay <spec.json> --inv 0  # replay a saved (shrunk) world
bun scripts/gate-fuzz/fuzz.mjs --fixtures                    # only the fixtures
bun scripts/gate-fuzz/fuzz.mjs --dist <dir>                  # another build (default: dist)
bun scripts/gate-fuzz/fuzz.mjs --against <otherDist>         # differential, below
```

`--jobs` sets the workers (default: cores, at most 8). `--report <file>` writes the violations and counters as JSON. `--out <dir>` keeps the failing world specs there; otherwise they go to a temp directory, printed at the end and kept only when something failed. Every world runs under its own temp root, with `HOME`, `RVR_DATA_DIR`, `TMPDIR` and the working directory all inside it. The fuzzer refuses a temp root with a `.reverie` or `.codexcli` above it. Children get an environment built from scratch, with `RVR_TEST=1` and `RVR_TEST_CHECKOUT` set; neither changes the run path.

## Reading the result

Each violation prints its rules, what ran, why, and a one-line replay:

```
VIOLATION world 21 inv 4 [R2-typed-name] cli proj [json] rvr fl
  result: ran OK; ran markers [1]
  R2-typed-name: flagged name looked up at the top: fl; ran project:a
  replay: bun scripts/gate-fuzz/fuzz.mjs --dist dist --seed 1 --world 21 --inv 4
  shrunk: bun scripts/gate-fuzz/fuzz.mjs --dist dist --replay /tmp/…/seed1-world21-inv4.json --inv 0
```

The shrunk world is the world with every entry, alias, flag and reference removed that the same rule did not need. The last lines are counters: outcomes per surface, and coverage such as how many runs hit the depth limit, asked because not every reference could be checked, or ran anything. Treat a counter near zero as a generator gap.

A rule that fires on a correct build is a fuzzer bug, or a rule that changed. Replay it, read what ran, and fix whichever is wrong.

## Differential mode

`--against <otherDist>` runs every world on a second build as well. It reports each unapproved invocation that the other build asks about and this one runs. That is not a violation by itself: #280, for example, made some runs stop asking because they stopped reaching a project entry. It is a list to read when a gate change is meant to be gate-preserving. CI does not run it.

## Limits

- No TTY. The interactive prompt path (`stdin.isTTY`) is not driven; non-interactive refusal is.
- Encrypted entries, symlinked or unparseable entry files, and backslash escapes are not generated. The model does not cover them.
- The exec output check (#242) is reached only incidentally.
- The `confirm_token` fingerprint (#243) is exercised only with an unchanged world. A token redeemed after the world changes between preview and redeem is not generated.
- The write mix checks store invariants and flag retention. It does not check what each write should have done.
- Filesystem folding beyond case and `ſ` is not generated: ligatures, NFD and the sharp s. `scripts/gate-differential/` covers those for the list-changing commands.
