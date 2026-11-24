# dsh-trivium 0.9.4

**Local release candidate, not yet published.** The npm registry baseline remains `dsh-trivium@0.9.3`. [中文](release-0.9.4.md)

## Added

- **Task memory changes.** Select one current entity in an open workspace, then view changes or explicitly save the current comparison baseline. Later views report net changes to the entity's one-hop current facts: newly in scope, updated, superseded, archived, expired, or no longer in scope. Leaving the scope does not prove deletion, and the result is not a history of every intermediate event. Saved baselines can be forgotten, including for an entity that can no longer be opened. The workspace-local `.dsh/trivium.task-checkpoints.json` stores identities and version hashes, not excerpts. The cap is 128 current items, including the entity, and 32 baselines per workspace. An exceeded budget or stale preview is reported, never treated as an empty change set. No background notification, embedding request, or automatic memory injection is enabled. [Usage and API](read-api.md#任务记忆变更)
- **Search original excerpts in selected sources.** In **Context → Document evidence**, pick 1–8 saved sources and search their exact saved revisions. Results include the original excerpt and its UTF-8 byte range. Same-named files under different paths remain distinct. If a revision changes, reload the source list and search again; the request does not switch to the new revision silently. The defaults are up to 8 excerpts under a 600 estimated-token budget. Results do not claim to answer the question, and no model or embedding request is made. [Usage and API](read-api.md#在选定文档来源内查找原文)

## Improved

- **Duplicate citation display.** Identical citations in loaded results share a display group only when source, document, revision, byte range, and quoted text all match. Each fact association retains its ID and review status. No stored citation is removed; people and tools still see the original evidence links.

## Fixed

- **Orphan-entity scans.** Under TDB 0.9.3, requesting an extra row with `LIMIT 1001` exceeds the 1,000-row scan budget regardless of library size. The scan now stays within that budget. **Exactly 1,000 qualifying entity rows are refused**, just like more than 1,000: a full page cannot prove that no additional rows exist. The query fails closed rather than returning a partial scan.
- **Live TQL with `limit = 1000`.** The maximum-sized read no longer requests a lookahead row beyond the kernel budget. **Exactly 1,000 returned rows can conservatively report `truncated: true`** because no extra row is available to distinguish a complete page from a partial one. If a request is retried with fewer rows to fit the response byte budget, a truncated result is marked with `truncationReason: "response-byte-budget"`; the retry is not mistaken for an untruncated result.

## Removed

None.

## Upgrade, compatibility, and data

The candidate still pins `triviumdb@0.9.3`. No TDB format, default switch, `DIM`, or four-tool contract change; no additional `prepare` or `migrate` step is required for an already-upgraded 0.9.3 library. If your older library has not yet been upgraded to TDB 0.9.3, follow the [existing upgrade and rollback guide](kernel-upgrade.md#english). Node remains `^22.19.0 || >=24`.

Saving or forgetting a task baseline modifies only the new workspace-local sidecar. Keep that file if you want its baselines available after reinstalling a compatible version. It is not part of the TDB fact store or a snapshot of it. The source search and citation grouping do not rewrite saved sources, facts, or evidence links. Existing APIs remain available; the new source and checkpoint operations are explicit.

## Verification scope

Release checks are tracked separately from this candidate note. No new claim is made here about retrieval quality, model answers, latency across platforms, a registry publication, or a release tag.
