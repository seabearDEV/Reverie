# Project differential: which runs ask, as project resolution varies

The gate fuzzer never creates a project mid-session or builds a legacy `.codexcli.json`. A change to project resolution, or to anything that reads the project store, therefore needs a main-versus-branch comparison of which runs ask in those setups. The #298 review built these tools for that, and they are kept here.

```bash
bun run build
bun scripts/project-differential/run.mjs --dist dist --against <main dist>
```

`run.mjs` runs each setup on both builds and compares them line by line. It prints each difference, and tags a run that asked on main and runs on the branch as `WEAKENING`. It exits 0 when nothing differs.

## The setups

There are 13, listed in `modes.mjs`:

| Mode | Setup |
|---|---|
| `proj` | a project, with CLI and MCP from inside it and from outside it |
| `legacy` | an unparseable legacy `.codexcli.json` |
| `legacyro` | a valid legacy file in a read-only directory, so it cannot be migrated |
| `legacydir` | a directory named `.codexcli.json` |
| `legacyparent` | a project, with an unmigratable legacy file in a subdirectory |
| `stale` … `stale6` | an MCP server started outside any project, with a project appearing in its cwd. Before that it makes one call: `reverie_get`, `reverie_stats`, `reverie_config_get`, none (`stale4`), `reverie_audit`, or `reverie_get` with `scope: "global"` |
| `nearer`, `nearer2` | an MCP server in a project's subdirectory, where a nearer project appears: empty, or with entries |

In each setup, every run key (plain, wrapping a flagged entry through `${…}` and `$(…)`, aliased, chained) is run through the CLI with and without `-G` and through MCP with each scope. The setups that change mid-session also make a write and a removal. Each command appends a marker to a log, so the outcome is what ran: `RAN`, `ASK`, `ERR` or `OK`.

## Pieces

- `gatediff.mjs <dist> <mode> <root>` runs one setup on one build and prints one JSON line per invocation.
- `compare.mjs <main.jsonl> <head.jsonl>` compares two of those outputs.
- `run.mjs` runs every setup, or `--mode a,b`, on both builds and compares them.

Every child gets the fuzzer's environment (`scripts/gate-fuzz/lib/drive.mjs`): a temp `HOME`, `RVR_DATA_DIR` and `TMPDIR` under the setup's root, `PATH=/usr/bin:/bin`, `RVR_TEST=1` and `RVR_TEST_CHECKOUT`. A root must not have a `.reverie` or `.codexcli` above it, and `gatediff.mjs` replaces only a root it made itself.
