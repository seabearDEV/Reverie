# GitHub Security Advisory — source record (DRAFT, HELD FOR 1.4.0)

> DRAFT GHSA-qrch-7p2g-xv8q (not published). HELD until 1.4.0 is tagged: no
> released version has the fix yet. At release, set the patched version on the
> GHSA form to `1.4.0` and publish (docs/release-checklist.md, Post-release).
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5. Issue: #241. Fix: #264.

---

**Title:** A cloned project confirmation list could disarm a globally flagged command

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.3.0`
**Patched versions:** `1.4.0` *(not yet released)*

**Severity:** Medium
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N` (Base 5.5) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-863 (Incorrect Authorization)

## Summary

A flag set with `rvr confirm set` (or `set --confirm`) makes `rvr run` and `reverie_run` ask before running that entry's command. It refuses with `REQUIRES_CONFIRMATION` where it cannot ask, and requires a `confirm_token` over MCP. Each store keeps its flags in its own list. The global list (`~/.reverie`) gates the key in every project, and a project's list (`.reverie/_confirm.json`) is committed with the repository.

In affected versions the two lists were merged with the project's on top, and only a value of `true` gated. A project list holding `false` (or `null`) for a key therefore replaced the global `true` for that key, inside that project. rvr never writes such a value, but a cloned repository can ship one.

## Impact

A cloned repository disarms the confirmation for any command the user flagged globally under a name the repository chooses, such as `commands.deploy`. Inside that repository the command then runs with no prompt, refusal or token step, on the CLI, in `--json` mode and over MCP, whether run directly or reached through a `${key}` reference. The repository does not need to ship a command of its own. `rvr confirm list` still showed the flag, and `rvr lint` reported nothing.

## Proof of concept

```
rvr set -G commands.deploy "./deploy.sh --prod" --confirm
# in a cloned repository whose .reverie/_confirm.json is {"commands.deploy": false}
rvr run commands.deploy      # runs without confirmation
```

## Patches

Fixed in **1.4.0** (#241, #264). Only `true` is taken from each list, so a flag in either list gates the key, and nothing in one list can turn the other's flag off.

## Workarounds

Before running commands in a cloned repository, check `.reverie/_confirm.json` for any value other than `true`. Upgrade to 1.4.0 when it is released.

## Timeline

- 2026-11-25 — Found during review of the confirmation gate (#234); verified on 1.3.0 and main; filed as #241.
- 2026-11-26 — Fixed in #264, merged to main; not yet released.

## Credit

Found and fixed internally.
