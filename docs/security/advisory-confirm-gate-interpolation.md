# GitHub Security Advisory — source record (PUBLISHED)

> PUBLISHED 2026-11-26 as **GHSA-cchh-h245-wgr7**:
> https://github.com/seabearDEV/reverie/security/advisories/GHSA-cchh-h245-wgr7
> This file is the internal source record; the advisory above is canonical.
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5: `@seabear/reverie` is never published to npm
> (`project.distributionChannels`). Tracking issue: #158. Fix: #160.

---

**Title:** Confirmation gate skipped for a flagged command reached through a `${key}` or `$(key)` reference

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.2.2`
**Patched versions:** `1.3.0`

**Severity:** Medium
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:N` (Base 4.7) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-863 (Incorrect Authorization)

## Summary

An entry flagged with `--confirm` makes `rvr run` ask before it executes the command, refuse with `REQUIRES_CONFIRMATION` when it cannot ask, and over MCP, make `reverie_run` return a preview and a one-time `confirm_token` first. In affected versions the check covered only the keys named in the `run` call. A key reached through a reference inside the value was never checked: either a value reference `${key}` or an exec reference `$(key)`.

So an entry without the flag that refers to a flagged one ran the flagged command with no prompt, no refusal and no token step. A `.reverie/` store is committed with the repository it describes, so the unflagged entry can arrive in a cloned repository.

## Impact

A command the user flagged as needing confirmation runs without it, under the privileges of the user running `rvr` or the Reverie MCP server, when any entry that refers to it is run:

- **CLI:** `rvr run <key>`, in text and `--json` mode, including the non-TTY refusal.
- **MCP:** `reverie_run`.

The `$(key)` form also hid from the preview: the safe preview shows `$(key)` literally, so the confirmation text of the outer entry did not name the gated command.

The flag is a safety prompt, not a sandbox (`--yes` and `force` skip it by design). The vulnerability is that it was skipped without either.

## Proof of concept

The user's global store holds a flagged command:

```
rvr set deploy-prod "./deploy.sh --prod" --confirm -G
```

A cloned repository ships, in its `.reverie/`, an entry with no flag:

```
build = "npm run build && ${deploy-prod}"      # or: $(deploy-prod)
```

Running it executes the flagged command with no confirmation:

```
rvr run build                 # or: reverie_run { key: "build" }
```

## Patches

Fixed in **1.3.0** (#160). Interpolation records every key it visits through its own scanner. A non-executing collect pass (`collectReferencedKeys()`) gathers the full set before anything runs, and the gate is evaluated over that set on both surfaces: CLI `run` in text and JSON mode, and MCP `runGated`. Regression tests cover `${key}`, `$(key)` and a `${key}` → `$(key)` chain, plus a test that `--yes` still runs a gated command reached by reference.

## Workarounds

For unpatched versions: run only stored commands you have read, and read every entry they reference (`rvr get <key> -s`, recursively) before you run them. Upgrade to 1.3.0 or later.

## Timeline

- 2026-07-23 — Found by the pre-release agentic audit for 1.3.0 (Leg B, `docs/security/release-process.md`); filed as #158.
- 2026-07-23 — Fixed in #160; released as 1.3.0.

## Credit

Found and fixed internally during the pre-release security audit.
