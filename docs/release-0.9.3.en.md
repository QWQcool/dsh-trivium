# dsh-trivium 0.9.3

This release pins `triviumdb@0.9.3`. For an existing format 15 workspace, run the 0.9.3 `dsh-trivium-upgrade prepare` before the first writable open. [中文](release-0.9.3.md)

## Added

- The document evidence panel under Context can preview and confirm an import of UTF-8 `.md` and `.txt` files within the workspace. Identically named files in different import roots remain separate sources, and existing source and citation IDs are retained. A stale preview requires a fresh preview. After import, open the affected facts to compare their original citations with the new revision.
- Local handoff assignments can grant `canRead` and `canWrite` separately. Existing assignments retain both permissions. [Handoff protocol](handoff-protocol.md)

## Improved

- Format 15 libraries upgrade in place. The plugin checks for a retained copy or the library's current kernel marker before creating a writable handle. After a direct package replacement, the panel prompts for `prepare` if the existing library still needs it. New workspaces can open immediately. Format 13 migration uses the official TDB 0.9.3 converter. [Kernel upgrade and rollback](kernel-upgrade.md#english)
- Entity-scoped search uses a small set of bilingual text matches as a fallback. The new `ctx_find` argument `followup_cursor` can reuse still-valid evidence for the same task and entity. Across the same 35 questions, missing evidence fell from 7 to 0 with zero forbidden evidence, non-numeric IDs or budget overruns. In eight isolated Web model calls, numeric citations scored 8/8 and exact answer strings scored 7/8. The one difference was the order of CSV and UTF-8. No embedding calls were made. [Retrieval results](reviews/MEMORY-CITATIONS-2026-11-20.md#2026-11-23-漏召回复验)

## Removed

None. Uninstall continues to retain memory by default. Files under a moved import root become separate sources. Their original citations remain readable.

## Upgrade, recover and roll back

1. Stop every host that uses the workspace. Run `status` and `check` with the upgrade command from npm `dsh-trivium@0.9.3`. Run `prepare` for format 15 or use the official converter with `migrate` for format 13.
2. Confirm `phase: active`, `targetKernel: "0.9.3"`, `activeFormat: 15` and the `before` directory. Replace the plugin with `add` in its original profile and reopen the workspace. Format 15 snapshot IDs remain readable. Format 13 snapshots stay available to the original engine. Capture a new snapshot of the current library after migration if needed.
3. After an interruption, leave all hosts stopped and use `status` to choose the resume command. For rollback, restore the complete original group with the 0.9.3 `rollback` command before reinstalling the original plugin. The `after` directory retains writes made with the new version.

See the [upgrade guide](kernel-upgrade.md#english) for runnable commands, the official converter and recovery by phase.

## Verification scope

The earlier format 13 migration, bilingual retrieval and directory import checks carry forward. Model evidence covers the eight questions above. The final tarball's clean install and format 15 checks are recorded in [candidate verification](kernel-upgrade.md#093-候选包验收).

## Publication receipt

- npm published `dsh-trivium@0.9.3` at **2026-11-23T03:49:37.977Z** under the `latest` dist-tag. [npm version page](https://www.npmjs.com/package/dsh-trivium/v/0.9.3)
- Git tag `v0.9.3` points to the verified source commit `1fe3c6e11be5f1a0610cb4114e863ec7f8858f64`. Downloads from npm and GitHub both matched the tested tarball byte for byte. The archive contains 70 files in 377638 bytes. [GitHub Release](https://github.com/QWQcool/dsh-trivium/releases/tag/v0.9.3)
- npm SHA-1 `6fb84f89384c81b014900aedc5007ba18966f6f7`.
- npm SHA-512 integrity `sha512-/GAtgGTNpu4d7uRqQgm73tFj+TzEWkbKHcgVPItZzrqTBhImNyUiOBSdXJfQNYGuBE/S5t35gA1eot+u56k4Sw==`.
- Archive SHA-256 `e99554261538f0feca1dd8b8ee60089bf4c1a8e74de7fa247eae2216e96d7d37`.
- The tested archive was published as packed and the bundled README still reflects the candidate stage. The repository's upgrade guide has the current npm commands. [Upgrade guide](kernel-upgrade.md#english)
