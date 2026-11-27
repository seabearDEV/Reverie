# GitHub Security Advisory — source record (DRAFT, HELD FOR 1.4.0)

> DRAFT GHSA-g233-7583-cf8g (not published). HELD until 1.4.0 is tagged: no
> released version has the fix yet. At release, set the patched version on the
> GHSA form to `1.4.0` and publish (docs/release-checklist.md, Post-release).
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5. Issue: #281. Fix: #288.

---

**Title:** With the shell wrapper installed, rvr run --json evaluated the JSON output, so a crafted file name in a cloned store could run code

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.3.0`
**Patched versions:** `1.4.0` *(not yet released)*

**Severity:** Medium
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:H/PR:N/UI:R/S:U/C:L/I:H/A:N` (Base 5.3) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-78 (OS Command Injection)

---

## Summary

`rvr config completions install` adds a shell wrapper so `rvr run` can change the current shell (for example `cd`). For `run` and `r` it calls `rvr … --source` and `eval`s standard output. In affected versions `--source` still honoured `--json`, so standard output was the JSON envelope instead of the command, and the envelope's warnings quote store file names.

## Impact

With the wrapper installed, `rvr run <key> --json`, including `--dry`, inside a cloned repository whose `.reverie/` holds a crafted, unparseable file name evaluated that name as shell code. No confirmation was involved, and any existing key triggered it. Plain `rvr run` without `--json` was not affected.

The fix keeps `--source` output to the command text alone and never emits JSON there, and the wrapper no longer evaluates output when `--json`, `RVR_OUTPUT=json` or `--dry` is used. Reinstall the completions (`rvr config completions install`) to update an installed wrapper.

## Workarounds

Do not combine `--json` with `rvr run` while the wrapper is installed; call the binary directly (`command rvr run … --json`).

## Patches

Fixed in **1.4.0** (#281, #288).

## Timeline

- 2026-11-26 — Found by the pre-1.4.0 security audit (the `security-audit` workflow, adversarially verified); verified on main; filed as #281; draft advisory created.

## Credit

Found and fixed internally.
