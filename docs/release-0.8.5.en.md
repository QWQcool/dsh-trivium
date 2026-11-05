# 0.8.5 — Context pipeline and a kernel upgrade

2026-11-04. This is the first release that changes **how the memory pipeline behaves** (0.8.4 was presentation
only). It also moves to `triviumdb@0.9.0`.

## What changed

### Extraction stops paying for turns with nothing in them — **filler only**

An event is scored before it can enter an extraction window (0 = no content, 1 = maybe, 2 = states a fact):

- **only a window whose turns all score 0** is consumed without an extraction call; a zero group inside a
  mixed window is extracted with the rest;
- 2s are moved to the front of the batch;
- a 0 is raised to 1 when its turn carried tool calls, so an acknowledged request is not dropped as filler.

**Only four things score 0**: empty input, punctuation only, acknowledgements (`好的`, `ok`, `继续。`) and
greetings. Commands, paths, URLs and single characters score **1** — the audit showed "looks like a command"
never proved "carries no fact" (`npm is the package manager for this project` used to score 0), and those
zeros could not be recovered.

The measured cost, stated plainly: on a command-heavy corpus the call count is **30 → 30 (0.0% saved)**.
The earlier 30 → 10 figure only held while commands counted as zero, and no longer applies.

### The short map follows real use, and is injected only when it changes

- facts reached through `ctx_find` / `ctx_read` gain heat and take the map's slots (before, the map was
  insertion-ordered and the oldest facts could never appear);
- the map carries a version per session: unchanged means **0 tokens** (before, it was injected once at session
  start and then went stale), changed means a summary line plus diff lines **clipped to the map budget** (the tail
  is dropped and replaced by “…N more changes”), and a full copy every six turns;
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
history**. With the switch off the behaviour is 0.8.4's: exact/substring matching only.

### Bulk writes are an order of magnitude faster

An external import (WorkBuddy / Claude Code / Codex `MEMORY.md`, `CLAUDE.md`, `AGENTS.md`) used to flush once
per fact. Measured 22 facts went from **2 020 ms / 47 flushes** to **110 ms / 2 flushes** — two, not one:
the batch keeps a closing flush.

### Kernel: `triviumdb` 0.9.0-beta.3 → 0.9.0

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

## Present but off by default

None of these have a caller yet; with the switch off the behaviour is 0.8.4's:

- a `scope` parameter (`workspace` / `parent` / `inherit`); `parent` still refuses;
- read-only inheritance (`lib/inherit.js`): reads the parent's short map, through the router when one is running,
  and degrades without throwing;
- a single-writer router (`lib/router.js`): four write operations plus `apply` / `map` over a local pipe;
- the switch `scopeInheritance` (off by default, `~/.dsh/trivium.json`).

## What did not change

The four model tools (names, arguments, results), the schema version, `DIM=1536`, the token budgets (300/400),
the default switches, the supersede rules, the write filter and the revision-chain protection.

## Known limits

1. **Screening only skips filler.** The zeros are empty input, punctuation, acknowledgements and greetings;
   commands, paths, URLs and single characters score 1. The screened-window audit is memory-only (three rows,
   exposed on `/status`, lost on restart) and there is no replay path.
2. **The map is rebuilt every turn** — measured ~108 ms at 5 000 nodes, on the first pre-step of each turn.
3. **`lastMapInjection` is workspace-scoped**, so sessions overwrite each other's diagnostics.
4. **A timeout does not cancel the extraction**; the abandoned run keeps the lock, and `stuck` is recorded once
   per kind per session.
5. **Heat reinforces itself** — panel browsing and automatic recall are excluded, but "often read" still drifts.
6. **The 0.9.0 batch path is slower** (see above); re-measure if the batch window grows.

## Verification

`node scripts/run-all.mjs` → **89/89** (0.8.4 was 74/74). Both outcomes of the screen, the map's full/skip
paths and a `stuck → recovered` pair were observed on a real DSH host; evidence lives in
`docs/next-memory/evidence-write-provenance/`.
