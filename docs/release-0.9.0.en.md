# dsh-trivium 0.9.0

Version 0.9.0 delivers data-preserving uninstall, source-aware extraction and same-turn redundancy suppression, pending-source review, explicit entity-scoped search/task packs, and TriviumDB 0.9.1. Runtime code retains the verified `10e09ac` baseline; this release changes version metadata and documentation.

## Shipped changes

- Remove the old `preuninstall` cleanup hook. Uninstall retains memory, settings, pending candidates, sidecars, snapshots, change history and preference exports. Historical duplicate nodes are retained.
- Distinguish verified memory-tool echoes from new facts. Model candidates without verifiable support remain durable pending candidates, without repeated paid replay of an unchanged source or blocking independent windows.
- Suppress a complete same-turn rule wrapper only after its covering fact survives the source, secret, date and budget gates. Preserve rule fallback and durable preferences. Read-permission assertions are no longer treated as read requests merely because they contain “读取”.
- **Activity → Pending** provides bounded excerpts, a local supporting-evidence check and explicit manual confirmation. Confirmation inserts content, retains existing facts and does not infer replacement relations. Workspace/candidate ETags, durable receipts and flush-before-ack protect retries. Missing source sequences stay null.
- **Context** includes entity-scoped lexical/semantic channels and live/snapshot provenance. Task packs are explicit (`packTokens`, default 0), contain whole facts, paths and recorded sources, and retain unresolved same-name alternatives. They are not connected to tools or default automatic recall.
- Include previously implemented batched persistence, unchanged-text index skipping and groups of 16 vector updates. Historical performance numbers apply to their specific synthetic workloads; single-write latency spikes remain open.
- Pin `triviumdb@0.9.1`. The four tools, quiet injection defaults and human-confirmed replacement proposals remain.

## Upgrade and data retention

1. Fully exit the desktop application, including its tray process, or stop the Web host. **Do not uninstall published 0.8.9 first**: it contains the old destructive cleanup hook.
2. Replace the plugin directly in its existing profile:

   ```sh
   dsh plugin --profile desktop add dsh-trivium@0.9.0 --ignore-scripts
   ```

   For Web, use `dsh plugin --profile web add dsh-trivium@0.9.0 --ignore-scripts`. The flag skips package lifecycle scripts. Keep the original `.dsh` paths and workspace.

   If `dsh` is not on PATH on Windows, use the desktop-bundled CLI:

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-trivium@0.9.0 --ignore-scripts
   ```

3. Restart the same host. Uninstalling the fixed 0.9.0 package retains data; erasing data remains an explicit user file operation.

**Plugin and kernel versions differ.** Published plugins 0.8.5–0.8.9 used TDB 0.9.0; this release uses TDB 0.9.1. Opening/checkpointing with the newer writer can advance storage to `.tdb` v13 / WAL v6. An older kernel cannot read that format. If rollback is required, retain the complete pre-upgrade `.dsh` file group before first open, including vector, WAL, text, index and payload sidecars. Neither `.tdb` alone nor Git JSONL is a complete copy. Restoring a previous copy loses later writes; do not let an older writer modify the newer format.

The existing local desktop already uses TDB 0.9.1. Publishing this package does not install into, restart or migrate that instance, and does not operate on its memory files. Existing damaged libraries are not automatically repaired.

## Reused evidence and release scope

The verified runtime baseline passed **93/93** regression cases, **30/30** controlled panel checks and **13/13** clean-consumer checks outside the source tree. The preceding desktop update preserved **39 files and 3 databases** byte-for-byte; its restarted native host read the existing four-node workspace. [Delivery receipt](reviews/DESKTOP-QUALITY-UPDATE-2026-11-17.json)

The frozen 26-scenario corpus has zero remaining known rule copies (previously three), 9/9 expected facts retained, 6/6 old facts intact, and unsupported A3 still pending. Direct real-model answers scored 12/12 with existing recall and 10/12 with entity packs. [Methods, raw responses and limits](reviews/MEMORY-QUALITY-2026-11-17.md)

At the user's request, this publication reuses those results rather than rerunning release regression, installation, desktop or model experiments. Only metadata/documentation, tarball contents and registry publication records are checked now. Existing results primarily cover Windows/Node 24; the other declared environments receive no new validation here. English/cross-language lexical misses, arbitrary semantic entailment, multi-model generalisation and full multi-turn Agent behaviour remain limited. There is no general quality/cost superiority claim, and monetary billing is not measured.

## Publication receipt

- npm **0.9.0** is published with dist-tag **latest**. Registry publication time: **2026-11-17T07:43:32.372Z**. [npm version page](https://www.npmjs.com/package/dsh-trivium/v/0.9.0)
- Published source and the pushed annotated tag `v0.9.0`: **a3d39ceec3ec223b98db1d618373d333883162f6**. Main fast-forwarded to include the preceding features and version/documentation update. This receipt is committed separately without moving the tag.
- Artifact: **328452 bytes, 62 files**, TDB **0.9.1**. All 53 runtime files are byte-identical to the previously verified local desktop package. The destructive uninstall hook, evaluation bridge and memory databases are absent.
- SHA-1: `1f7ef805c9b96fb97d9e91af22662d3e2f2f5755`.
- SHA-256: `8b08b3e204969ab8f20f221eb0eb12498ff406d040c06e6aae4f5e774e587cb8`.
- Integrity: `sha512-aFL4S9krbYugUbGA3RHi/93dh12/gV8MDNtv7Mn5DQXZilgJ72TEzb3GDvY0Gtxbw6nX8cIOhR6hhQFnoOHnPg==`.
- Registry version, dependency, latest and checksums match. A cache-bypassed tarball download matches the local publication artifact. The canonical URL's initial cached 404 has expired; it now returns 200 and the same checksum. [Structured receipt](reviews/NPM-RELEASE-0.9.0-2026-11-17.json)
- No runtime experiments, model calls, desktop operations or memory-file operations were repeated for this publication. Original evidence remains unchanged.
