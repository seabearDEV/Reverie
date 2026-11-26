# GitHub Security Advisory — source record (DRAFT, HELD FOR 1.4.0)

> DRAFT GHSA-9653-mh42-mfjj (not published). HELD until 1.4.0 is tagged: no released
> version has the fix yet. At release, set the patched version on the GHSA
> form to `1.4.0` and publish (docs/release-checklist.md, Post-release).
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5. Fix: #234. Same class as #158 (GHSA-cchh-h245-wgr7),
> whose fix did not cover other spellings of a key.

---

**Title:** Confirmation gate skipped when a flagged key is spelled another way on a case-insensitive filesystem

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.3.0`
**Patched versions:** `1.4.0` *(not yet released)*

**Severity:** Medium
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:N` (Base 4.7) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-178 (Improper Handling of Case Sensitivity)

## Summary

Each entry is a file named after its key. On a filesystem that folds names, the path for a key that is not stored opens the file of one that is:

- **Case:** on a default macOS (APFS) or Windows volume, case is folded.
- **Unicode forms:** APFS also folds other forms, such as U+017F ſ for s, the ﬁ ligature, ß for ss, and NFD for NFC.

The `--confirm` flag was matched by exact spelling. So `commands.Deploy` read and ran the command stored as `commands.deploy` while the check found no flag for it.

This held for the key named in `rvr run` and for every way a command is reached: a `${key}` value reference, a `$(key)` exec reference and an alias. Through a reference it is the #158 bypass again: an entry without the flag in a cloned repository's `.reverie/` runs the user's flagged command, and 1.3.0's fix for #158 checks the referenced key under the spelling written in the reference.

## Impact

A command the user flagged as needing confirmation runs without the prompt, without the non-TTY `REQUIRES_CONFIRMATION` refusal and without MCP's `confirm_token` step. It runs under the privileges of the user running `rvr` or the Reverie MCP server:

- **CLI:** `rvr run`, in text and `--json` mode.
- **MCP:** `reverie_run`.

This applies only on filesystems that fold names, which includes the default volumes of macOS and Windows.

## Proof of concept

The user's global store holds a flagged command:

```
rvr set commands.deploy "./deploy.sh --prod" --confirm -G
```

A cloned repository ships, in its `.reverie/`, an entry with no flag:

```
build = "npm run build && ${commands.DEPLOY}"
```

On a default macOS volume, `rvr run build` (or `reverie_run { key: "build" }`) runs `./deploy.sh --prod` with no confirmation. So does `rvr run commands.DEPLOY`.

## Patches

Fixed in **1.4.0** (#234). Whether a spelling reaches an entry is the filesystem's rule, so the gate compares files, not names. A key is gated when a flag is listed under its name, case aside, or under any flagged name whose path opens the same file (`dev:ino` from `fs.statSync` with bigint, per store directory). The behaviour was probed on APFS (case-insensitive and case-sensitive), HFS+, exFAT and FAT32 under macOS; Windows was not tested. A differential check (`scripts/gate-differential/`) ran random command sequences through the old and new builds and checked that every entry the old build gates is still gated.

## Workarounds

For unpatched versions: before running a stored command, read every entry it references (`rvr get <key> -s`, recursively), and treat any reference whose spelling differs from a flagged key as reaching it. Upgrade to 1.4.0 when it is released.

## Timeline

- 2026-11-25 — Found and fixed in #234, merged to main (272d70c); not yet released.

## Credit

Found and fixed internally.
