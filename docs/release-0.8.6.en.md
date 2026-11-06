# 0.8.6 — Context pipeline

2026-11-06. The kernel upgrade (`triviumdb@0.9.0`) shipped separately in **0.8.5**, so a problem can be
attributed to the kernel or to a behaviour change without guessing. **0.8.6 does not upgrade the kernel**:
it is still `0.9.0`. This release is the pipeline behaviour. The kernel section below is 0.8.5 history,
kept only for readers upgrading from <= 0.8.4.

## What changed

### A window is scored before extraction — **kept, not a headline feature**

An event is scored before it can enter an extraction window (0 = no content, 1 = maybe, 2 = states a fact):

- **only a window whose turns all score 0** is consumed without an extraction call; a zero group inside a
  mixed window is extracted with the rest;
- 2s are moved to the front of the batch;
- a 0 is raised to 1 when its turn carried tool calls, so an acknowledged request is not dropped as filler.

**Only four things score 0**: empty input, punctuation only, acknowledgements (`好的`, `ok`, `继续。`) and
greetings. Commands, paths, URLs and single characters score **1** — the audit showed "looks like a command"
never proved "carries no fact" (`npm is the package manager for this project` used to score 0), and those
zeros could not be recovered.

**We make no savings claim for this.** On a command-heavy corpus the call count is **30 → 30 (0.0% saved)**;
the earlier 30 → 10 figure only held while commands counted as zero. On a real host the model calls
`ctx_find` even for `ok`, so a whole-window drop appeared only when the user aborted a turn. The
tool-evidence gate runs *before* that decision: once a window is consumed there is **no replay or
recovery entry point** (limit 1). We keep the narrow filler whitelist, not a cost benefit.

### The short map follows real use, and is injected only when it changes

- facts reached through `ctx_find` / `ctx_read` gain heat and take the map's slots (before, the map was
  insertion-ordered and the oldest facts could never appear);
- the map carries a version per session: unchanged means **0 tokens** (before, it was injected once at session
  start and then went stale), changed means a summary line plus diff lines — **up to six rows per category**,
  then clipped to the map budget (the tail is dropped for “…N more changes”); a full copy is forced when
  `turnsSince` reaches six (`reason:"refresh"`, **not** counting the session-start injection);
- **one user turn counts once**: a tool loop re-enters pre-step several times for one message. The original
  guard only skipped *equal* keys, so the empty key of a delta window advanced the counter on every step
  (measured +3 in one turn). Two further gaps found in review are fixed as well: a keyless session could not
  tell the first empty observation from a later one, and two id-less messages whose text lived in `content[]`
  both produced `t:1`. Regressions: `smoke-p74` / `smoke-p86`.
- **Counting requires the host to expose a user message somewhere.** A host that never does cannot produce a
  turn key; it stays on its first observation and never reaches the six-turn full refresh. That is a stated
  capability boundary, not a fixed-and-verified path.
- Diagnostics scopes: `mapInjections.full` counts **refresh-phase** fulls only; `lastScreen.counts` is the
  group score **after** tool-evidence promotion, not the initial score; `lastMapInjection` is workspace-scoped
  and carries no session id.
- the **Context** page shows the real delivery ledger and a read-only probe; **Activity** shows the last
  injection's mode / reason / tokens.

### Stuck runs and deferred writes are visible

- an extraction that passes 30 seconds, a stale write lock and a timed-out replay are recorded as `stuck`,
  and their later recovery as `recovered`; the pair shows up in the change log, so a later process can close
  a row an earlier one opened;
- windows that lost the write lock or failed used to sit in a file nobody could see. **Activity** now has a
  *waiting to be written* card: window count, event count, file timestamp and an 80-character preview each.

### Fact identity — fuzzy merging is **off by default**

New `lib/identity.js`: the same fact worded differently (reordered, with an extra qualifier) can be recognised
as one, behind four gates — type, negation, numbers (including decimals and CJK numerals) and character-bigram
similarity.

**It ships disabled** (`identityMerge` in `~/.dsh/trivium.json`, missing key = off). The audit reproduced three
wrong merges — `1.5s` vs `5.1s`, `生产环境 npm` vs `测试环境 pnpm`, `十六天` vs `六十天` — all of which are
corrections rather than duplicates, and a merge has no revision chain: **a wrong merge silently rewrites
history**. **Only the fuzzy-merge step is off.** The type / negation / number guards in `lib/identity.js`
run **by default** in `findMergeTarget` (`lib/store.js`) and prevent some substring merges the old build
allowed (“allow automatic publishing” vs “do not allow automatic publishing”). So “off means 0.8.4
behaviour” was inaccurate: **default deduplication results can differ**.

### Bulk writes: a historical offline measurement, plus an honest partial-commit receipt

An external import (WorkBuddy / Claude Code / Codex `MEMORY.md`, `CLAUDE.md`, `AGENTS.md`) used to flush once
per fact; it now flushes a handful of times.

- **Historical offline measurement (2026-11-05, not re-run for this build):** 22 facts went from
  **2 020 ms / 47 flushes** to **110 ms / 2 flushes** — two, not one: the batch keeps a closing flush.
  That 18× belongs to that fixture only.
- **Measured on this build:** a 24-line `CLAUDE.md` import took 259 ms and wrote 4 facts / skipped 7.
  It does **not** demonstrate an 18× gain.
- **A batch is not a transaction.** When a later candidate fails, earlier writes stay durable. Review F86-03
  found the response was a bare 500: it now returns `partial:true`, `newNodesBeforeFailure` and `retryHint`
  (reopen proved 2 surviving nodes, pinned in `smoke-p83`). Re-importing the same file is idempotent.

### Background (already shipped in **0.8.5**, not a 0.8.6 feature): `triviumdb` 0.9.0-beta.3 → 0.9.0

The stable release fixes two things we kept hitting on Windows: reopening a file group after a controlled close,
and the lock-path race during an atomic replace. The cost is a slower batched path (same machine: router queue
p95 206 → 483 ms, throughput 1 462 → 559 writes/s, still zero lost writes); a single write got faster
(188 → 155.5 ms).

> **Back up the whole `.dsh` directory before upgrading (with the plugin closed).**
> 0.9.0 raises the file format to v10 and the previous kernel cannot read it
> (`TDB_UNSUPPORTED_DATABASE_VERSION`), so **downgrading the plugin is not a rollback** — restoring a backup is.
> A backup must copy the **whole file group** (`trivium.tdb` plus `.gidx` `.pidx` `.pld.*` `.text` `.text.meta`
> `.vec` `.wal` `.lock` `.flush_ok`); copying only `.tdb` yields `TDB_CORRUPTED_FILE`. Drill:
> `docs/next-memory/evidence-write-provenance/INFRA/KERNEL-UPGRADE-DRILL-2026-11-05/`.

## Call relationships (as implemented, not a blanket "present but unused")

Review F86-04 corrected an inaccurate claim: these modules are **not** all caller-free.

**Wired into the default path:**

- `lib/memory-writer.js`: the default extraction path goes through it (`memoryWriterFor(db, writer)` in
  `lib/extract.js`); all four write operations use the port.
- `lib/identity.js`: fuzzy merging is off, but the type / negation / number guards run by default in
  `findMergeTarget` and change some substring-merge outcomes (above).

**No caller, off by default, experimental** (off = no effect on the main path):

- a `scope` parameter (`workspace` / `parent` / `inherit`); `parent` still refuses;
- read-only inheritance (`lib/inherit.js`): reads the parent's short map, through the router when one is running,
  and degrades without throwing;
- a single-writer router (`lib/router.js`): four write operations plus `apply` / `map` over a local pipe;
- the switch `scopeInheritance` (off by default, `~/.dsh/trivium.json`).

These have **not** been accepted as host capabilities on a real host; they are interfaces and switches only.

## What did not change

The four model tools (names, arguments, results), the schema version, `DIM=1536`, the token budgets (300/400),
the **values** of the default switches, the supersede rules, the write filter and the revision-chain protection.
Unchanged switch values do **not** mean unchanged default behaviour: the identity guards above are the exception.

## Known limits

1. **Screening only skips filler.** The zeros are empty input, punctuation, acknowledgements and greetings;
   commands, paths, URLs and single characters score 1. The screened-window audit is memory-only (three rows,
   exposed on `/status`, lost on restart) and there is no replay path.
2. **The map is rebuilt every turn** — measured ~108 ms at 5 000 nodes, on the first pre-step of each turn.
3. **`lastMapInjection` is workspace-scoped**, so sessions overwrite each other's diagnostics.
4. **A timeout does not cancel the extraction**; the abandoned run keeps the lock, and `stuck` is recorded once
   per kind per session.
5. **Heat reinforces itself** — panel browsing and automatic recall are excluded, but "often read" still drifts.
   Deleting a node does not remove its usage entry, so the heat list can keep ghost rows (facts stay correct).
6. **The 0.9.0 batch path is slower** (a 0.8.5 measurement, see background); re-measure if the batch window grows.
7. **Turn counting needs a user message.** A host that never exposes one stays on its first observation and
   never reaches the six-turn full refresh. The offline contract reproduction passes; there is no live sample.
8. **A corrupt pending file now fails loudly** (`GET /pending` → 500 / `ok:false`) instead of looking like an
   empty queue. Refreshing the card only re-reads; replay happens on the next session start.
9. **Imports can partially commit.** The response carries `newNodesBeforeFailure` and `retryHint`; retrying the
   same file is idempotent.

## Verification

`node scripts/run-all.mjs` → **89/89** (89 scripts, 147.4 s total, re-run locally by the author after the
review fixes; 0.8.4 was 74/74). The reviewer ran 14 **non-UI** smokes (292/292 assertions) and did **not**
re-run `run-all`; these are two different runs. Assertion counts after the fixes: `p74` 29→**36**,
`p82` 13→**14**, `p83` 12→**14**, `p86` 15→**16**, `p87` 20→**22**.

Real-host evidence (2026-11-06): both screening outcomes, the map's `full` 123 → `diff` 42 → `skip` 0 tokens,
a `stuck{lock-stale}` → `recovered` pair (`afterMs` 86 021), the pending card matching the API and file
(1 window / 51 events / 144 acknowledged), and a 24-line `CLAUDE.md` import (259 ms, 4 written / 7 skipped).

**One real-host item failed at the time**: `turnsSince` advanced 3 times in one user turn. The fix and the two
further review reproductions are verified **offline only**; we do not claim a live re-measurement. Both release
blockers found in review (turn-counter gaps / corrupt pending reported as success) and the partial-commit
receipt are fixed; per-item values are in `docs/reviews/0.8.6-REVIEW-PACKET.md`.
