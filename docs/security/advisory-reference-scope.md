# GitHub Security Advisory — source record (DRAFT, HELD FOR 1.4.0)

> DRAFT GHSA-cpx3-5chf-vwcw (not published). HELD until 1.4.0 is tagged: no
> released version has the fix yet. At release, set the patched version on the
> GHSA form to `1.4.0` and publish (docs/release-checklist.md, Post-release).
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5. Issue: #280. Fix: #292.

---

**Title:** References in a global command were resolved from a cloned project's entries, even with run -G

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.3.0`
**Patched versions:** `1.4.0` *(not yet released)*

**Severity:** Medium
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:H/PR:N/UI:R/S:U/C:L/I:H/A:N` (Base 5.3) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-829 (Inclusion of Functionality from Untrusted Control Sphere)

---

## Summary

A stored value can reference another entry: `${key}` substitutes its value and `$(key)` runs its stored command. In affected versions references were always looked up project-first, whatever scope the run asked for and whichever store held the entry containing the reference. `rvr run -G` applied the global scope to the top-level key only.

## Impact

Inside a cloned repository whose `.reverie/` defines an entry under a key name that one of the user's global commands references, running that global command, even with `rvr run -G`, substituted the repository's value or ran the repository's stored command. `--dry`, the confirmation prompt and the JSON preview all show the reference as written, so the swap was not visible, and approving a flagged command's prompt approved the repository's command. `reverie_run` with `scope: "global"` behaved the same.

The fix resolves a reference in the store of the entry that contains it: a global entry's references read only the global store. A project entry's references still fall back to the global store.

## Workarounds

Do not run global commands that contain references from inside a repository you do not trust; run them from a directory outside any project.

## Patches

Fixed in **1.4.0** (#280, #292).

## Timeline

- 2026-11-26 — Found by the pre-1.4.0 security audit (the `security-audit` workflow, adversarially verified); verified on main; filed as #280; draft advisory created.

## Credit

Found and fixed internally.
