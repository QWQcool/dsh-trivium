# 0.8.4 — Settings surface rebuild

2026-11-03. **Presentation only**: server behaviour, default switches, database format, model tools, token budgets and the supersede rules are unchanged.

## What changed

The settings card used to be one long page with two tabs (memory / recall). It is now four pages, still behind the single host entry **Settings → Trivium memory**.

| Page | Holds | Was |
|---|---|---|
| **Memory** (default) | Workspace picker, type filter, search, expired / replaced switches, entry list and inline editing, archive / delete / merge, replace and undo | the list tab |
| **Context** | “Sent this turn” (real delivery ledger + budget) and a read-only probe (candidates, real drop reasons, the text that would be sent) | first half of the recall tab |
| **Activity** | Run diagnostics (last extraction, stuck, recovered, last map injection), revision-chain check, pending corrections, recovery state, change log, recall traces | second half of the recall tab + diagnostics that had no home |
| **Settings** | Memory behaviour (injection strategy + configuration fold), display (plugin language), data (export / import / external), vector (embedding), about (update check) | the always-visible tail of the old page |

Also:

- **Ctrl/Cmd+K** command palette: 4 pages and 13 section entries; substring first, subsequence fallback; ↑↓ to select, Enter to jump, Esc to close, Tab trapped inside; focus enters the input on open and returns on close. It only navigates — it never writes a setting.
- **Detail in three containers**: at ≥1000 px of card width the node detail sits beside the list; 720–999 px opens it as a dialog (Esc / backdrop close, focus trap); narrower keeps the inline expansion. The band comes from the card's own width (ResizeObserver), not the window — the host settings modal is a fixed ~600 px.
- **Visual language**: the prototype's 12 colours and 12 px radius are CSS custom properties on the card root, and every `ui.*` value keeps its old literal as a fallback. The card follows the host light/dark scheme; outside the card (chips tab, host shell) nothing changes.
- **Grouped settings**: “Check for updates” moved from second to last; language, injection strategy, data and vector are no longer hidden inside the fold. The fold keeps the advanced switches only.

## What did not change

- Tool names, parameters and return shapes, `DIM=1536`, the schema, and the pinned `triviumdb` version.
- Defaults: injection off, extraction on, chips off, embedding off.
- No new server endpoint and no new write path. “Add memory” still goes through the existing text-only `POST /chips`.
- No “strict create” flow (that needs a creation contract first), and no button that cannot work.

## Verification

| Layer | Result |
|---|---|
| Structure regression | `node scripts/smoke-p78.mjs` → **54/54** (four pages, three layout bands, palette, Esc/focus) |
| Full suite | `node scripts/run-all.mjs` → **74/74** (0.8.3 was 73/73; p78 is new) |
| Existing client tests | p18/p24/p26 remapped to the new pages; the assertions keep their intent (on-demand loading, corrections queue, settings save receipt) |
| Real host | Local DSH web: four pages switch, Ctrl+K works, 420 px card expands inline, widening to 1120 px shows the side detail pane; workspace `.dsh` files kept their mtime during the run |
| Evidence check | `node scripts/verify-evidence.mjs` → 9/9 |

## Known limits

1. **The 900–1199 px dialog band is only covered by structure tests** — the host settings modal is a fixed ~600 px, so the real host cannot reach it.
2. **Dark theme was not verified on the device** — screenshots and the host run were light; the variables and fallbacks exist but were not eyeballed.
3. **The palette only navigates**: no save, import or delete runs from it, so it cannot bypass a confirmation.
4. **Page state is not persisted**: reopening the settings returns to Memory; drafts survive page switches.
5. No migration: no schema change, no settings-key change.

## Upgrade

```bash
dsh plugin --profile web add dsh-trivium@0.8.4
# restart dsh web
```
