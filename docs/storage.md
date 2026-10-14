# App storage and migration

Default run location:

```text
$DATA/apps/pi-brand/runs/<project-name>-<canonical-path-hash>.json
```

Each project has its own run. Canonical paths keep symlinked checkouts on the same run; projects sharing a basename remain isolated. If `$DATA` is unset, use `$XDG_DATA_HOME/pi-brand/runs/` or `~/.local/share/pi-brand/runs/`. `PI_BRAND_CONFIG` remains an explicit override. `/brand stats` displays the actual path.

Run data is version 2 and includes history, favorites, finalists, the current brief, reserve, evidence and generation metrics. Files are atomically replaced with private permissions. Mutations within a Pi process are queued; multiple independent processes should not edit the same run simultaneously.

On first load of a trusted project, an existing `.pi/brand.json` is imported only if the external run does not exist. A byte-for-byte `<run>.json.v1-backup` is created outside the repository before writing the upgraded state. Automatic import leaves the source file intact; remove it only after verifying the external copy. Untrusted projects never read/import local legacy files. Malformed or unsupported run files fail closed, never silently reset.

This repository's existing naming run has already been migrated and its tracked `.pi/brand.json` removed. The original backup is retained under the app-data directory. Git history is not rewritten.
