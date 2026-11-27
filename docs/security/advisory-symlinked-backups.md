# GitHub Security Advisory — source record (DRAFT, HELD FOR 1.4.0)

> DRAFT GHSA-j27x-crw5-35fq (not published). HELD until 1.4.0 is tagged: no
> released version has the fix yet. At release, set the patched version on the
> GHSA form to `1.4.0` and publish (docs/release-checklist.md, Post-release).
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5. Issue: #282. Fix: #288.

---

**Title:** A symlinked .reverie.backups in a cloned repository made backup rotation delete directories outside it

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.3.0`
**Patched versions:** `1.4.0` *(not yet released)*

**Severity:** High
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:H` (Base 7.1) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-59 (Link Following)

---

## Summary

Before `rvr data reset` and `rvr data import` replace a project store, rvr copies it into `.reverie.backups/` beside it and keeps the 10 newest backups, deleting older directories there. In affected versions the backups directory was not checked for a symlink (unlike the `.reverie` store itself, see GHSA-62qw-v74v-wxc6), and rotation deleted every directory in it beyond the newest 10, whatever its name. A legacy `.codexcli.backups` was renamed into place the same way.

## Impact

A cloned repository could ship `.reverie.backups` (or `.codexcli.backups`) as a symlink to a directory outside it, such as its parent or the user's home directory. Running `rvr data reset … --force` or `rvr data import … --force` inside it, or answering yes to the prompt, wrote a backup into that directory and then recursively deleted all but its 10 newest subdirectories with the user's permissions. On import the backup runs before the file is validated. The MCP reset and import tools do not take backups and were not affected.

## Workarounds

In a repository you do not trust, check that `.reverie.backups` and `.codexcli.backups` are absent or real directories before running `rvr data reset` or `rvr data import`.

## Patches

Fixed in **1.4.0** (#282, #288).

## Timeline

- 2026-11-26 — Found by the pre-1.4.0 security audit (the `security-audit` workflow, adversarially verified); verified on main; filed as #282; draft advisory created.

## Credit

Found and fixed internally.
