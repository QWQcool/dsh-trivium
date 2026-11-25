# dsh-trivium 0.9.5 release notes

[简体中文](release-0.9.5.md)

`dsh-trivium@0.9.5` is published on npm under `latest`. This release keeps `triviumdb@0.9.3` and addresses three reported issues.

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

The same runtime source tree passed 115/115 offline regressions on Windows, including P125–P128. Documentation checks passed 14/14, clean consumer checks passed 13/13, and CLI help checks passed 5/5. The sealed tarball was installed in an isolated official DeepSeek Harness 0.2.2-rc.5 host. Standalone map-only steps fell from one to zero; the next eligible human step received one map. Existing 1024- and 1536-dimensional libraries retained their original memories, supported write and lookup, and reported their actual widths in `/status`. The Web settings API also rejected invalid widths and preserved both existing database widths when the new-library default changed. A simulated provider explicitly rejecting `off` caused one retry on the same model and exactly one stored extraction. This check did not include the browser UI, real user accounts, external embedding endpoints, or other operating systems.

## Publication receipt

- Published on npm under `latest` at `2026-11-25T03:30:25.291Z`. [npm version page](https://www.npmjs.com/package/dsh-trivium/v/0.9.5)
- [GitHub Release](https://github.com/QWQcool/dsh-trivium/releases/tag/v0.9.5) published at `2026-11-25T03:41:46Z`. Annotated tag `v0.9.5` (`8baacefc88614fac83fc7f11d92d1dea79d63bca`) points to `875e6556c980fe68b5ae34bdf88d61dac27f50b9`.
- The [release archive](https://github.com/QWQcool/dsh-trivium/releases/download/v0.9.5/dsh-trivium-0.9.5.tgz) matches the sealed archive and npm download byte for byte: 74 files, 392,794 bytes. SHA-256 `4dcae1988aaafac1fa3d584210a4c144e2cb900f3b5bbd41f6b54e55db54c93d`; npm SHA-1 `c86f731e4babe62613fba9ef8798454736e81a73`.
- npm integrity `sha512-/YutcBCfDZqb0KosVUylgi0JgMA+1z4tEYVnTbaxpkHG9Z2xo1gpnrGJedKBag3TPhxe9zpr97mNvk8AUS+FPg==`.
- The tested archive was published unchanged. Its bundled READMEs retain the wording from the candidate seal; the repository READMEs record the confirmed release. [Structured receipt](reviews/NPM-RELEASE-0.9.5-2026-11-25.json)
