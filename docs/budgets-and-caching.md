# Budgets, model routing and caching

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

## Context isolation and prompt caching

Creative generation and worker assessment are separate, **single-turn** requests. Neither reads Pi's conversation or reuses the other's messages, tool results, system prompt, or model selection. Even when both roles use the same provider/model, each has a different stable cache-routing identity scoped to this project run, role, and model. This identity is not a stored conversation or a call to warm the cache.

Both prompts keep instructions first and changing data last. Creative input includes a compact product/direction, at most eight taste examples, and 24 recent exclusions; full duplicate filtering remains local. Worker input includes the product and at most three source-linked excerpts per finalist, each trimmed to 400 characters; the full evidence stays in app storage for inspection. Worker assessments cannot cite an undisclosed excerpt. Concurrent search completion cannot reorder the finalist batch. Hard character budgets and a conservative model-context estimate reject oversized requests instead of silently overflowing or switching models.

Requests ask for short cache retention where supported. Cache hits depend on provider-specific thresholds and expiry; small prompts may not be cacheable. There is **no padding, replayed transcript, synthetic warmup, or guarantee of cache savings**. `/brand stats` shows provider-reported cache reads for generation, not a promise about future runs.

No elapsed-time or quality guarantee is implied by these limits. They are work ceilings; compare real runs with `/brand stats`.
