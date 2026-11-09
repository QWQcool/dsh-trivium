# 0.8.7 — a replacement becomes a proposal

2026-11-09. **The kernel does not change** (still `triviumdb@0.9.0`; that upgrade shipped in 0.8.5).
This release changes one thing: **a change of mind no longer retires a decision by itself**.

## What changed

### The automatic path records an intent, not an edge

Up to 0.8.6, wording that looked like a correction wrote a `supersedes` edge immediately and the old
decision dropped out of the short map. Four review rounds showed that **wording is not
authorisation** — the model retired decisions it was merely paraphrasing.

Now:

- extraction stores `review: "supersede-proposed"` plus the candidates `proposedSupersedes: [id…]` on
  the new node;
- **the old decision is still current**; there is no edge, and `ctx_find` / `ctx_read` still return it;
- an ambiguous label ("plan A" twice) keeps **every** candidate, and a person picks one. The plugin
  does not guess.

### A person confirms, and the confirm re-checks first

| Action | Endpoint |
|---|---|
| list what is waiting | `GET /api/dsh-trivium/supersede-proposals` |
| confirm one candidate | `POST /api/dsh-trivium/supersede-proposals/<id>/confirm` (`targetId` + `etag`) |
| keep both | `POST /api/dsh-trivium/supersede-proposals/<id>/reject` |

The confirmation re-validates **inside the workspace lock**: still pending, target still a candidate,
target still live, no edge yet, `etag` unchanged. Anything else is a 409 — a stale page cannot write
back an edge that was already refused.

Confirmation goes through the existing revision validator (`revisions.supersede`), so self, cycle,
archived, already-superseded and chain length are all decided in one place.

### Rejecting leaves a tombstone

Rejecting is not deleting: the fact stays current. The refused target is recorded in
`rejectedSupersedes`, and the **generic revision endpoint refuses that exact pair**, so a stale tab
cannot write the edge that was just declined. A later proposal about the same pair clears the
tombstone (that is a new intent); the stale tab is stopped by the ETag, not by a permanent tombstone.

### Every write endpoint takes the workspace lock

Confirm, reject, supersede and revoke now take the same lock as import. A second process gets 409
`WORKSPACE_WRITE_BUSY` instead of "the panel says it worked while the library is locked".

### Failures are reported as failures

- if the proposal mark cannot be written, extraction reports `proposal-failed` instead of claiming a
  proposal (there would be nothing in the list to show for it);
- if the edge exists but clearing the mark fails, the response is 200 with
  `warning: "marker-not-cleared: …"` instead of a 500 that hides what already happened.

### Three diagnostics

- `mapInjections.sessionStart` counts the startup injection separately (`full` still means refreshes);
- `lastScreen.keptByToolEvidence` counts the groups a zero score would have dropped but a tool result
  kept;
- `lastMapInjection.sessionId` makes a workspace-level record attributable to a session.

### Panel

The **Activity** page gained a **Replacements to confirm** card: the proposal text, the sentence it
came from, and one row per candidate with confirm / keep-both. Each action affects that proposal only;
there is no "confirm all".

## Upgrading

- **Edges that 0.8.6 created automatically stay as they are.** Their provenance cannot be judged
  reliably, and a bulk rollback would push correct replacements back to "unconfirmed" too. Disputed
  relations go through the existing revoke endpoint, one at a time.
- Escape hatch: `supersedeMode: "auto"` in `~/.dsh/trivium.json` restores the 0.8.6 behaviour. Missing
  key or `"propose"` is the default. The panel does not expose it.
- **The model tool contract is unchanged.** No `supersedes_id`. The model has no confirmation path —
  not a narrow one, and not an id parameter. This is not "permission isolation": there simply is no
  confirm capability on that path.

## Known limits

1. **Recall**: while unconfirmed, both decisions are current and the model may answer with the old
   one. That is the price of P; the panel mark only warns a human.
2. **"Both current" is not "both in the map"**: the short map has eight named slots and a token
   budget. Both are eligible; on a large library only one may get a row.
3. **Turn counting needs the host to expose a user message.** A host that never does will not reach
   the six-turn full refresh, and the counter fix still has **no live-host re-measurement**.
4. `lastMapInjection` is workspace-scoped (it now carries `sessionId`); the heat sidecar keeps entries
   for deleted nodes, so the ranking can carry ghosts.
5. `router` / `inherit` / `scope` ship but stay off by default; they are experimental and have not
   been accepted on a real host.
6. Imports can partially commit; the response carries `newNodesBeforeFailure` and `retryHint`, and a
   retry is idempotent.
7. The panel card has no rendering test (the repository forbids new UI assertions). It was checked by
   hand and with Playwright in a real host once.

## Verification

`node scripts/run-all.mjs` → **87/87**.

| Script | Result |
|---|---|
| `smoke-p89` (P contract) | 41/41: no edge by default, both current, stale confirm after reject refused, stale/missing ETag, second confirm, 409 under a held lock, proposal write failure, ambiguous candidates, helper cannot build a cycle |
| `smoke-p90` (HTTP contract) | 7/7 |
| `smoke-p74` / `p75` / `p83` | 70 / 52 / 14 |

Real-host check (2026-11-09, DSH 0.2.1-rc.5, isolated workspace, no model calls, default library
untouched): confirm wrote one edge with `supersedeConfirmedVia:"http"`, reject left no edge and a
tombstone, and the list was empty after both.
