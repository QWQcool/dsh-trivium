# dsh-trivium 0.9.5 release candidate

[简体中文](release-0.9.5.md)

**Local release candidate, not published.** See the [release status](README.md#发布状态) for the latest published npm version. This candidate keeps `triviumdb@0.9.3` and addresses three reported issues.

## Added

- **Settings → Vector** lets you set the vector width for new libraries (`embeddingDimensions`, default 1536) and optionally send the current library's width as `dimensions` in embedding requests (`embeddingRequestDimensions`, off by default). Enable the field only if the endpoint accepts it. Otherwise the endpoint still needs to return the library's width.

## Fixed

- [#10](https://github.com/QWQcool/dsh-trivium/issues/10): When the provider explicitly rejects reasoning effort `off` before streaming any content, background extraction retries once on the same model without the option. Cancellations, timeouts, rate limits, network or other provider failures, and failures after content starts do not trigger this retry.
- [PR #8](https://github.com/QWQcool/dsh-trivium/pull/8): The opening map and later refreshes are attached only to eligible human steps admitted by the host. Opening a session does not trigger a separate model step for the map. Producer, background and synthetic turns, or a failed attachment, do not advance map delivery. Thanks to [@rachel1028-blip](https://github.com/rachel1028-blip) for the fix.
- [#9](https://github.com/QWQcool/dsh-trivium/issues/9): Existing memory databases open at their native width, so a 1024-dimensional library is no longer treated as 1536-dimensional. Reads, writes, snapshots and retrieval use the corresponding library's width. A mismatched provider vector is neither used nor saved; keyword and graph lookup remain available.

## Removals, compatibility and data

- No features removed, no features newly enabled by default, and no data-format change.
- The update does not rebuild or automatically convert databases, pad or truncate mismatched vectors, or re-embed stored vectors. Use the same model and configuration for queries and stored vectors. Matching widths do not make models interchangeable.
- Libraries already upgraded for TDB 0.9.3 do not need another migration. For format-15 libraries still subject to the first-write protection or for older formats, follow the [kernel upgrade and rollback guide](kernel-upgrade.md#english) to retain the full file group and prepare or migrate offline. Updating the plugin does not change the embedding model.
- The 1024-dimensional library stays intact. Rolling back to 0.9.4, which assumes 1536 dimensions, still leaves that library unreadable by the plugin; rollback does not restore access to it.
- Both [0.9.4 1,000-row boundaries](release-0.9.4.en.md#fixed) still apply: the orphan scan refuses when it fills 1,000 rows, and live TQL can conservatively report `truncated: true` when it returns exactly 1,000 rows.

## Verification scope

The same runtime source tree passed 115/115 offline regressions on Windows, including P125–P128. In an isolated official DeepSeek Harness 0.2.2-rc.5 host, standalone map-only steps fell from one to zero and `/status` reported the library's actual width. These are source and isolated host results, not verification of the 0.9.5 tarball, a clean consumer install, all operating systems, or external model services.
