# dsh-trivium 0.9.4

**A read-path correctness patch.** Since 0.9.3 moved to the new kernel, any "fetch one extra row to detect truncation" is rejected outright, which left two read surfaces completely unusable. This release fixes only those two. [中文](release-0.9.4.md)

Kernel unchanged: still `triviumdb@0.9.3`. No data-format change, no migration. Verified host: `@deepseek-ai/dsh@0.2.2-rc.1`.

## Fixed

### Orphan-entity queries failed on every 0.9.3 install

`orphanEntities` in `lib/read-query.js` asked the kernel for `LIMIT 1001` (the 1000 cap plus one lookahead row) to detect overflow. Since kernel `0.9.3`, **`OFFSET + LIMIT ≤ 1000`** is enforced and the whole request is rejected as `TDB_QUERY_BUDGET` — regardless of library size; a six-node fixture failed the same way.

It now reads within the budget and treats a full page as "at the cap" and refuses. Refusing is preferred over returning a silently incomplete orphan scan.

**Behaviour change**: a library with exactly 1000 entities is refused (previously only "more than 1000" was). This is the conservative trade-off when no lookahead row is available; it is documented in the code.

### Live TQL at `limit = 1000` failed

`lib/live-tql.js` used the same `LIMIT limit + 1` lookahead, and `1000` is the documented maximum `limit`, so requesting the maximum always failed.

The lookahead is now capped at the budget; when an extra row cannot be fetched, a response that fills the limit is reported as `truncated: true` instead of being presented as complete. That conservative rule applies **only when `limit ≥ 1000`**; truncation semantics for ordinary limits are unchanged.

## Improved

None.

## Removed

None.

## Upgrade and compatibility

Replace the package directly: kernel, data format, default switches, the four-tool contract and `DIM` are unchanged, so no `prepare` or `migrate` step is needed.

## Verification scope

- `node scripts/run-all.mjs`: **108/108** (106/108 before this fix; the two failures were the issues above).
- One assertion was rewritten to the new kernel contract: "send `MATCH … LIMIT 2000` and let the client truncate to 1000 rows" can no longer happen, because the kernel rejects that query first. It now verifies that the client display cap still holds, and that an over-budget `LIMIT` must be rejected with `422 TDB_QUERY_BUDGET`.
- No real-model or real-host quality runs were repeated for this version: both fixes are read-path only and do not change writing, extraction or injection.

## Known limits

- Orphan scans can only refuse once the entity count reaches 1000; "exactly 1000" and "more than 1000" are indistinguishable.
- Live TQL at `limit = 1000` reports `truncated: true` when the response happens to fill exactly, which is a conservative false positive.
