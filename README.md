# dsh-trivium — In-process graph memory for DeepSeek Harness

<p align="center">
  <img width="820" alt="dsh-trivium cover" src="docs/cover.png">
</p>

In-process graph memory for DeepSeek Harness. One `.tdb` per workspace. No extra server.

DSH 进程内图记忆 · 按节点和边记 · 默认少注入

> **Quick install**: `dsh plugin --profile web add dsh-trivium` → restart **dsh web** → open a workspace (Settings shows **Trivium memory**; the conversation title bar shows **Session graph**). Details in [Installation](#installation).

[**English**](README.md) | [中文版](README.zh-CN.md)

---

## Installation

> Prerequisite: install [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and start `dsh web` at least once. Tested host: `@deepseek-ai/dsh@0.1.1-rc.2` (`dsh-llm` / `dsh-tools` peers also accept `0.1.0-rc.8`).

```sh
dsh plugin --profile web add dsh-trivium
```

Restart **dsh web**. Memory lives in the current workspace:

```
<workspace>/.dsh/trivium.tdb
```

If you launch DSH with [Dsh_BatStart](https://github.com/QWQcool/Dsh_BatStart), the plugin is installed for you — skip the command above.

Local source checkout:

```sh
npm install
node scripts/link-dsh.mjs
```

Then restart `dsh web`.

## Updating

```sh
dsh plugin --profile web add dsh-trivium
```

Restart **dsh web**. For a source checkout, `git pull` then run `node scripts/link-dsh.mjs` again.

## AI-era installation

Copy this to your assistant:

```text
On DeepSeek Harness, run: dsh plugin --profile web add dsh-trivium
Then restart dsh web. Settings will show "Trivium memory", and the session title bar
will show "Session graph" next to Conversation / Trajectory (use "Create checkpoint" to split a box by hand).
```

---

## Graph memory that stays quiet

Trivium is a memory kernel, not a journal, calendar, or chat companion. It stores **nodes and edges**, injects as little as possible, and lets you correct mistakes.

- **Cross-session graph** — session A stores “auth goes in header X”; session B calls `ctx_find("auth")` and gets the hit plus who it links to (`about` / `decided` / `broke` / `fixed`).
- **Default quiet** — a new session injects one short map (≤400 tokens). The model calls tools when it needs more. Nothing is dumped every step.
- **Session graph** — each successful compaction becomes a box; “Create checkpoint” splits a box without compressing the model window; fork from a checkpoint. Optional memory chips pin facts into the next turn.
- **Human-editable** — chips can add, archive, or delete; Settings search, rename, merge, import/export, and global switches.
- **Strict extraction** — chitchat, one-off file edits, and secrets are **not** auto-written from the transcript. Chip “Add” stores exactly what you typed (one paste = one node), still through the write hygiene gate.
- **Write hygiene** — `ctx_remember`, chip add, extract, and external import refuse mojibake, stutter loops, JSON envelopes, base64 residue, and secrets. Dirty nodes already in `.tdb` stay visible in Settings so you can archive them; they are hidden from find / short map / chips.
- **Optional embedding** — off by default. The official DeepSeek chat API has no embeddings endpoint; fill an OpenAI-compatible URL if you want one. Keyword + graph walk still work without it.

### Under the hood

- **In-process, one file** — TriviumDB (vectors + JSON payload + directed weighted graph) opens with the DSH process. No sidecar HTTP/Python service.
- **Four tools only** — `ctx_find` / `ctx_read` / `ctx_remember` / `ctx_link`. The session graph does not add a fifth.
- **Injection via `agent.inject()`** — not the system prompt, so `persona.complete: true` cannot silently drop the map.
- **Recall carries paths** — every hit says which node it came from and along which edge.
- **Failures never block the agent** — store / embedding / extract errors are logged; the main loop continues.
- **UI follows the host language** — Settings and the session graph switch with DSH `locale/change` (`zh` / `en`).
- **First-turn map** — the short map is injected once per session. If `session-start` loses a race with the first model step, `pre-step` fills it in; it is not rewritten every step (prefix-cache friendly).

## Features

### Cross-session graph

Nodes are `entity` / `preference` / `decision` / `experience`. Business edges are `about`, `decided`, `broke`, `fixed`.

`ctx_find` returns L0 summaries plus edge paths (incoming as `<-label-id`). If the query names an existing entity, unexpired `about` / `decided` / `broke` / `fixed` neighbors come along even when the neighbor text does not contain the query. Decisions with `until` stay hidden after they expire, unless the query itself is asking about that deadline (e.g. “Friday”).

### Session graph

Entry: current session title bar **Conversation / Trajectory / Session graph**. This is a plot of compaction and forks, not the memory editor. Rename, merge, and global switches stay on the Settings page. The chip strip can add, archive, and delete.

**Boxes**

- Never compacted: one “Next” box.
- After a successful compaction: historical checkpoints on the left (summaries from DSH), “Next” still on the right.
- **Create checkpoint**: fold the current “Next” into a left box; the right side stays “Next”. Plot only — **does not** compact the model window. Clicking again in the same turn does not double-write.
- Sessions that compacted or forked before the plugin was installed: **Update checkpoints** backfills boxes from compression markers in the transcript and sidebar forks (safe to click again). No compaction still means only “Next” — a long session with many tools is not the same as DSH having compacted (auto-compact is around 80% of the window). To compact context, type `/compact` in the conversation.
- Boxes themselves do not summarize. Quality comes from summaries DSH already wrote; fork does not re-summarize.
- “Rename” changes the box title only. Click a box to jump to that checkpoint in the conversation, or open Trajectory.

**Forks**

The fork icon on a box opens “Fork as new session”. That name appears in the left session list (default: source title plus `(1)`).

Confirm runs the host `session.fork`: the child shows up in the sidebar, prefix (including already-compacted summaries) is copied by DSH. With a checkpoint, the cut is at that checkpoint; with only “Next”, the edge leaves the box you clicked.

Forks created from the conversation page also show up on the session graph. Archive a child in the sidebar and its fork box disappears; unarchive brings it back.

Canvas: drag empty space to pan, scroll to zoom.

### Memory chips

Expand the strip at the top of the session graph. Lists unarchived preference / decision / entity (experience stays out, to keep noise down).

| Action | When it takes effect |
|---|---|
| Check a chip | The **next** message you send in this segment carries it (L0, ≤300 tokens) |
| Uncheck | The turn after that no longer carries it |
| Add | One click writes one node; a whole paste is still one node |
| Select → Archive | Soft delete: gone from find / short map / chips; the node remains in `.tdb` |
| Select → Delete | Removed from `.tdb`, not recoverable |
| Turns already sent | Not rewritten |

Chips are per session. New sessions and forked children start unchecked. Inherit pins in the fork dialog, or check them again on the child. The short map still arrives at session-start and does not use a chip slot.

### Settings (Trivium memory)

Settings → **Trivium memory** manages the store. It does not replace the session graph.

- **Injection (pick one, default off)** — Off: short map at start only. autoRecall: at most 3 L0 hits when the step has user text. Entity-name middle path: 1-hop business neighbors only when the utterance names an existing entity. Checked chips share the budget and win first.
- **Extraction** — default after `compaction/end` and a short idle; failures go to pending and replay on the next session-start. Per batch: body ≤3000 chars, at most 24 items.
- **Entries** — search, filter by type, expand business-edge neighbors, “only nodes hanging on this one”, hide expired decisions by default. Rename / edit body / aliases / until, merge same type, archive or delete.
- **Export / import** — JSON is a real round-trip. Markdown is a read-only projection (for people and git), not parseable back. One-shot strict import from WorkBuddy `MEMORY.md`, Claude Code `CLAUDE.md`, and Codex `AGENTS.md`. No watch, no session jsonl, no two-way sync.
- **Check for updates** — Settings compares the installed version with npm latest and shows `dsh plugin --profile web add dsh-trivium` when a newer version exists. It does not auto-upgrade.
- **Embedding** — off by default. Turn on and fill an OpenAI-compatible URL; failures fall back to keyword + graph. Restart `dsh web` after changing settings.

### Agent tools

| Tool | What it does |
|---|---|
| `ctx_find` | Search; L0 summaries and graph paths (incoming `<-label-id`). Entity-name queries also return unexpired about/decided/broke/fixed neighbors. Expired `until` decisions stay out unless the query asks about the deadline |
| `ctx_read` | Full text and incoming edges by id |
| `ctx_remember` | Manual write |
| `ctx_link` | Directed edge between two nodes |

The kernel is still these four. The session graph does not add a fifth tool.

---

## Screenshots

Captured inside DSH Web (`0.1.1-rc.2`). Screenshots below are from the Chinese UI; the plugin follows the DSH host language (`zh` / `en`).

### Conversation — `ctx_find("鉴权")`

<img width="560" alt="ctx_find auth" src="docs/screenshots/02-ctx-find.png">

Session-start injects the short map; the model calls `ctx_find` and hits “auth in this repo goes in header X”.

### Trajectory — injection is visible

<img width="560" alt="Trajectory" src="docs/screenshots/03-trajectory.png">

### Settings — injection strategy

<img width="560" alt="Settings" src="docs/screenshots/04-settings.png">

### Settings — memory entries

<img width="560" alt="Entry list" src="docs/screenshots/05-settings-list.png">

### Session graph — third tab next to Conversation / Trajectory

<img width="560" alt="Session graph" src="docs/screenshots/06-session-map.png">

The title bar shows **Session graph**. A session that has never compacted has one “Next” box; memory chips sit on top (unchecked by default). **Create checkpoint** folds “Next” into a left box. After compaction or `/compact`, historical boxes appear on the left; forks leave a box toward a child session.

---

## Limitations

- If the model never calls `ctx_find` and no chips are checked, the window is mostly the opening short map.
- Extraction misses things; dirty data can be archived / deleted on the chip strip or edited / merged in Settings.
- Do not open the same `.tdb` from two Node processes at once (one `dsh web` is enough).
- Markdown export is for humans; it cannot be parsed back. External import (WorkBuddy / Claude Code / Codex) is one-shot, not two-way sync, and does not ingest session jsonl dumps.
- The session graph projects compaction and fork by default; it does not split boxes by message count. If the window has not reached DSH’s compact line, **Update checkpoints** will not invent history boxes — use **Create checkpoint**.
- Plugin setting changes need a `dsh web` restart.
- After the host moved to rc.8, DSH’s own older session store may not open (official SQLite format change). The workspace `.tdb` graph is still there; leftover boxes on unmatched old sessions are plot residue and do not affect `ctx_find`.

---

## Changelog

**0.4.8** — Write + inject hygiene gate (secrets, mojibake, stutter, JSON envelopes, base64 residue). Settings / session graph follow DSH language. Settings can check npm for updates. One-shot strict import also discovers Claude Code `CLAUDE.md` and Codex `AGENTS.md`. First-turn short map is guaranteed if `session-start` races the first step.

**0.4.7** — Storage bump to `triviumdb@0.7.6` (`searchExact` / `searchBatch` on the engine). find / session graph behavior unchanged.

**0.4.6** — Session graph **Create checkpoint**: fold the current “Next” into a left box. Does not trigger DSH compaction.

**0.4.5** — Host peers widened to `0.1.0-rc.8` and `0.1.1-rc.2`; no nested old `dsh-llm` / `dsh-tools`.

**0.4.4** — `triviumdb@0.7.5`: incoming edges, expand-by-label, delete-by-label go through engine APIs instead of scanning all edges. find / session graph behavior unchanged.

**0.4.3** — Session graph **Update checkpoints**: backfill DSH compression markers and sidebar forks for sessions that existed before the plugin. Never-compacted sessions still have only “Next”.

**0.4.2** — Chip strip can add (one paste = one node) and batch archive / delete. Auto-extract stays strict; chip add writes what you typed.

**0.4.1** — Host pinned to `@deepseek-ai/dsh@0.1.0-rc.8`. Same features as 0.4.0. Confirmed on rc.8: Settings “Trivium memory”, new-session short map, cross-session `ctx_find`, session graph tab.

**0.4.0** — Session graph, memory chips, fork from a checkpoint.

---

## Release info

- GitHub: https://github.com/QWQcool/dsh-trivium
- npm: [`dsh-trivium@0.4.8`](https://www.npmjs.com/package/dsh-trivium)
- Tested host: `@deepseek-ai/dsh@0.1.1-rc.2` (also `0.1.0-rc.8`)
- License: MIT (depends on [TriviumDB](https://github.com/YoKONCy/TriviumDB), Apache-2.0)

---

## Acknowledgements

Parts of the write hygiene gate, npm update check, host-locale UI switching, and Claude Code / Codex file discovery were adapted from [dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory) (Aik358). The product stays a graph kernel (nodes, edges, four tools, quiet default) rather than a journal / calendar companion.
