# GitHub Security Advisory — source record (DRAFT, HELD FOR 1.4.0)

> DRAFT GHSA-3g67-gwmx-3xp5 (not published). HELD until 1.4.0 is tagged: no
> released version has the fix yet. At release, set the patched version on the
> GHSA form to `1.4.0` and publish (docs/release-checklist.md, Post-release).
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5. Issue: #279. Fix: #292.

---

**Title:** A project or imported alias over a flagged name ran another command without confirmation

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.3.0`
**Patched versions:** `1.4.0` *(not yet released)*

**Severity:** Medium
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N` (Base 5.5) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-863 (Incorrect Authorization)

---

## Summary

A flag set with `rvr confirm set` makes `rvr run` and `reverie_run` ask before running that entry's command, and refuse with `REQUIRES_CONFIRMATION` where they cannot ask. Flags gate by name, and the global list (`~/.reverie`) applies in every project.

In affected versions the gate checked only the key an alias resolves to, never the name as typed or as written in a reference. A project's alias map (`.reverie/_aliases.json`) is committed with the repository, and in the default scope project aliases take precedence over global ones. A cloned repository could therefore define an alias named after a command the user flagged globally, pointing at an unflagged entry of its own. A merge import (`rvr data import … --merge`, MCP `reverie_import`) and `alias set` could create the same alias, because nothing refused an alias named after an existing entry.

## Impact

Inside such a repository, `rvr run <flagged name>`, a `${name}` or `$(name)` reference to it in the user's own commands, and `reverie_run` over MCP ran the repository's command without asking, while `rvr confirm list` still showed the name as flagged. A project entry stored under the flagged name itself stayed gated; only an alias got past the gate.

## Workarounds

Inside a repository you do not trust, run flagged global commands with `-G` (global scope reads only global aliases), and check `.reverie/_aliases.json`. Do not merge-import export files you did not create.

## Patches

Fixed in **1.4.0** (#279, #292).

## Timeline

- 2026-11-26 — Found by the pre-1.4.0 security audit (the `security-audit` workflow, adversarially verified); verified on main; filed as #279; draft advisory created.

## Credit

Found and fixed internally.
