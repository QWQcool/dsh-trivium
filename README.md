# dsh-trivium

In-process **graph memory kernel** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), backed by [TriviumDB](https://github.com/YoKONCy/TriviumDB).

One `.tdb` file per workspace. No extra server. MIT license.

> 进程内图记忆：按节点和边记，按需读。钉死 `@deepseek-ai/dsh@0.1.0-rc.6`。

## Status

**P4** — Kernel find + Settings one-pager (neighbors, entity filter, stale toggle). Auto-recall stays **off**. See [PLAN.md](./PLAN.md).

## Tools

| Tool | Role |
|---|---|
| `ctx_find` | Hybrid / keyword search + edge paths (L0 only) |
| `ctx_read` | Full payload by node id |
| `ctx_remember` | Explicit write (`entity` / `preference` / `decision` / `experience`) |
| `ctx_link` | Directed labelled edge |

Default: **no per-step auto-recall**. Session start injects a short map (budget ~400 tokens).

## Install (when testing against local DSH)

This repo is **not** copied into `DeepSeek_Harness`. Link it into the web profile:

```sh
cd dsh-trivium
npm install
node scripts/link-dsh.mjs
```

Restart `dsh web`, pick a workspace, then ask the agent to `ctx_remember` and `ctx_find`.

Manual equivalent:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-trivium
```

Memory file: `<workspace>/.dsh/trivium.tdb`.

## Layout

```
lib/index.js     Cordis apply: tools, session-start map, extract hooks
lib/store.js     TriviumDB open / insert / search / archive
lib/schema.js    Node types and edge labels
lib/tools.js     ctx_* tools
lib/extract.js   Rule + small-prompt distill, pending replay
lib/client.js    Settings page 「Trivium 记忆」
scripts/link-dsh.mjs
scripts/p2-cases.mjs
scripts/smoke-p3.mjs
PLAN.md
```

## License

MIT. TriviumDB itself is Apache-2.0 and remains a dependency.
