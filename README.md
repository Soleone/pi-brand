# pi-brand

Name apps fast: the agent generates candidates, you pick favorites in a
multi-select UI, likes persist across rounds so later searches stay on track.

## Flow

1. `/brand <what the app does>` starts a round. The agent generates 20
   candidates, filters to 12-15 survivors, then calls the `brand_pick` tool.
2. The picker UI opens: **Space** toggles, **Enter** confirms,
   **Esc** cancels, typing filters. If nothing is toggled, Enter picks the
   highlighted row.
3. Picks are saved to `.pi/brand.json` (project-local when trusted, global
   fallback otherwise) and injected into later turns, so new rounds bias
   toward the liked vibe and never repeat seen names.

## Commands

- `/brand <description>` start a naming round
- `/brand likes` show liked names (with scores once checked)
- `/brand check <name>` show the cached availability result for a name
- `/brand note <text>` add a direction note (e.g. more like X, less cute)
- `/brand dismiss <name>` reject a name for future rounds
- `/brand clear` wipe rounds, likes, notes, and cached availability

## Availability score (never researched twice)

Scale, already in the UI and storage:

- **perfect**: pretty much no collisions
- **good**: some unrelated collisions, still commercially possible
- **decent**: further clashes, but not in the same category. Okay for open
  source legal wise, and people should not think of the other collision when
  introduced to this app
- **bad**: lots of collisions, some in the same category
- **terrible**: actual high legal risk from a reputable company

Candidates show as `unscored` until researched. The agent still runs the
research (npm, GitHub, DNS, web), but every result is cached forever in
`.pi/brand.json` under `availability`, keyed by lowercased name, so a name
is never researched twice in the same project, not even across sessions.

Flow: before researching a pick, the agent calls the `brand_score` tool
with just the name. A cached hit is final and must be trusted. Only
uncached names get fresh research, which the agent saves via `brand_score`
with the collision signals; `scoreFromSignals()` in `src/scoring.ts` maps
signals to the scale, and the score is backfilled onto every liked entry
and round candidate with that name. Recording also works with
`force: true` to overwrite a stale result.

## Dev

- `npm install`, `npm run check`, `npm test`
