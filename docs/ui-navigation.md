# Naming flow

The everyday loop is **generate → favorite/react → refine → generate**. Checking saved favorites is available whenever you are ready, without promotion to a separate finalist list.

| Surface | Actions | Exit |
| --- | --- | --- |
| `/brand` workspace | More names, Give feedback, Review favorites; Brief / Details is secondary | Esc/Close returns to chat without generating |
| Names picker | Space toggles; 1 More names; 2 Give feedback; 3 Review favorites; ? Batch details | Enter or Esc saves explicit selections and closes |
| Feedback editor | Enter a comment; the isolated brief editor makes targeted changes and reports the actual diff | Cancel keeps the current brief; interpretation failures retain the raw comment |
| Favorites | Browse status, Check selected favorites, explicitly Check all; one name offers availability, similar names, removal, details | Back/Esc returns to workspace |
| Check selection | Select up to three saved favorites, then run a default deep check | Esc cancels without changing favorites |
| Favorite details | Sources, refresh availability, quick screen, explicit quick refresh | Back/Esc returns |
| Brief / Details | Edit naming brief, Feedback history, Why these names?, Settings, History, Statistics | Back/Esc returns to workspace |
| Naming document | Edit Product, Explore, Avoid, Style, Examples, and Format in one editor | Save validates and records changes; Cancel leaves it alone |
| Feedback document | Read original comments and interpretations; add corrections or annotations | Save preserves annotations; active brief remains unchanged |
| Saved round | Inspect actual inputs or save previously shown names as favorites | Closing never rewrites the round |
| Settings | Models, domain suffixes, optional package/repository checks | Back/Esc returns |

## Predictable state

- The cursor and filter never imply selection. “More like” adds an explicit taste reference, not a favorite.
- Unselected names are seen, not negative taste feedback or explicit dismissals. Seen names are not automatically repeated; saved history lets you revisit them.
- Enter and Esc have the same save-and-close behavior in ordinary exploration. Selection-only dialogs use Esc to cancel instead.
- Closing or giving feedback does not remove candidates or rounds. There is no whole-round rejection mode.
- More labels whether it serves the previous pool or performs a new request. Active brief and creative-model changes clear the reserve; a snapshot key also prevents stale inputs from being reused.
- Favorites do not silently influence prompts. Add explicit examples or use More like a name. All effective naming instructions live in the document.
- Feedback updates preserve unrelated sections. Short acknowledgements show changes; the feedback record retains the full before/after interpretation.
- Legacy rounds retain their original names but have no fabricated generation inputs. Legacy finalists remain compatible with commands; the normal UI does not require them.

## Modes and boundaries

The terminal uses a bounded searchable picker. RPC uses supported select/editor dialogs with the same actions and state consequences. Print/JSON mode records pools and rounds without UI; use `keep`, `feedback`, `check <names>`, and `brand_context` to work non-interactively.

Command-driven checks need a tool context for nested web search. They dispatch one owned `brand_check` request, then return automatically to chat for the assistant's concise summary. Tool-driven screened mode can perform checks directly and return to the workspace. Inspect stored results on demand; no raw research is injected into unrelated conversation turns.

No winner state, generic undo, run switcher, or automatic legal-clearance claim is introduced. Model settings remain per-project-run, not user-wide defaults. Generation statistics are not an all-operation spend ledger.
