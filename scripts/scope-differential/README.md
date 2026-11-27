# Scope differential: which entry did each command act on?

The gate fuzzer (`scripts/gate-fuzz/`) scores runs: it knows what executed and whether that was allowed. It does not judge which entry a `get`, `set`, `rename` or `alias remove` acted on, and no unit test sees every command in every scope. This tool compares two builds on exactly that, for every command that takes a name.

```bash
bun run build
bun scripts/scope-differential/diff.mjs --against <other dist> --jobs 4
```

The usual use is a main-versus-branch check for a change that should not change behaviour: build main into a scratch folder (`git archive <main> | tar -x -C <dir>`, then `bun install && bun run build` there) and pass its `dist`. It exits 0 when nothing differs, 1 when something does, 2 when it could not run every invocation.

## What it runs

`lib/worlds.mjs` holds eight worlds. They all have the same entries and flags:

- global: `k.g`, `k.both`, `k.gx`, `ns.a`, and `ref.g`, which holds references;
- project: `k.p`, `k.both`, `ns.a`, `ns.b`, and `ref.p`;
- flags: `k.g` in the global list, `k.p` in the project's.

What changes from one world to the next is the alias layout:

| World | Aliases |
|---|---|
| `split` | an alias in one store only, pointing at its own store and at the other |
| `same-name` | one name in both maps, with different and with the same targets |
| `legacy-pair` | aliases named after an entry of the other store and of their own (possible in 1.3.0 data) |
| `case` | alias names and typed names that differ only by case |
| `copied-260` | a project map that already holds a copied global alias (#260), and aliases to namespace members |
| `unreadable-project` | the project's `_aliases.json` does not parse |
| `unreadable-global` | the global `_aliases.json` does not parse |
| `proto` | names an object inherits, such as `toString` (an `in` lookup finds them, `Object.hasOwn` does not) |

Each world is driven with every alias name in it, every base key (`k.p`, `k.g`, `k.both`, the namespace `ns`, the miss `nope`), and the world's extra names: a trailing-colon form, case variants, prototype names.

For each name, from inside the project and from a directory outside it:

- **CLI**, in the default scope and with `-G`, every one with `--json`:
  - `get`, `edit`, `copy`, `remove`, `remove -a`;
  - `set` with a value, with `-a`, `-a` alone, and `--confirm` alone;
  - `rename`, `rename --set-alias`, `rename -a`;
  - `confirm set`, `confirm remove`;
  - `alias set` both ways (an alias to the name, and the name as an alias), `alias remove`, `alias rename`;
  - `run --dry`.
- **MCP**, with scope omitted, `"global"` and `"project"`:
  - `reverie_get`, `reverie_copy`, `reverie_alias_remove`;
  - `reverie_set` with and without `alias`;
  - `reverie_remove` with and without `is_alias`;
  - `reverie_rename` plain, with `alias`, and with `is_alias`;
  - `reverie_alias_set` both ways;
  - `reverie_run` with `dry: true`.

Once per world, in each scope and from both directories:

- CLI: `get` (listing), `get -A`, `find`, `context`, `alias list`, a batch `set a=… b=…`, and `data export` and `data import` of aliases (merge, replace, preview; with `-P` too).
- MCP: `reverie_get` (listing, `aliases_only`), `reverie_find`, `reverie_alias_list`, `reverie_context`, `reverie_export`, and `reverie_import` of aliases (merge, replace, preview).

That is 12,324 invocations per build. Nothing runs a stored command: `run` is only ever `--dry`, `reverie_run` only `dry: true`, and every value is an `echo` anyway. `edit` gets an `$EDITOR` that appends a fixed text.

## What it compares

Each invocation runs alone in a fresh copy of its world, on one build and then on the other, at the same path. For each run it records:

- the output: the CLI's JSON envelope, stderr and exit code, or the MCP tool's text;
- every file of both stores and their lock siblings, `_epoch.json` and the scaffolding included, as a content hash or a link target;
- the rows the invocation added to `audit.jsonl` and `telemetry.jsonl`. Some commands resolve a name only for the audit row, so those rows are checked as well.

Before comparing, the world's path is replaced by `<ROOT>`. Timestamps a write puts in an entry file become `T`, and the rows lose `ts`, `duration` and `session`. Two runs of one build give the same record, so main against main shows no differences.

## Options

```
--dist <dir>       build under test (default: dist)
--against <dir>    the other build
--jobs <n>         parallel workers (default: min(cores, 4))
--world <names>    only these worlds (comma-separated)
--filter <regex>   only invocations whose id matches, e.g. '\|proj\|cli rename'
--report <file>    every difference, as JSON
--dump <file>      every record of both builds, as JSON lines (large)
--show <n>         how many differences to print in full (default 30)
--expect <module>  name the differences a change is meant to make (below)
```

An invocation's id is `<world>|<cwd>|cli <argv>` or `<world>|<cwd>|mcp <tool> <args>`. `--filter` with that id replays one invocation. `--dump` without `--against` records one build, which is how to read what a command does today.

## A change that is meant to differ

For a change that is meant to change behaviour, `--expect <module>` names the differences it should make. The module's default export gets each differing invocation and both records (`inv`, the record of the build under test, the record of the other build) and returns the rule the difference falls under, or null. The run prints the count per rule, prints in full only the differences no rule covers, and fails only on those. Make each predicate exact: what changed as well as where, and every line of output the rule calls for, none missing and none extra. `expect-260.mjs` is the one for #260.

`write-then-run.mjs <first dist> <second dist>` covers what neither this tool nor the gate fuzzer does: a run after an alias write. It applies one rename or alias removal with each build, then runs every name the write touched on the stores that build left, in every scope, and fails on a run that asks on the first build and runs on the second.

## Its check

The tool should find the bug it exists for. A mutant that reintroduces #284 (`resolveTyped` resolving through the default view for `-G`) must show differences, and main against itself must show none. Both results are in the commit that added the tool.

## Limits

- Runs are never executed, so where a run lands is the gate fuzzer's to check. `scripts/project-differential/` covers project resolution, which neither tool varies here.
- No world has a confirm list that cannot be read, a symlinked sidecar, or an encrypted entry.
- The worlds are hand-made, not random. A layout none of them holds is not covered.
