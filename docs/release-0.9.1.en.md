# dsh-trivium 0.9.1

Version 0.9.1 adds named entity lookup, compact task memory, document evidence, and local Worker handoff. It pins `triviumdb@0.9.1`. The feature baseline is `11ee0aa`.

## Added

- The entity search panel and `ctx_find` support names and aliases within the selected workspace. Ambiguous matches require an explicit entity ID. Snapshot queries use the names captured in the snapshot. An explicit entity in `ctx_find` can return a compact pack, with changes available through a cursor. [Read API and tool options](read-api.md#按需任务记忆091)
- **Context → Document evidence** accepts selected Markdown and UTF-8 text files or pasted text. Link a short excerpt to an existing fact and track the source revision for review. [Document evidence API](read-api.md#文档依据接口091)
- **Activity → Pending** can show existing facts with the same text, dismiss a candidate while retaining its sources, and page through review history.
- Local Super Agent handoff uses explicit project and ticket scope, a durable central inbox, and delivery receipts. Handoff candidates can be reviewed on the Pending panel. [Handoff protocol](handoff-protocol.md)

## Improved

- Bounded English and cross-language lexical matching recovers known misses. Scoped lexical and map reads can reuse in-process results. Changes to data, links, expiry, or source invalidate stale results.
- Automatic extraction persists its event window before awaiting the model. Timeouts leave recoverable work. Rephrased memory results without independent support remain pending. Review retries can reuse durable writes, and matching facts from the same recorded source share one node across Worker deliveries. Each delivery keeps its own receipt.
- Settings follow `DSH_HOME` by default. Settings, Git sidecar and usage-record replacements preserve the prior file on failure. Workspace health distinguishes corruption, locking and other read failures, with other workspaces still available to select.
- Document sources and links are paginated and can be read by fact or source. Prior citations remain available for review. [Validation and current state](CURRENT-STATE.md)

## Removed

- Removed the 1024-entry truncation of review history, deletion of the previous settings or sidecar file after a failed replacement, and the full-text scan of unrelated records in document evidence reads.
- Removed the paths that accepted late extraction writes after a timeout or treated a memory-tool echo as independent evidence. The four public tools, existing facts and evaluation fixtures are retained.

## Upgrade and data retention

1. Quit the desktop app completely, including the system tray, or stop the Web host. Replace the plugin directly in its existing profile. Direct replacement is especially important for 0.8.9, whose uninstall hook can delete memory.
2. For desktop, run `dsh plugin --profile desktop add dsh-trivium@0.9.1 --ignore-scripts`. For Web, use `--profile web`.

   On Windows, the desktop app includes a command to use when `dsh` is unavailable on PATH.

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-trivium@0.9.1 --ignore-scripts
   ```

3. Restart the same host and open the original workspace. Retain its full `.dsh` directory, including the complete database file group, document evidence, snapshots, pending windows, review history, and handoff inbox. Plugin versions 0.9.0 and 0.9.1 both use TDB 0.9.1 and need no format migration between them. Retain the complete pre-upgrade file group before moving from a plugin that uses TDB 0.9.0. [Earlier upgrade and rollback instructions](release-0.9.0.en.md#upgrade-and-data-retention)

Settings resolve in this order. `DSH_TRIVIUM_SETTINGS`, `$DSH_HOME/trivium.json`, then `~/.dsh/trivium.json`. Use the explicit setting to continue reading an existing settings file with a custom `DSH_HOME`.

To roll back to plugin 0.9.0, quit the host and directly replace the plugin using the same command with `@0.9.0`. Keep `.dsh` and the settings file in place. Pending extraction windows remain readable in 0.9.0. The full review history and handoff records are available again when returning to 0.9.1. With a custom `DSH_HOME`, point `DSH_TRIVIUM_SETTINGS` to its `trivium.json`.

## Validation and scope

- This release uses the focused regression and isolated Web evidence for data reliability, entity name lookup, and local handoff. Two automatic handoffs shared one node with two receipts. Review reuse and dismissal retained their own receipts. [Validation details](CURRENT-STATE.md)
- On the fixed multi-turn corpus, all three methods answered 11 of 12 correctly. Compact packs with a cursor used 20.3% fewer input tokens than normal recall on that corpus. [Measurements and per-turn results](reviews/MEMORY-MULTITURN-2026-11-19.md)
- Document evidence reads selected sources. The local handoff protocol requires a trusted local host and explicit configuration. Entity scope, pack budgets and cursors are opt-in.

## Publication

- npm published `0.9.1` at **2026-11-19T10:54:10.464Z** with dist-tag `latest`. The kernel is TDB 0.9.1. [npm version page](https://www.npmjs.com/package/dsh-trivium/v/0.9.1)
- Git tag `v0.9.1` points to release source `1b93983c9adcf186f4343f3fd47883afc1418ead`. The tarball has 67 files and 357603 bytes. The public download matches the local release artifact byte for byte.
- SHA-1 `a4873464eccc0d101f454ba818468837b11a4f1b`
- SHA-256 `6a2dd5a2b2afcc52e8151416f7fdcb0352de7e8ae656068ba923686c2fcc191b`
- Documentation and clean-install verification each passed 13 checks. The release reuses the feature acceptance evidence above and uses a synthetic store for package verification.
