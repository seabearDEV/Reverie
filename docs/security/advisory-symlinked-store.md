# GitHub Security Advisory — source record (DRAFT)

> DRAFT GHSA-62qw-v74v-wxc6 (not published). Publish only on the owner's decision; the GHSA form,
> once published, is canonical and this file becomes its internal source record.
> Scoped as a GENERAL advisory (ecosystem `other`, name `reverie`), like
> GHSA-hf25-j9h5-5vq5: `@seabear/reverie` is never published to npm
> (`project.distributionChannels`). Tracking issue: #159. Fix: #160.

---

**Title:** Symlinks in a `.reverie/` store let reads and writes escape the store directory

**Ecosystem:** other (general advisory — not npm; package never published)
**Affected versions:** `<= 1.2.2`
**Patched versions:** `1.3.0`

**Severity:** Medium
**CVSS v3.1:** `CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N` (Base 4.4) *(estimate — adjust on the GHSA form)*
**CWE:** CWE-59 (Improper Link Resolution Before File Access)

## Summary

A project's store is the `.reverie/` directory in its repository, and git preserves symlinks. In affected versions Reverie followed symlinks inside the store:

- **The store directory:** project-store discovery used `stat` and accepted a `.reverie` (or legacy `.codexcli`) that was a symlink to any directory. The check that keeps an entry's file inside the store compared paths lexically, so it passed too.
- **Entry and sidecar files:** an entry file that was a symlink was read through the link. Its target's contents could then surface as that entry's value.
- **The temporary file of an atomic write:** its name was predictable (`<entry>.json.tmp`), and a symlink planted there was followed when the write landed.

## Impact

From a cloned repository, under the privileges of the user running `rvr` or the Reverie MCP server:

- **Writes outside the repository:** if `.reverie` is a symlink to, say, `$HOME`, any store write (`rvr set project.note hi`) writes the entry file and the store's sidecar files there, overwriting files of the same name: `_README.md`, `_epoch.json`, `_aliases.json`, `_confirm.json`.
- **Overwriting a chosen file:** a `<entry>.json.tmp` symlink to a victim file made the next write of that entry overwrite the victim with the entry's JSON.
- **Reads of a chosen file:** an entry file that is a symlink to a file outside the store was read as that entry, so its contents could reach the user or an agent through `rvr get` or `reverie_get`.

## Proof of concept

A hostile repository commits its store as a symlink:

```
ln -s ~ .reverie && git add .reverie && git commit -m store
```

A developer clones it and writes anything to the project store:

```
rvr set project.note hi       # writes project.note.json, _README.md, _epoch.json … into ~
```

## Patches

Fixed in **1.3.0** (#160):

- **Store directory:** the checks on the store's own directory use `lstat` and refuse a symlink. The directories that contain it are still followed, as macOS's `/tmp` requires.
- **Reads:** every read of a store file goes through `readStoreFile`, which refuses a symlink.
- **Writes:** the temporary file of an atomic write gets a random suffix and is opened exclusively (`wx`). A write that replaces an entry file which is a symlink replaces the link and does not write through it.

Regression tests cover the symlinked store directory, the planted temporary-file link and a symlinked entry file.

## Workarounds

For unpatched versions: before running `rvr` or the Reverie MCP server in a cloned repository, check that `.reverie` and the files in it are not symlinks (`find .reverie -type l`, and `ls -ld .reverie`). Upgrade to 1.3.0 or later.

## Timeline

- 2026-07-23 — Found by the pre-release agentic audit for 1.3.0 (Leg B, `docs/security/release-process.md`); filed as #159.
- 2026-07-23 — Fixed in #160; released as 1.3.0.

## Credit

Found and fixed internally during the pre-release security audit.
