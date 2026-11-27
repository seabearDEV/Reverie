# GitHub Security Advisory — source record (DRAFT, HELD FOR 1.4.0)

> DRAFT GHSA-pmp8-xv6h-2mr9 (not published). HELD until 1.4.0 is tagged: no
> released version has the fix yet. At release, set the patched version on the
> GHSA form to `1.4.0` and publish (docs/release-checklist.md, Post-release).
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5. Issue: #289. Fix: #292.

---

**Title:** A reference walk that stopped early let a flagged command run without confirmation

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.3.0`
**Patched versions:** `1.4.0` *(not yet released)*

**Severity:** Low
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:H/PR:N/UI:R/S:U/C:N/I:L/A:N` (Base 2.5) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-636 (Not Failing Securely ('Failing Open'))

---

## Summary

`rvr confirm set <key>` flags a stored command so that `rvr run` asks before running anything that reaches it, directly or through a `${key}` or `$(key)` reference. Before a run, a collect pass walks every reference to find the flagged keys involved. In affected versions, if that walk failed partway, for example at the reference depth limit, it returned only the keys found so far, and the gate checked those. The run itself caches each `$(key)` result and does not repeat the walk, so it could get past the point where collect stopped and execute a flagged command the gate never saw.

## Impact

A flagged command could run without the confirmation prompt when it was reached through a deep chain of references that the collect pass aborted on but the run completed. MCP `reverie_run` behaved the same.

The chain consists of unflagged entries that run first. In a cloned repository those entries can already run code of their own, so the effect is a missed tripwire: a command the user flagged runs without the prompt they asked for. For the user's own composite commands, the flag is silently skipped.

The fix makes the collect pass handle each `$(key)` once per run, as the run does, so it walks no deeper than the run. It also fails closed: if the walk still stops partway after passing a command the run would execute, the run asks for confirmation, and the prompt says not every reference could be checked. A walk that stops before reaching any command keeps its own error, such as a missing reference or a cycle; the run stops at the same point without executing anything.

## Workarounds

Keep reference chains shallow, and run composite commands with `--dry` first to see the full command.

## Patches

Fixed in **1.4.0** (#289, #292).

## Timeline

- 2026-11-26 — Found in the independent review of the #279/#280/#284 fix; reproduced on 1.3.0 and main 26bc13e; filed as #289; draft advisory created.

## Credit

Found and fixed internally.
