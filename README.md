# dsh-trivium

In-process **graph memory kernel** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), backed by [TriviumDB](https://github.com/YoKONCy/TriviumDB).

One `.tdb` file per workspace. No extra server. MIT license.

> 进程内图记忆：按节点和边记，按需读。钉死 `@deepseek-ai/dsh@0.1.0-rc.6`。

## Status

**v0.2.0** — P4 kernel + Settings correction: find with edges/`until`; edit/rename, merge, JSON export/import; recall **off** unless `autoRecall` or entity-name inject (mutually exclusive). Optional remote embedding (manual URL, default off). See [PLAN.md](./PLAN.md).

## Tools

| Tool | Role |
|---|---|
| `ctx_find` | Hybrid / keyword search + edge paths (L0 only) |
| `ctx_read` | Full payload by node id |
| `ctx_remember` | Explicit write (`entity` / `preference` / `decision` / `experience`) |
| `ctx_link` | Directed labelled edge |

Default: **no per-step auto-recall**. Session start injects a short map (budget ~400 tokens). Settings can switch recall to **entity-name inject** (1-hop neighbors when the user names a known entity) or full `autoRecall`; the two are mutually exclusive and both default **off**.

Optional **remote embedding** (OpenAI-compatible URL + model + key) is off by default. Failures fall back to keyword + graph. There is no local embedding model.

## Compared with what (mechanisms, not a bake-off)

This is a **kernel**, not a memory workbench. We did **not** run LoCoMo, OpenViking L0/L1/L2 product tests, or a live OV plugin shoot-out. The table is what we chose to win or skip. The only live contrast we ran is **vanilla DSH / empty `.tdb`**: the same `ctx_find("鉴权")` / `ctx_find("AuthGateway")` has no durable preference.

| | dsh-trivium | Stock DSH | JSON / FTS memory plugins | Wiki dual-link | OpenViking / PowerContext | Mnemon |
|---|---|---|---|---|---|---|
| Extra process | No (napi `.tdb` in-process) | — | Usually no | Often Python / indexer | Often a service + richer stack | Heavier local stack |
| What is stored | Nodes + labelled edges (entity / preference / decision / experience) | Session only | Documents or snippets | Markdown + `[[links]]` | Layered memory schema | Rich items + UI |
| How it enters the window | Short map ≤400 tokens; tools to drill; recall **off** (optional auto / entity-name inject) | Prompt / tools | Often dump or search | Follow links | Pre-step / layered load | Sidebar + recall |
| Graph | Engine edges (`about` / `decided` / `broke` / `fixed`); find returns **path** | None | Rare | Scan `[[slug]]` | Depends on product | UI-first |
| Human correction | Settings: search, neighbors, edit/rename, merge, archive vs delete, JSON export/import | — | Varies | Edit files | Product UI | Full workbench |
| First-period non-goals | Graph canvas, fifth tool, default auto-recall, local embedding | — | Feature-list race | 9-tool Python vectors | LoCoMo / parse farm / Skill hub | UI completeness |

**Why not a live OV comparison.** OV’s DSH plugin is the right *hook* shape (`inject`, pin rc.6, pending replay). Copying its product thickness (layers, skills, eval farm) is explicitly out of scope. Measuring “who wins LoCoMo” would optimize the wrong thing for a four-tool kernel.

## What we actually checked

On `@deepseek-ai/dsh@0.1.0-rc.6`, plugin linked into the web profile (not copied into Harness):

- Session A writes / extracts; session B `ctx_find` hits with `about` / `decided` / `fixed` paths; `ctx_read` returns `incoming`.
- Empty workspace: same queries, no durable preference (plugin still loaded).
- Extract whitelist: chitchat, one-shot “edit this file”, secrets, and the word `鉴权` as an entity stay out.
- Stale `until` hidden unless the query is about the deadline (`周五` / `下周`).
- Settings: filter by entity, stale toggle, archive then find misses; edit name/text, merge same-type nodes, export/import JSON.
- Optional remote embedding stays off until a URL is saved; no local model.
- Failure isolation: a broken `.tdb` path does not kill the agent loop.

Offline: `npm run smoke-p1` / `smoke-p2` / `smoke-p4` / `smoke-p5`.

## Strengths

- **Durable facts with edges**, not a chat transcript dump. `find("AuthGateway")` can return a neighbor whose text never repeats the name.
- **Cheap by default.** Short map budget 400; no per-step recall; Trajectory shows `dsh-trivium` as plugin inject.
- **One file, one process.** Install is a profile junction / `dsh plugin add`; memory is `<workspace>/.dsh/trivium.tdb`.
- **Visible and reversible.** Settings can edit, merge, archive vs delete, and export/import JSON; find ignores archived nodes.
- **Honest degradation.** Keyword + graph walk by default. Optional remote embedding; extract / TDB / embed errors log and continue.

## Limits (v0.2.0)

- **Not a workbench.** No graph canvas, no Mnemon sidebar, no cross-agent share, no PDF/Zotero RAG. Settings can edit, merge, and export/import.
- **Recall is off by default.** If the model never calls `ctx_find`, the short map is all it gets unless you enable entity-name inject or `autoRecall` (mutually exclusive).
- **Extract is conservative.** It will miss facts that do not match the whitelist; a real tool-fail→success experience only links when the fail/fix text or a nearby user turn names an entity.
- **Engine gaps we paper over.** No `expandLabels` / `getIncomingEdges` in the Node binding, so the plugin scans edges itself. Same `.tdb` must not be opened by two Node processes (normal `dsh web` use is one process).
- **Vectors are optional.** Remote OpenAI-compatible embedding can fill the 1536-d slot; local models are not shipped. Old rows stay zero until you backfill.
- **Old dirty rows stay.** Settings can edit or archive them; we do not auto-wipe a workspace library.

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
lib/store.js     TriviumDB open / insert / search / archive / merge / export
lib/schema.js    Node types and edge labels
lib/embed.js     Optional remote OpenAI-compatible embeddings
lib/settings.js  ~/.dsh/trivium.json (recall mode, embed URL)
lib/tools.js     ctx_* tools
lib/extract.js   Rule + small-prompt distill, pending replay
lib/client.js    Settings page 「Trivium 记忆」
scripts/link-dsh.mjs
scripts/p2-cases.mjs
scripts/smoke-p4.mjs
scripts/smoke-p5.mjs
PLAN.md
```

## License

MIT. TriviumDB itself is Apache-2.0 and remains a dependency.
