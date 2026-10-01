# pi-brand

Name products without growing the main conversation. Pi supplies the keyboard UI and credentials; a small headless engine owns generation, deduplication, reserves and availability checking.

Requires Pi **0.99.1 or newer** for nested tools and provider-neutral model requests. After updating this extension, run `/reload`.

## Fast path

1. `/brand <what the product does>` generates a ranked pool in an isolated model request, then opens the favorites picker.
2. **Space** toggles, **↑↓** moves, typing filters. **Enter** saves favorites. **Esc** opens a reject/note prompt; Esc again cancels the batch.
3. Picker actions:
   - **0**: save checked favorites and return to the overview, reserving unpicked names rather than rejecting them
   - **1**: another batch, using the reserve first
   - **2**: update the direction and get new names
   - **3**: choose up to three finalists, then check them
   - **4**: save the highlighted name as a favorite and get more like it
4. `/brand finalists` promotes up to three favorites. Older favorites remain taste references, not a research queue. The finalist picker shows newest favorites first; Space toggles, Enter saves, Esc cancels.
5. `/brand check` checks only finalists. `/brand evidence <name>` shows retained findings and source links.
6. Once a product brief exists, **`/brand`**, `/brand overview`, and `/brand status` open the overview without generating. Saving, rejecting or cancelling a favorites round also returns there.

The overview shows favorites, finalists and their cached-check status, reserve, seen/excluded count, direction, and both model roles. Browse all favorites, choose finalists, inspect evidence/history, edit the brief, change models, or continue naming. The favorites list shows each item's status and has a cache-first **Check all favorites** action. It checks in batches of three; selecting one favorite offers individual deep/quick checks and explicit refreshes, without changing finalists. Terminal lists are searchable and show at most ten entries at a time. Esc backs out of subviews; Esc in the overview returns to chat. RPC uses supported select/input dialogs for the same actions.

You do not have to generate more names to finish shortlisting. With many favorites, go straight to **Choose finalists**. See [UI navigation and boundaries](docs/ui-navigation.md) for the complete flow and remaining command-only operations.

Default exploration makes **no network availability checks**. `/brand screen` explicitly requests a quick web screen of finalists. `/brand screened` opts into screening **three candidates before display**, three at a time rather than researching an entire speculative pool. Screened mode can add up to 45 seconds after generation.

## Budgets and model routing

- Default creative model: `openai/gpt-6-luna`. **`/brand-settings`** (also `/brand settings`) selects a creative model for generation and an optional worker model for source-backed availability assessment. The worker defaults to **Same as creative**, preserving existing runs. `/brand model <provider/model-id>` and `/brand worker <provider/model-id|same>` provide command equivalents.
- Settings are saved with **this project's naming run**, not global defaults. They never switch the main session model. Available choices use authenticated scoped models, or the available catalog when no scope is set. Unavailable models fail explicitly; there is no silent fallback.
- Use a stronger creative model for name quality and a cheaper worker for bounded evidence interpretation, after checking its accuracy. UI navigation, filtering, deduplication, scoring, cache handling, storage and registry requests do not need a model. Naming does not add a second worker pass. Changing the worker retains the reserve; changing the creative model clears it. Cached findings are retained until explicit refresh.
- Generation receives one compact brief, eight recent taste examples and a recent exclusion sample. The complete exclusion set stays local.
- Each request processes at most 24 proposals. A batch allows at most two model requests, with one refill only when fewer than eight names survive.
- Request timeout: 30 seconds. Entire generation timeout: 45 seconds. Output: at most 3,000 creative or 2,000 worker tokens per request (less if the selected model has a tighter output/context limit), low reasoning, no provider retries or browsing tools.
- Up to 24 valid candidates enter the pool. Show 12 at a time and retain the rest, so **More** often needs no model call. A smaller remaining batch is shown rather than regenerating prematurely.
- A changed direction, product, word/length constraint or model clears the reserve. Rejected batches stay excluded; cancelled batches return to the reserve.
- No brand state is injected into unrelated agent turns. Generation commands and picker navigation run directly, not through queued main-agent prompts.
- Each check batch contains at most three finalists or favorites and has a 45-second operation budget. **Check all favorites** runs cache-first deep checks in sequential batches of three. Searches within a batch run concurrently and one isolated model request interprets their bounded, source-linked excerpts. A decisive same-category/famous collision skips registry requests.
- `/brand stats` reports generation time, calls, uncached input, cache reads, output and catalog-reported cost for the most recent 50 successful pools. Assessment costs and failed/aborted requests are not included in these generation-only metrics. Tool-driven operations also return their nested model usage to Pi. Direct command generation is tracked in app metrics, not assumed to appear in Pi's session totals.

### Context isolation and prompt caching

Creative generation and worker assessment are separate, **single-turn** requests. Neither reads Pi's conversation or reuses the other's messages, tool results, system prompt, or model selection. Even when both roles use the same provider/model, each has a different stable cache-routing identity scoped to this project run, role, and model. This identity is not a stored conversation or a call to warm the cache.

Both prompts keep instructions first and changing data last. Creative input includes a compact product/direction, at most eight taste examples, and 24 recent exclusions; full duplicate filtering remains local. Worker input includes the product and at most three source-linked excerpts per finalist, each trimmed to 400 characters; the full evidence stays in app storage for inspection. Worker assessments cannot cite an undisclosed excerpt. Concurrent search completion cannot reorder the finalist batch. Hard character budgets and a conservative model-context estimate reject oversized requests instead of silently overflowing or switching models.

Requests ask for short cache retention where supported. Cache hits depend on provider-specific thresholds and expiry; small prompts may not be cacheable. There is **no padding, replayed transcript, synthetic warmup, or guarantee of cache savings**. `/brand stats` shows provider-reported cache reads for generation, not a promise about future runs.

No elapsed-time or quality guarantee is implied by these limits. They are work ceilings; compare real runs with `/brand stats`.

## One current brief

`/brand brief` shows the current product, direction, constraints and both model roles. Historical direction notes are retained but no longer replayed. `/brand note` and `/brand pivot` replace the current direction instead of stacking contradictory instructions.

Defaults: familiar single words, up to 12 characters, inspect `.com` and `.app`, package/handle checks off.

```text
/brand note familiar, energetic English words
/brand words single
/brand words multiple
/brand length 10
/brand domains com dev
/brand packages on
```

Package and repository checks are opt-in because a consumer app need not have an unused npm name. Changing check requirements retains existing cached findings; request a refresh explicitly if needed.

## Evidence, not legal clearance

The existing `perfect / good / decent / bad / terrible` scale is retained for compatibility, plus **unknown** for incomplete evidence. Labels describe the checks performed, not trademark clearance. Missing signals never default to a clean result. A strong unrelated brand association is separate from a same-category collision.

Checks retain factual reasons, source URLs, bounded excerpts, stage, warnings, requirements and timestamps. Deep checks add domain registry lookups and optional npm/GitHub queries. A registry 404 means **no record found**, not a guarantee a domain is registrable or affordable. Repository/package matches alone do not establish a brand collision. Domains used by active businesses still need contextual review.

Cached legacy results are preserved as-is, including their original scores and dates. They have no retained research sources. Known results do not expire. A deep `unknown` from an older research version is automatically retried once on the next deep check; current-version unknowns remain cached until explicit refresh or a research update. `/brand check refresh` or `/brand screen refresh` explicitly refreshes selected finalists; the favorites menu can refresh an individual saved favorite. Upgrading a quick screen to a deep check reuses its web evidence and adds missing registry checks without repeating web search.

Research uses the installed `web_search` tool through Pi's nested-tool API and permission hooks. Enable that extension before checking. Searches use complementary, product-aware query angles and retry once when no source-linked results are returned. Missing tools, blocked searches, failed requests and unsupported model judgments can still remain unknown. Raw search results and speculative pools do not enter the main conversation; command-dispatched checks use one short request for the owned `brand_check` operation, then automatically return a concise completion response. No manual `continue` is needed.

## App storage and migration

Default run location:

```text
$DATA/apps/pi-brand/runs/<project-name>-<canonical-path-hash>.json
```

Each project has its own run. Canonical paths keep symlinked checkouts on the same run; projects sharing a basename remain isolated. If `$DATA` is unset, use `$XDG_DATA_HOME/pi-brand/runs/` or `~/.local/share/pi-brand/runs/`. `PI_BRAND_CONFIG` remains an explicit override. `/brand stats` displays the actual path.

Run data is version 2 and includes history, favorites, finalists, the current brief, reserve, evidence and generation metrics. Files are atomically replaced with private permissions. Mutations within a Pi process are queued; multiple independent processes should not edit the same run simultaneously.

On first load of a trusted project, an existing `.pi/brand.json` is imported only if the external run does not exist. A byte-for-byte `<run>.json.v1-backup` is created outside the repository before writing the upgraded state. Automatic import leaves the source file intact; remove it only after verifying the external copy. Untrusted projects never read/import local legacy files. Malformed or unsupported run files fail closed, never silently reset.

This repository's existing naming run has already been migrated and its tracked `.pi/brand.json` removed. The original backup is retained under the app-data directory. Git history is not rewritten.

## Commands

```text
/brand                    overview when a brief exists; otherwise start a run
/brand overview|status    overview without generation
/brand <description>      generate and pick favorites
/brand more              next reserve batch or bounded generation
/brand pivot <note>       new direction, then generate
/brand note <note>        update direction only
/brand likes             favorites and finalists
/brand finalists [names]  choose at most three favorites
/brand check [refresh]    deeper finalist checks
/brand check <name>       show one cached result
/brand screen [refresh]   quick finalist web screen
/brand screened          screen three names before display
/brand evidence <name>    retained findings and source links
/brand brief             current brief and model
/brand-settings          choose creative and worker models for this project
/brand settings          same settings menu
/brand model <provider/id>
/brand worker <provider/id|same>
/brand words single|multiple
/brand length <3-30>
/brand domains <suffixes>
/brand packages on|off
/brand stats             path, reserve and generation metrics
/brand keep <names>      save favorites from a recorded batch
/brand dismiss <names>   exclude names; remove from favorites and finalists
/brand excluded          complete seen/excluded name list
/brand history           recorded candidates, reserve, dismissals and direction notes
/brand clear             confirm clearing this run; backup remains
/brand help
```

Separate multiple names with commas, especially multiword names. Print/JSON mode saves candidate batches; use `keep` and `finalists` to select without the terminal picker. RPC uses select dialogs, not terminal components.

Compatibility tools `brand_pick`, `brand_score` and `brand_seen` remain available. The owned workflow uses `brand_generate` and `brand_check`; callers no longer need per-name cache choreography. `brand_score` supports a batch `names` lookup. Manual legacy signal recording remains supported without manufacturing missing signals.

## Development

```sh
npm install --ignore-scripts
npm run check
npm test
npm run validate
```

Tests are offline and use fake model/search/fetch responses. They cover migration/backups, persistence, prototype-safe caches, exclusions, reserve reuse, timeouts/cancellation, source validation, cached-check preservation, finalist limits, RPC behavior, narrow terminal rendering and absence of main-context injection. Live model quality and provider latency still require a real naming run.

Public headless seams: `pi-brand/generation`, `pi-brand/engine`, `pi-brand/checker`, `pi-brand/store`. They take explicit state and request adapters, so a future CLI or browser interface can reuse the workflow instead of replacing it.
