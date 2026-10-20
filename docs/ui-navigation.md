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
| `c` | Start **Check pending** for unchecked, failed, outdated or legacy-incomplete names | Start **Check marked**, reusing completed findings |
| `C` (Shift+C) | Start **Recheck all** in the current filtered list | Start **Recheck marked** |
| `d` | Discard the highlighted name, after confirmation | Discard marked names, after confirmation |
| `f` | Toggle favorite on the highlighted name | Favorite marked names; if all are favorites, demote them to Selected |
| `s` | Toggle best-first / recent order, preserving focused name | Same; marks stay attached to names |
| `e` in Favorites | Export all favorites with saved findings and sources | Same; export does not depend on temporary marks |

Check shortcuts start immediately, with no intermediate confirmation screen. Checks run sequential batches of at most three, with batch progress shown until all results are saved. Progress clears on success, failure or cancellation. The refreshed list shows a completion notice counting assessed names, review findings and failures, or a stopped-check notice. Rechecks use the current worker model. Checking never changes a name's lifecycle stage or favorites.

A successful search with no hits or no observed collisions produces **clear**, not unknown. Specific cited ambiguities produce **needs review**, which is a completed finding rather than an automatic-retry loop. Failed searches, malformed or incomplete worker responses, and deadlines produce **check failed**, with a reason. Successful peers in a batch remain saved. Optional domain/package lookup failures are warnings, not a reason to erase the collision finding.

Check pending includes unchecked, failed, outdated and legacy-incomplete names. A change to the product or lookup requirements marks old findings for rechecking. Current quick screens reuse successful collision assessments for the deeper registry pass. Recheck all bypasses saved findings and uses the current worker model. Failed refreshes preserve previous useful evidence and its original timestamp, with a visible failure warning.

Searches include the exact name alone as well as product/category queries. Search completion is validated before zero hits count as a useful negative finding; partial provider failures are errors even if another query returned sources. Details retain exact queries, reasons, sources and suggested next steps. Evidence remains preliminary, not trademark clearance.

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

## Share a shortlist

Press `e` in Favorites, or run `/brand shortlist`, to save all favorites as a Markdown snapshot beside the external run file (`<stem>.shortlist.md`). The report orders saved findings best-first and includes sources, queries, next steps, dates, warnings and legal limitations. Unchecked names stay explicitly unchecked. Export includes favorite changes just made in the workspace, performs no research and does not change the brief or taste references. Re-export replaces the snapshot.

## Columns and other modes

Rows show **bulk mark, name, favorite star, assessment** using terminal display widths. Active membership is implied; there is no repeated Selected label or separate check-depth column. A colored dot plus a short label shows **clear, light use, some overlap, crowded, name clash** or **check failed**; ` needs review` marks a cited ambiguity. Older incomplete or outdated findings say **recheck needed**, distinct from `—` (unchecked). Check depth, date, model and evidence stay in details. Discarded names in historical rounds use a dim trash icon instead of the favorite star.

A one-cell Nerd Font checkmark precedes marked names; unmarked rows reserve a blank cell. There are no icon controls in the header. Keyboard focus uses a bold, accented name, independent of bulk marks. Name width is capped at 28 columns. Screens narrower than 20 columns hide assessments; details retain the information. Color reinforces text labels, never replacing them: green for usable, yellow for caution, red for a name clash, accent for a failed check and gray for unresolved findings.

RPC retains supported select/editor dialogs and its compatibility picker. Print/JSON mode records generated batches as selected without UI. `/brand keep <names>` remains the compatibility command to favorite names; `/brand dismiss <names>` discards.

`/brand check <names>` checks up to three saved names; `/brand check all` checks pending active names (unchecked, failed or outdated); `/brand check all refresh` explicitly rechecks all active names. `brand_check` accepts a named batch with `batch: true`, `uncheckedOnly` and explicit `refresh`. The legacy `allFavorites` option remains supported.

Checks started in the terminal workspace return automatically to the list with updated results, preserving its tab, filter, cursor and bulk marks. Command-driven checks temporarily return to chat for one owned `brand_check` request, then reopen the list when that agent run ends, including after an interruption. Session changes and shutdown cancel this return. Tool-driven checks run directly in the workspace loop. Ordinary chat/tool checks and `/brand check` do not open a list that was not already being used. No research is injected into unrelated turns.
