# External run storage and editable documents

The default JSON path remains stable across this upgrade:

```text
$DATA/apps/pi-brand/runs/<project-name>-<canonical-path-hash>.json
```

The canonical naming document and human feedback history live beside it as `<stem>.brief.md` and `<stem>.feedback.md`. Without DATA, use `$XDG_DATA_HOME/pi-brand/runs/`, or `~/.local/share/pi-brand/runs/`. `PI_BRAND_CONFIG` overrides the external JSON path; sibling document names follow it. `/brand stats` shows all three paths.

**Project-local storage is forbidden**, even with an explicit override or a symlink pointing back into the project. For Git projects, the repository root is the boundary, not just the current subdirectory. Relative data roots that resolve into the project are rejected too. No run files, naming documents, or migration backups are created there.

Canonical paths keep symlinked checkouts on the same run; unrelated projects sharing a basename remain isolated. Writes use atomic replacement and private permissions. Brief updates verify the document has not changed since loading it. A direct edit observed while an isolated feedback request is in flight is not overwritten. Independent Pi processes should still not write the same run simultaneously.

An explicit shortlist export creates `<stem>.shortlist.md` beside the run file. It is a replaceable, shareable snapshot, not a source of truth. Export never performs research or changes the naming brief, favorites or evidence.

## Sources of truth

- **Naming brief:** the Markdown document is authoritative. Its six sections are Product, Explore, Avoid, Style, Examples, and Format. Reading imports valid direct edits into the active context; the next mutation records their new revision. Invalid or oversized inputs are reported rather than silently truncated or reset.
- **Feedback:** JSON retains original comments, source, author, before/after context, actual changes, and interpretation failures. The Markdown history is an editable reference document. Your annotations survive subsequent appended entries. Annotating it does not automatically alter active generation instructions; update the brief to do that.
- **Generation:** version 4 JSON retains immutable pool inputs and exact prompts, linked to viewed rounds. Pools distinguish generated and externally supplied candidates. Older records explicitly lack provenance. Favorites and cached evidence remain structured run data. Checks retain exact search queries, sources, findings and original check timestamps. New research failures use `error`; cited ambiguities use `review`. Existing score codes and legacy `unknown` records remain readable, with incomplete legacy findings eligible for a fresh check. `selected` holds active names; `liked` holds favorites, a subset. `dismissed` removes names from active membership without deleting rounds or evidence. Manually added names persist in `selected` without a synthetic round; checks and favorites attach to those names normally.

## Migration

A trusted project's old `.pi/brand.json` is read only if no external run exists and no explicit override is set. Its byte-for-byte `.v1-backup` is written externally before import. Untrusted projects never import local data. The original local file is not modified or deleted automatically.

Existing external v1/v2 runs receive a byte-for-byte `.v2-backup` before conversion to the current format. Favorites, rounds, dismissals, model settings, cached evidence, and historical direction notes survive. Historical notes have unknown original attribution/date; the migration does not pretend an assistant summary is a user quote or infer a new active brief from conflicting history.

External v3 runs receive a byte-for-byte `.v3-backup` before conversion to v4. The active list is seeded from the last viewed round plus favorites, excluding dismissed names; older unpicked rounds remain in History rather than flooding the active list. Direct Markdown edits are imported before migration is saved. Existing backups are never overwritten. Favorite-led generation invalidates old reserves.

Old reserves without generation inputs are discarded with a warning. Existing naming preferences seed the first canonical brief. Current, explicit feedback can then refine it. Migration is idempotent; later loads do not append duplicate imported notes.

Corrupt and future-version JSON fails closed. Missing or malformed documents in an established version 3/4 run also fail rather than replacing user content. A clear-run command creates an external reset backup and retains the active brief, feedback, and model settings.
