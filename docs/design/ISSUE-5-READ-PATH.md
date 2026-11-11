# Issue #5: bounded live reads and independent read snapshots

Status: implemented and locally verified, based on main `5c8f685`; not released.

## Problem and scope

A host owns the workspace writer. A second process cannot use `readOnly` on
the same active file group. Exporting the entire graph is unnecessarily costly
for an ordinary graph question. PR #4 did not address this read path.

This change keeps the single-writer contract and adds two explicit read sources:

1. **Live**: `POST /api/dsh-trivium/query?cwd=...` borrows an already-open
   workspace handle. Named queries cover nodes, one-hop neighbors and entities
   with no business edge. Parameters and work/result/response limits are owned
   by the server. Querying never opens, creates, repairs or synchronizes a store.
2. **Snapshot**: `POST /api/dsh-trivium/snapshots?cwd=...` asks the existing writer
   for an independent `createSnapshot()` directory and verifies it. Arbitrary
   read TQL runs against a selected snapshot in a separate, bounded process,
   through `/query` with `snapshotId`, or the packaged snapshot query CLI.
   Every result identifies its source; snapshot results include their generation.

Native `ConsoleSession` supplies read-only command enforcement, parameter
binding, response budgeting and cooperative deadlines. TriviumDB 0.9.0 lets
explicit LIMIT override its default row budget, so raw user TQL is not run on
the host thread. A JS timer cannot interrupt a synchronous native query.

## Snapshot lifecycle

Snapshots live in `.dsh/read-snapshots/`, with generated IDs and a latest pointer.
Creation is manual/on demand, uses the host write-operation lock, and publishes
the latest pointer only after verification. Source writes may continue after
capture; published snapshot directories stay immutable. No periodic flush hook,
live-file manifest publishing, automatic retention or deletion is introduced.

Publishing a manifest on an actively changing file group is not a stable
snapshot: subsequent persisted changes invalidate that manifest. Native
`createSnapshot()` captures and publishes an independent complete file group.

## Implementation order

- [x] Implement bounded named live queries and regression coverage.
- [x] Implement independent snapshots and isolated read-TQL execution.
- [x] Integrate HTTP routes, bounded request reads and already-open lookup.
- [x] Provide snapshot query CLI and snapshot-aware integrity checking.
- [x] Document contracts and examples in both READMEs.
- [x] Validate with real HTTP, separate reader processes and full smoke suite;
      check package contents and review the resulting changes.

## Acceptance

- A writer remains open while a separate client completes live graph queries.
- Unknown or unopened workspaces are rejected without creating files or opening
  another writer. Query results do not change facts, links or usage bookkeeping.
- Invalid operations, excessive request/response sizes, work limits and busy
  query admission return explicit errors rather than silently claiming success.
- An independent snapshot remains readable after source writes and after host
  shutdown. A failed capture/verification cannot replace the last valid pointer.
- Snapshot TQL rejects writes, binds parameters, caps returned rows/bytes and
  runs in a killable process with a wall-clock timeout. Explicit LIMIT cannot
  turn a snapshot query into unbounded work on the host event loop.
- Existing CLI behavior remains compatible; snapshot checks are explicit.
- Tests use isolated temporary databases and settings, never the live workspace.

## Delivery

Work on `codex/issue-5-read-path`. This task implements and verifies the change;
version publication and an issue-closure claim follow verified delivery. Keep
known limits explicit: live queries use named templates, snapshots are point-in-
time copies with a disk cost, and snapshot retention is manual.

## Verification receipt (2026-11-12)

- `node scripts/run-all.mjs`: **91/91 scripts passed**. New p93 live-query
  checks: 13/13; p94 snapshot checks: 24/24; p95 integrity CLI: 20/20;
  p96 real HTTP integration: 25/25.
- Built an npm tarball and installed it into a clean consumer whose path
  contains a space. Snapshot capture, isolated TQL, snapshot
  integrity and both CLI help commands succeeded while the source writer stayed
  open. Packaged CLI shebangs use LF.
- Final tarball contains 56 files. All packaged runtime and script contents
  match the source after normalizing checkout line endings.
- Integration review clarified metadata semantics: snapshot GET is a publication
  record (`integrity: "verified-at-capture"`), not a fresh CRC health check.
  Every snapshot query re-verifies the file group inside its bounded worker.
- The 1000-node live work limit and manual snapshot retention are deliberate
  first-version constraints, documented in `docs/read-api.md`.
