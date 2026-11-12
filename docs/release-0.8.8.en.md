# dsh-trivium 0.8.8

**A write-correctness patch plus a panel re-layout.** 0.8.7 turned replacements into proposals; this
release fixes the three edges where proposals still went wrong in real use (workspace switching,
cross-library tokens, missing audit rows), and puts the work first on the Activity page.

The kernel is unchanged: still `triviumdb@0.9.0` (shipped in 0.8.5). Verified host:
`@deepseek-ai/dsh@0.2.2-rc.1`.

## 1. A proposal can no longer cross libraries (F88-01)

**Switching workspaces could leave the old workspace's response on screen.** The selector showed B
while the card still showed A's sentence; pressing "Keep both" sent the request to B — the server
answered 200 and **declined B's proposal**, while A's stayed pending.

Two halves:

- **Client** — the list is blanked before the read, the request carries the workspace it was read
  for, a late response is dropped by sequence *and* workspace, a switch invalidates both the list and
  the request in flight, and a submit re-checks that the row belongs to the current library.
- **Server (defence in depth)** — `proposalEtagOf` folds the **workspace** into the token. Two
  libraries can hold a proposal with the same node id, text and node-level ETag; A's token presented
  to B now answers `409 proposal-stale`.

The card explains what happened: "The workspace changed; that proposal belongs to the previous
library, so the list was reloaded."

## 2. Confirming and declining both leave an audit row

- Confirm → the change log gains `supersede-confirmed` with the successor, the retired fact and the
  surface that made the call.
- Decline → `supersede-rejected`.

Before this, "who confirmed or declined what, and from where" could only be guessed from relation
metadata. The outcome is now also shown **in the card** ("Kept both: proposal #3 declined, both
decisions stay current"). If the action succeeded but its audit row was not written, the card says
both things instead of pretending one of them did not happen.

## 3. Interactive writes take the workspace lock too

0.8.7 covered confirm / reject / supersede / revoke. This release adds **node edit, merge, archive and
delete**: while another process is writing, they answer `409 WORKSPACE_WRITE_BUSY` instead of "the
panel says it worked while the library is locked".

Two groups deliberately stay outside, stated here so "all writes are locked" is not read into it:

- file-only writers: settings, chips, pins, sidecar;
- long admin jobs: `map/backfill`, `map/cut`, `embed-backfill` — holding the interactive lock for
  minutes would stall extraction.

`smoke-p89` now holds the lock in a **real child process** and checks all six routes.

## 4. A partial import no longer reads as "rejected"

External Markdown import is a batch, not a transaction: the server answers 500 after writing part of
it, and those nodes are already in the library. The panel keeps the response body now and reads
`partial`, `newNodesBeforeFailure` and `retryHint`:

- **zero** written before the failure, **N** written, or **unknown** count — three different sentences;
- the receipt sits under the import button, as the result of that press.

## 5. Panel re-layout

| Area | Change |
|---|---|
| Activity | "Replacements to confirm" moves to the **top** (the only card on that page waiting for a person); each candidate shows its **body**, not just a name; the result of a decision appears in place |
| Library | Search owns the first row; the type filter and the two visibility toggles move behind "Filters (n)"; archive/delete move into the **expanded detail**; the archive/delete/merge legend follows the filter |
| Settings · vectors | An explicit **"Save connection"** under URL/model/key — before this the fields were only persisted when some unrelated toggle happened to write the whole flag set |
| Import | Receipt moved below the button (see §4) |

The four-page navigation and `Ctrl/Cmd+K` are unchanged.

## 6. Diagnostics and docs

- Deleting a node now clears its heat entry (the sidecar used to keep an invisible record);
- identity merging keeps its calibration corpus and gate (zero false merges, recall floor 7/11);
  `identityMerge` stays off by default;
- new `smoke-p91`: the version a document advertises must equal `package.json`, and release notes may
  not read as a plan. That is the machine check for "README was one release behind".

## Verification

```
node scripts/run-all.mjs        → 86/86
node scripts/smoke-p89.mjs      → 81/81 (P contract + cross-process lock + cross-library token)
node scripts/smoke-p24.mjs      → 12/12 (library interactions)
node scripts/smoke-p26.mjs      → 19/19 (receipts and confirmations)
node scripts/smoke-p91.mjs      → 12/12 (version declarations agree)
npm pack --dry-run              → see the publication receipt
```

Real-host inspection (Playwright, 760px and wide, isolated workspace): proposals first with candidate
bodies, in-place result after a decline, collapsed filters, archive/delete only when expanded, and the
vector save button.

## Upgrading

`npm install dsh-trivium@0.8.8` or `dsh plugin add dsh-trivium`. **No data-format change** from
0.8.7 — nothing to convert. Edges that 0.8.6 created automatically stay as they are (no rollback);
disputed ones are handled one at a time with "revoke replacement".

`supersedeMode: "auto"` is unchanged: it still restores the old automatic behaviour from
`~/.dsh/trivium.json`, but that is not the recommended setting.

## Post-release acceptance erratum (2026-11-11)

**Independent acceptance failed.** In DSH 0.2.2-rc.1, the previous workspace's memory list can remain visible after a switch. The deletion dialog can show the old entry while the request permanently deletes an entry with the same ID in the newly selected workspace. After switching, refresh the library, wait for the target workspace's list to load, and verify the entry before acting.

The ordinary two-workspace proposal check and all six listed lock checks passed. Distinct directory names that lowercase to the same string can still share proposal tokens. Chip creation and bulk deletion write to the main store and can bypass the workspace lock. A partial external import reporting zero new nodes may already have updated an existing fact. The published tarball ran on the tested host after manual extraction, but a standard clean npm install with that host's real peers failed with `ERESOLVE`. The [independent acceptance report](reviews/0.8.8-INDEPENDENT-ACCEPTANCE-2026-11-11.md) records the audit and UI findings, reproduction steps, and host screenshots.
