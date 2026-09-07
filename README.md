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
- `/brand likes` show liked names
- `/brand note <text>` add a direction note (e.g. more like X, less cute)
- `/brand dismiss <name>` reject a name for future rounds
- `/brand clear` wipe rounds, likes, and notes

## Availability score (deep check lands next)

Scale, already in the UI and storage:

- **perfect**: pretty much no collisions
- **good**: some unrelated collisions, still commercially possible
- **decent**: further clashes, but not in the same category. Okay for open
  source legal wise, and people should not think of the other collision when
  introduced to this app
- **bad**: lots of collisions, some in the same category
- **terrible**: actual high legal risk from a reputable company

Candidates show as `unscored` until the npm/GitHub/DNS/web checker lands.
`scoreFromSignals()` in `src/scoring.ts` is the stub mapping the checker
will feed.

## Dev

- `npm install`, `npm run check`, `npm test`
