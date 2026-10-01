# Naming workspace navigation

The overview is the hub, not another naming round. Once a brief exists, `/brand`, `/brand overview`, and `/brand status` open it without model calls.

## Navigation coverage

| Surface | Enter from | Actions | Return path |
| --- | --- | --- | --- |
| Overview | `/brand`; completed/cancelled/rejected favorites round; picker `0` | Favorites, finalists, checks, evidence, more names, brief, models, history, stats | Esc or Close overview returns to chat |
| Favorites picker | New product, `/brand more`, overview More names, generation tools | Space toggles; Enter saves; 1 more; 2 direction; 3 finalists then deep check; 4 more like highlighted; 0 save picks and pause | Save/reject/cancel/0 returns to overview; 1/2/4 continue naming |
| Rejection note | Esc or empty Enter in favorites picker | Enter rejects the whole round and saves an optional direction; Esc with text returns to picker | Esc on an empty rejection note cancels the batch, reserves it, then opens overview |
| Direction note | Picker 2 | Enter saves picks and generates in the new direction; empty direction continues current direction | Esc returns to picker |
| Favorite browser | Overview Browse favorites | The searchable list shows each favorite's cached status and offers Check all favorites (cache-first deep checks in batches of three); selecting one opens evidence, individual checks/refreshes, finalist selection, and confirmed dismissal | Back/Esc returns to overview; checks automatically complete back in chat without a manual `continue` |
| Finalist picker | Overview, `/brand finalists`, favorites picker 3 | Save 0-3 selections; clear with empty Enter; favorites themselves stay intact | Overview action returns to overview; direct command returns to chat; picker 3 then dispatches a check |
| Check selection | Overview Check finalists | Deep or quick, cache first or explicit refresh | Back/Esc returns to overview; command checks automatically complete back in chat without a manual `continue` |
| Evidence | Overview or `/brand evidence <name>` | Read score, reasons, warnings, retained URLs, stage/date | Overview resumes after notification; direct command returns to chat |
| Brief | Overview Edit brief; `/brand brief` and field commands | Product, direction, word count rule, max length, domains, package checks | Overview resumes after edits; command returns to chat |
| Model settings | Overview; `/brand-settings`; `/brand settings` | Creative, worker or Same as creative; Save or Cancel | Overview caller returns there; direct command returns to chat |
| Model selector | Settings role | Search authenticated scoped/available models | Esc cancels only the role change; Save settings persists the draft |
| History | Overview History and exclusions; `/brand history`; `/brand excluded` | Read all recorded candidates, exclusions, reserve, historical direction | Back/Esc returns to overview; commands return to chat |
| Generation stats | Overview or `/brand stats` | Read saved run path and generation-only metrics | Overview resumes; command returns to chat |

RPC has the same favorites actions through select/input dialogs, including pause, direction, rejection, similar names and finalists. It cannot display custom terminal components. Print/JSON modes expose command alternatives and saved run data, without interactive navigation.

## State consequences

- **Pause (`0`)** saves only explicitly toggled picks. Unpicked candidates go back to the reserve and are removed from that round's seen history, so resuming can show them again. The highlight and filter never imply selection.
- **Cancel** reserves the whole batch and removes its round. It does not save toggled picks.
- **Save** keeps selected favorites; unpicked names remain seen/excluded, as before.
- **Reject** permanently excludes the round; it does not save toggled picks.
- **More** saves picks and moves to the next reserve batch or bounded pool.
- **Dismiss** removes a favorite and any finalist selection, retaining candidate history and cached evidence. `/brand keep <name>` can restore a recorded name manually.
- **Creative model changes** clear the reserve. Worker changes do not. Neither changes favorites, history, cached checks, or Pi's session model.
- **Settings Cancel** discards the entire draft. Saving settings makes no model requests.

## Deliberate boundaries and remaining gaps

- Command-driven checks need a tool execution context for nested web searches. They dispatch one owned `brand_check` request through Pi. When it finishes, the assistant automatically gives a concise completion response; no manual `continue` is needed. Checks can target finalists or explicitly selected saved favorites; Check all favorites processes the list in sequential batches of three. These checks do not change the finalist selection. Reopen `/brand` to see every saved status. A screened tool-driven workspace can perform its checks directly and return to overview.
- Opt-in screening of three *new* candidates remains `/brand screened`; it is not the overview's ordinary More action. Clear-run confirmation and manual keep remain commands.
- There is no dedicated winner/final-decision state, generic undo, run switcher, or arbitrary raw-state editor. Finalists are the persisted shortlist, not a legal-clearance claim.
- Generation stats are not an all-operation spend ledger: assessment and failed/aborted request costs are excluded. Tool calls report nested usage to Pi.
- Model settings are project-run settings, not user-wide defaults. There is no automatic price-based routing or quality fallback.
- History and the actual saved JSON path are exposed for inspection. This is broad read access, not a claim that every stored field has its own editor or that every operation is available in every UI.
