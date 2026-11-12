# dsh-trivium 0.8.9

This release fixes workspace write ownership and delivers issue #5's live read queries, independent snapshots and snapshot CLI. It includes feature commit `9d7b96a` and handoff commit `45132e6`.

## Writes and compatibility

Switching libraries discards old rows and cancels pending deletion confirmation. Edit, merge, archive and delete use the displayed entry's workspace. Late proposal outcomes and deferred-write reads also check their source. Proposal tokens use canonical filesystem paths. Chip creation and bulk archive/delete acquire the workspace write lock and return 409 while it is busy.

The peer range explicitly accepts the tested DSH 0.2.2 prerelease series. Partial imports have their own receipt state. Zero new facts may still include merges. Audit rows retain declined candidate IDs and distinct operation IDs, and confirmations record the HTTP surface and relation operation. Destructive actions live inside the shared entry detail across all layouts.

## Live queries and independent snapshots

`POST /api/dsh-trivium/query?cwd=...` accepts `tql`, scalar `params` and `limit`. The read-only native session rejects mutation syntax. Replies identify the live source, rows and truncation. Defaults are 200 rows and 25ms, with maxima of 1000 rows, 50ms and 512KiB of encoded response.

Native deadlines are cooperative. Synchronous execution occupies the host event loop, and sorting/aggregation retain their full input semantics. Budget rejection returns 422 and a deadline returns 408. Successful pagination and rejected work are reported separately.

Explicit `POST /snapshots` captures an independent generation. Later writes leave that snapshot stable. Snapshot queries run in a separate process with parent-enforced timeout and bounded output. `dsh-trivium-query --snapshot ...` is included, and the integrity CLI accepts snapshots too. Capture copies files and consumes disk space. [Usage and limits](read-api.md)

## Settings from PR #4

The per-turn injection allowance defaults to 300 tokens, accepts explicit zero, and is capped at 2000. Clearing the input restores 300. Preview and actual injection use the same allowance. Tool-recovery extraction can be disabled and remains enabled by default.

## Upgrade and acceptance

Run `dsh plugin --profile web add dsh-trivium@0.8.9` and restart the host. Standard npm consumers can run `npm install dsh-trivium@0.8.9` with real peers matching their DSH distribution.

The kernel remains triviumdb 0.9.0. Existing 0.8.8 data uses the same format. Disputed automatic edges from 0.8.6 can be revoked individually. The READMEs retain the full backup requirements for older format upgrades.

The [company-machine acceptance record](reviews/0.8.9-RESULTS-2026-11-12.md) documents regression, load, package installation and real-host checks.

## Publication receipt

- npm latest is **0.8.9**, published **2026-11-12T02:18:47.968Z**.
- Accepted source and the remote annotated tag v0.8.9 identify **63d4db2e1888fb2eaf93076ed68df1f302837d62**.
- Published tarball **291567 bytes, 57 files**. Source, archive and strict installation match byte for byte. CLI files use LF to preserve bytes through npm installation.
- SHA-1 `0fd2ba389c96bde358f94a55a37211ba4ed5535a`.
- Integrity `sha512-IdoG+PEIyqi0JOzviCjwnS7OF2mvRBQ+7g+6VuA8B2fVmetw4HrQG6khG2ISjCjxFl2PSSdcnXDnlLywI2YqHA==`.
- A fresh registry tarball download has the accepted SHA-512. Registry metadata omits gitHead for this tarball publication, so the commit, immutable tag and file/integrity comparison establish provenance.
- The [GitHub Release](https://github.com/QWQcool/dsh-trivium/releases/tag/v0.8.9) attaches the same tarball. The [issue #5 reply](https://github.com/QWQcool/dsh-trivium/issues/5#issuecomment-6812483522) records the upgrade command and limits.
