# GitHub Security Advisory — source record (DRAFT, HELD FOR 1.4.0)

> DRAFT GHSA-vj74-g5wx-8hvv (not published). HELD until 1.4.0 is tagged: no
> released version has the fix yet. At release, set the patched version on the
> GHSA form to `1.4.0` and publish (docs/release-checklist.md, Post-release).
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5. Issue: #242. Fix: #251.

---

**Title:** Output of a `$(key)` exec reference could run as code, including past the confirmation gate

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.3.0`
**Patched versions:** `1.4.0` *(not yet released)*

**Severity:** High
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:H` (Base 7.0) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-78 (Improper Neutralization of Special Elements used in an OS Command)

## Summary

A stored command can contain `$(key)`, an exec reference: at run time rvr runs that key's command and pastes its output into the outer command, which the shell then runs. In affected versions that output could run as code:

- **Pasted output ran as shell code.** Output was pasted into the command as text, so output holding shell syntax ran: `$(touch x)`, `; rm …`. Whoever controls what a stored command prints (a file it reads, git metadata, a network response) chooses what runs.
- **Output was scanned again.** When the exec reference was reached through a `${key}` value reference, the outer pass read the output for references. A command that printed `$(flagged.key)` ran the flagged command without the `--confirm` prompt, refusal or MCP `confirm_token`.
- **A `${…}` could supply the key of a `$(…)`.** `$(${name})` took its key from text a reference supplied, possibly a command's output, which the confirmation check cannot see without running anything.
- **Escapes were undone.** An escaped `\$(key)` in an entry reached through `${key}` was executed by the outer pass.

## Impact

Command execution under the privileges of the user running `rvr run` or `reverie_run`, chosen by whoever controls the output of a stored command that the run reaches through `$(key)`. It also gets past the confirmation gate for flagged commands.

## Patches

Fixed in **1.4.0** (#242, #251):

- **No re-scan:** text that a `${key}` or a command put into a command is never scanned again.
- **No key from a reference:** a `$(…)` that takes its key from a `${…}` is refused.
- **Shell syntax refused:** exec output that holds `` ` `` `$` `;` `&` `|` `<` `>` `(` `)` `'` `"` `\` `#` or a newline stops the run with an error naming the key. Plain output is pasted as before.

## Workarounds

Point `$(key)` only at commands whose output you control, and do not reach `$(key)` through `${key}`. Upgrade to 1.4.0 when it is released.

## Proof of concept

```
rvr set -G flagged.cmd "touch /tmp/ran" --confirm
rvr set -G emit.cmd "printf '\044(flagged.cmd)'"
rvr set -G mid '$(emit.cmd)'
rvr set -G top '${mid}'
rvr run top        # runs flagged.cmd with no confirmation

rvr set -G emits "printf '\044(touch /tmp/spliced)'"
rvr set -G wrap 'echo $(emits)'
rvr run wrap       # the shell runs the output
```

## Timeline

- 2026-11-25 — Found during review of the confirmation gate (#234); verified on 1.3.0 and main; filed as #242.
- 2026-11-26 — Fixed in #251, merged to main; not yet released.

## Credit

Found and fixed internally.
