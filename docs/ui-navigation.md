# Naming workspace

The everyday loop is **generate → select → favorite/react → refine → generate**. The terminal opens on the active list, not an action menu or the full brief.

## Name lifecycle

- **New** is transient while generation runs. A completed batch joins the active list as **Selected**.
- **Selected** means membership in the active list, not a checked checkbox.
- **Favorite** is a starred active name. Favorites are positive taste references alongside the brief.
- **Discarded** names leave the active list and favorites, but remain in saved rounds with their evidence. They are still excluded from future suggestions. Restore a historical name with `s` in its details, or favorite it explicitly.

Unfavoriting demotes to Selected. Discarding removes from the active list. Neither rewrites a saved round. All active generations accumulate in Names; History can open an individual saved round.

## Bulk marks and checks

Space marks/unmarks a row. `a` marks/unmarks all rows in the current filtered list, including rows beyond the visible page. Marks are temporary and independent of stages. Changing tabs or search clears them; Esc clears marks before leaving the list.

| Action | No marks | With marks |
| --- | --- | --- |
| `c` | Start **Check pending** for the current filtered list | Start **Check marked**, reusing conclusive results and retrying unknowns |
| `C` (Shift+C) | Start **Recheck all** in the current filtered list | Start **Recheck marked** |
| `d` | Discard the highlighted name, after confirmation | Discard marked names, after confirmation |
| `f` | Toggle favorite on the highlighted name | Favorite marked names; if all are favorites, demote them to Selected |

Check shortcuts start immediately, with no intermediate confirmation screen. Checks run sequential batches of at most three, with batch progress shown while running. Rechecks use the current worker model. Checking never changes a name's lifecycle stage or favorites.

Check pending includes names with no saved assessment and names whose last check was **unknown**. Conclusive assessments are skipped. This makes an inconclusive result retryable without forcing a full recheck or discarding useful context: a current screen may reuse its evidence for the deeper pass, while failed or incomplete searches run again. Recheck all bypasses saved assessments and uses the current worker model. A failed forced refresh retains a previous conclusive record rather than destroying useful evidence; retrying an unknown may still add evidence. Evidence remains preliminary, not trademark clearance.

## Screens

| Screen | Navigation and actions |
| --- | --- |
| Names | Active selected names and favorites, newest rounds first. ↑↓ moves; Enter opens details; Space marks. |
| Favorites | Same table, filtered to favorites. The same bulk actions apply. |
| History | Saved rounds; Enter opens one in Names. Esc returns to the active list. |
| Name details | Name-led, width-capped fields for availability, checking model/date, findings and evidence. Space or `f` toggles favorite; `c` starts a check; `m` prepares similar-name refinement. `?` reveals refresh, quick screen and discard. Long evidence scrolls without hiding the name or controls. |
| Generation (`g`) | Shows brief revision, direction, favorite/example counts and reserve versus new model call. Enter explicitly starts. Brief, favorite or creative-model changes invalidate old reserves. |
| Brief (`b`) | Hidden by default. `e` edits, `f` gives AI-interpreted feedback, `h` opens feedback history, `i` inspects saved inputs, `s` opens settings. |

Tab or ←/→ switches the list screens. Navigation and Enter on a row never start model or web work. `/` enters search mode. While typing a search, action keys belong to the search. Enter ends typing; Esc ends typing, clears marks/filter or returns from a history round before finally closing the list. Ctrl+C closes.

`n` (or `N`) in Names or Favorites opens **Add a name**. Enter a name of up to 60 characters; cancel or leave it blank to change nothing. The active Names list opens with that name focused and prior search/marks cleared. Adding never generates, checks or favorites a name. Existing names are reused case-insensitively, retaining evidence and favorites; discarded names are restored. Saved rounds are not changed.

Favorite changes save when leaving the workspace for another operation or closing it. Feedback returns to browsing; generation is a separate step. The brief takes priority over favorite examples. Selected and discarded names are duplicate exclusions, not taste instructions; feedback history is reference only.

## Columns and other modes

Rows show **bulk mark, name, favorite star, assessment** using terminal display widths. Active membership is implied; there is no repeated Selected label or separate check-depth column. A colored dot plus a short label shows an assessment; ` unknown` distinguishes an inconclusive check from `—` (unchecked). Check depth, date, model and evidence stay in details. Discarded names in historical rounds use a dim trash icon instead of the favorite star.

A one-cell Nerd Font checkmark precedes marked names; unmarked rows reserve a blank cell. There are no icon controls in the header. Keyboard focus uses a bold, accented name, independent of bulk marks. Name width is capped at 28 columns. Screens narrower than 20 columns hide assessments; details retain the information. Color reinforces text labels, never replacing them.

RPC retains supported select/editor dialogs and its compatibility picker. Print/JSON mode records generated batches as selected without UI. `/brand keep <names>` remains the compatibility command to favorite names; `/brand dismiss <names>` discards.

`/brand check <names>` checks up to three saved names; `/brand check all` checks pending active names (unassessed or unknown); `/brand check all refresh` explicitly rechecks all active names. `brand_check` accepts a named batch with `batch: true`, `uncheckedOnly` and explicit `refresh`. The legacy `allFavorites` option remains supported.

Checks started in the terminal workspace return automatically to the list with updated results, preserving its tab, filter, cursor and bulk marks. Command-driven checks temporarily return to chat for one owned `brand_check` request, then reopen the list when that agent run ends, including after an interruption. Session changes and shutdown cancel this return. Tool-driven checks run directly in the workspace loop. Ordinary chat/tool checks and `/brand check` do not open a list that was not already being used. No research is injected into unrelated turns.
