# dsh-trivium 0.9.2

**Migrate existing TDB 0.9.1 libraries offline before installing 0.9.2.** This release pins `triviumdb@0.9.2` and moves the workspace database from main file format 13 to 15. New workspaces can use it directly. The feature baseline is `ad3499b`. [中文](release-0.9.2.md)

## Added

- The npm package ships `dsh-trivium-upgrade`. It uses the official TDB converter, verifies the database, and switches the complete `.dsh` group while retaining the original library, document references, pending review items, and handoff receipts. Interrupted operations can be inspected, resumed, or rolled back.
- The workspace status distinguishes a required migration from an unfinished upgrade. The new host blocks writes during a switch to prevent an empty database from being created at the original path.

## Improved

- Automatic recall and explicit task memory packs include matching entity aliases within the existing budget so the model can use retrieved evidence in cross-language follow-ups. Full packs use JSON numbers for fact and path IDs. The panel API retains its string IDs for compatibility. Memory packs remain opt-in with a default budget of 0.
- Document revisions flag only the affected facts. A moved quote with the same enclosing lines and heading path can be verified without review. Existing references keep their original text and revision.
- Background extraction uses recorded memory deliveries to suppress exact echoes. Reworded candidates with uncertain sources can go to review. Independently sourced facts from the same turn can still be saved, including standing settings explicitly stated by the user.

## Removed

None. Public tools and existing memory are retained.

## Upgrade and data retention

1. Quit all desktop instances using the workspaces, including the tray process. Stop Web, Router, Workers, and any read-only processes that use the libraries. Migrate each legacy library you intend to use in its original workspace. The workspace path is the directory containing `.dsh/trivium.tdb`. Allow disk space for the original files, the new files, and migration staging.
2. Check out the official TriviumDB `v0.9.2` tag and build the standalone converter from that checkout. Python 3 and a Rust toolchain are required. [Official migration and build instructions](https://github.com/YoKONCy/TriviumDB/blob/v0.9.2/docs/migration.md)

   ```sh
   cargo build --locked --manifest-path crates/triviumdb-migrate/Cargo.toml --target-dir target/migration
   ```

3. Run the preflight and migration commands with your workspace and checkout paths. If the converter was built elsewhere, pass `--tool` with the executable path to `check` and the initial `migrate`. Use `--python` to select a Python 3 command or executable. If preflight reports a missing database coordination lock file, open and close the old library normally in the previous host, then retry offline.

   ```sh
   npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade status "D:/projects/my-project"
   npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade check "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.2"
   npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade migrate "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.2"
   npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade status "D:/projects/my-project"
   ```

4. When `status` reports `phase: active` and `activeFormat: 15`, replace the plugin in its existing profile. Restart the same host and open the original workspace. For Web, use `--profile web`. Use direct replacement because the legacy 0.8.9 uninstall hook can remove memory.

   ```sh
   dsh plugin --profile desktop add dsh-trivium@0.9.2 --ignore-scripts
   ```

   On Windows, use the bundled desktop command if `dsh` is unavailable on PATH.

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-trivium@0.9.2 --ignore-scripts
   ```

Keep `.dsh-trivium-upgrade/`. The `before` path from `status` contains the complete original library. Keep the directory out of version control because it contains memory and source data. Existing read-only snapshots are retained. Capture fresh snapshots for TDB 0.9.2. [Migration details and isolated validation](kernel-upgrade.md)

## Recovering from a failed or interrupted migration

Keep all hosts stopped and run the `status` command above from the original workspace path.

| Status | Action |
|---|---|
| `preparing` | The original library is still at `.dsh`. Check the converter path, stop any processes with the library open, and check disk space. Rerun `migrate` with `--upstream` after fixing the error, or run `rollback` to cancel. |
| `activating` | Rerun `migrate` to finish the switch. You can omit `--upstream` at this stage. Run `rollback` if you need to restore the original library. |
| `rolling-back` | Rerun `rollback` to finish restoring the original library. |
| Verification or directory conflict | Retain every file in `.dsh` and `.dsh-trivium-upgrade/`. Inspect `status`, the operation journal, and the workspace path. The tool stops before overwriting a directory that differs from its journal. |

If preflight fails, resolve the error and rerun `check`. A forcibly stopped process can leave a workspace lock that takes up to about 30 seconds to expire.

## Rolling back to 0.9.1

With all hosts stopped, run the **0.9.2 upgrade command** to restore the original library. When `status` reports `phase: rolled-back` and the original format, replace the plugin with 0.9.1 and open the original workspace. Writes made after migration are retained in the `after` directory reported by `status`. The restored library resumes from its pre-upgrade state.

```sh
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade rollback "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade status "D:/projects/my-project"
dsh plugin --profile desktop add dsh-trivium@0.9.1 --ignore-scripts
```

Use `--profile web` for Web. The rollback version above is for a library from TDB 0.9.1. For an original library from a different engine version, reinstall the previous plugin that could open it after restoring the library.

## Validation and scope

- Isolated Web acceptance covered format 13 to 15 migration, reading and writing after restart, recovery from interrupted switches, and rollback. The synthetic library included 9 nodes, 11 relationships, vectors, one document with a reference, and four handoff receipts. All 12 files in the restored library matched the original byte for byte. [Storage acceptance](kernel-upgrade.md#隔离-web-验收)
- Three runs of the fixed cross-language corpus scored 15/15 for both answers and numeric citations, with zero `unknown` responses when evidence supported an answer. The document revision flagged the 5 affected facts among 22 links, and original references remained readable. [Evaluation and scoring details](reviews/FOLLOWUP-DOCUMENT-REVIEW-2026-11-19.md)
- In isolated Web with a live model, both recall-only cases added zero memories. The mixed case saved exactly one sourced new setting. Original nodes and relationships remained after reopening the database. These results cover the tested cases and model. [Memory echo acceptance](reviews/TASK-RETRIEVAL-WRITE-DOCS-2026-11-18.md#2026-11-20-自动召回实机复验)

## Publication

- `dsh-trivium@0.9.2` pins TDB 0.9.2 and uses source tag `v0.9.2`. [npm version page](https://www.npmjs.com/package/dsh-trivium/v/0.9.2)
