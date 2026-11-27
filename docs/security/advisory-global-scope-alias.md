# GitHub Security Advisory — source record (DRAFT, HELD FOR 1.4.0)

> DRAFT GHSA-ww8w-4986-74pj (not published). HELD until 1.4.0 is tagged: no
> released version has the fix yet. At release, set the patched version on the
> GHSA form to `1.4.0` and publish (docs/release-checklist.md, Post-release).
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5. Issue: #284. Fix: #292.

---

**Title:** A project alias could redirect -G writes, removals and flag removals to another global entry

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.3.0`
**Patched versions:** `1.4.0` *(not yet released)*

**Severity:** Low
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:H/PR:N/UI:R/S:U/C:N/I:L/A:L` (Base 3.6) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-706 (Use of Incorrectly-Resolved Name or Reference)

---

## Summary

Reverie keeps a project store (`.reverie/`, committed with the repository) and a global store in the user's home. `-G` makes a command act on the global store. In affected versions the name typed after `-G` was still resolved through the project's aliases as well as the global ones, so a project alias could decide which global entry the command acted on.

## Impact

Inside a cloned repository whose `.reverie/_aliases.json` maps a name to the key of one of the user's global entries, using that name with `-G`:

- `rvr set -G <name>` overwrote that global entry;
- `rvr rm -G <name>` deleted it, with no prompt when stdin is not a terminal;
- `rvr rename -G <name> <new>` moved it;
- `rvr confirm remove -G <name>` cleared its flag from the global confirmation list, so a flagged global command then ran without asking.

The success message names the key that was changed, but the change has already been made. `rvr run -G` and the MCP tools called with global scope were not affected: they already used the global aliases only.

The fix resolves a name typed with `-G` through the global aliases only, on every command that takes a key (`set`, `get`, `edit`, `copy`, `rename`, `rm`, `confirm set`, `confirm remove`).

## Workarounds

Before using `-G` with a short name inside a repository you do not trust, check that the repository's `.reverie/_aliases.json` does not define it, or run the command from a directory outside any project.

## Patches

Fixed in **1.4.0** (#284, #292).

## Timeline

- 2026-11-26 — Found while checking the fix for #279/#280 (the pre-1.4.0 security audit); reproduced on 1.3.0 and main 26bc13e; filed as #284; draft advisory created.

## Credit

Found and fixed internally.
