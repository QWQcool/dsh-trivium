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

The `etag` also covers the **candidate**: if the decision that would be retired was edited after the
page loaded, the stale page cannot confirm either. Rejection requires the `etag` too — otherwise an
old page could decline candidates that were added later.

**A replay of the same event does not undo a human rejection.** When the host retries a window it is
the same session/seq/messageId, with no new user intent; the refusal stands. Only a proposal from an
event whose previous and current keys are both known and different goes back into the queue.
If either occurrence lacks `messageId` / `seq`, including the very first proposal, the refusal
stands. A locator supplied later does not prove a different earlier event. Consequently, a host
without locators cannot automatically re-propose the same fact after a refusal.

### Rejecting leaves a tombstone

Rejecting is not deleting: the fact stays current. The refused target is recorded in
`rejectedSupersedes`, and the **generic revision endpoint refuses that exact pair**, so a stale tab
cannot write the edge that was just declined. Only a proposal proven to come from a different event
clears the tombstone; a stale tab is then stopped by the ETag.

### Four write endpoints take the workspace lock

Confirm, reject, supersede and revoke now take the same lock as import. A second process gets 409
`WORKSPACE_WRITE_BUSY` instead of "the panel says it worked while the library is locked".

Scope, precisely: **not every write endpoint**. Settings, chips and node edit/delete/archive keep
their existing in-process queue; they never contend with extraction for this lock, and this release
does not change them.

### Failures are reported as failures

- if the proposal mark cannot be written, extraction reports `proposal-failed` instead of claiming a
  proposal (there would be nothing in the list to show for it);
- that run **does not consume the window** (`skippedBy: "proposal-failed"`, `proposalPending: true`),
  so it is replayed; the facts already written are merged rather than duplicated, and the proposal is
  stored once the sink is healthy again;
- if the edge exists but clearing the mark fails, the response is 200 with
  `warning: "marker-not-cleared: …"` instead of a 500 that hides what already happened.

### Three diagnostics

- `mapInjections.sessionStart` counts the startup injection separately (`full` still means refreshes);
- `lastScreen.keptByToolEvidence` counts the groups a zero score would have dropped but a tool result
  kept;
- `lastMapInjection.sessionId` makes a workspace-level record attributable to a session.

### Expiry dates are recognised more widely, without guessing a locale

The `until` field and the "invented date" guard now share one parser
(`lib/date-parse.js`). Recognised absolute dates:

- `2026-11-20`, `2026/11/20`, `2026.11.20`, `2026年11月20日`;
- `November 20, 2026`, `20 Nov 2026` — the month is spelled out, so day/month
  order is not ambiguous.

**Deliberately not recognised**: all year-last numeric forms. `04/06/2026` could mean April 6 or
June 4. `11/20/2026` only permits month/day order, but is excluded by the same grammar rule rather
than inferring a locale from the numbers. English years must be separated by whitespace or a comma;
joined text such as `November 202026` or `20 Nov2026` is not parsed.
The zone is not inferred either: parsing uses the `Asia/Shanghai` anchor and an `until`
resolves to the end of that day in UTC.

A date in a fact body still cannot become an expiry by itself: the guard only
decides whether the user's own sentence supports a date, and `until` still comes
from an explicit field.

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
   the six-turn full refresh. The counter was re-measured on a real host (2026-11-10, DSH 0.2.1-rc.5):
   a turn with tool calls advanced `mapInjections` by exactly one `skip` (`sessionStart:1`) and left
   `turnsSince` at 1, so one user turn counts once. The library used for the measurement was restored
   whole afterwards (16 nodes, same ids).
4. `lastMapInjection` is workspace-scoped (it now carries `sessionId`). The heat sidecar counts
   references and is capped at 2000 entries; **deleting a node leaves its entry behind**, but no screen
   or endpoint presents the sidecar as a ranking — the short map reads heat only for nodes that still
   exist — so those entries are invisible and cost a little disk. The 0.8.6 note about ghosts "in the
   ranking" was inaccurate; this is the accurate statement.
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
| `smoke-p89` (P contract) | 69/69: no edge by default, both current, stale confirm after reject refused, rejection protected even when the first proposal lacks locators, stale/missing ETag (proposal and candidate), rejection needs its own ETag, second confirm, 409 under a held lock; real plugin entry replays the same historical window, retaining it on proposal failure and consuming it after recovery without duplicating facts; ambiguous candidates, a cycle refused by the revision validator |
| `smoke-p90` (HTTP contract) | 7/7 |
| `smoke-p74` / `p75` / `p83` | 70 / 52 / 14 |

Real-host check (2026-11-09, DSH 0.2.1-rc.5, actions targeted an isolated workspace, no model calls):
confirm wrote one edge with `supersedeConfirmedVia:"http"`, reject left no edge and a
tombstone, and the list was empty after both.
The host also opened its default workspace database during startup. Without a prior snapshot, that
database cannot be claimed unchanged or restored; see review report §8.5.

The closeout checks use offline stubs; no real host or paid model was rerun. See the
[final acceptance record](reviews/0.8.7-FINAL-RESULTS-2026-11-10.md).
