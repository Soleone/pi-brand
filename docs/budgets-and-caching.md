# Budgets, model roles and caching

## Requests

- The creative model generates names. Default: `openai/gpt-6-luna`.
- An isolated **brief-editing** request uses the creative model to interpret feedback when the caller has not supplied an explicit targeted patch. It sees only the active brief and the original comment, not conversation history. It does not generate names or research. Explicit patches and document edits need no model request.
- An optional worker model assesses retained availability evidence. Same as creative is the default. Models are selected in Settings or `/brand-settings`, scoped to this run. Unavailable models fail explicitly; the main Pi model never changes and no fallback is silently selected.
- Generation sees the complete active product, Explore, Avoid, Style, explicit examples, and format constraints. All favorites are supplied explicitly as positive taste examples, with the brief taking priority. Other selected names and feedback history are not taste instructions. Directions and product descriptions are not silently clipped.
- At most 24 proposals per naming request, at most two requests per pool. One refill is allowed only when fewer than eight names survive. Show 12 names at a time and retain the rest with their source pool and input key.
- Naming requests time out at 30 seconds; the operation ceiling is 45 seconds. Brief interpretation has a 30-second deadline. Creative output is at most 3,000 tokens; brief editing and worker assessment at most 2,000. Smaller-context models may receive less output space or an explicit error.
- Creative prompts have a 5,000-character ceiling; brief-editing and assessment prompts have 14,000. Oversized input fails with guidance rather than silently discarding constraints. Examples are explicit, at most 30. Feedback comments accept 1-6,000 characters.
- No provider retries, browsing tools, synthetic warmup, or second naming-quality pass. Brief and favorite changes clear old reserves. Generation input keys include the complete favorite examples, so old pools cannot be reused under different taste inputs.
- Default naming performs no availability research. `/brand screened` explicitly screens three new candidates before display; it may add up to 45 seconds per batch.
- Availability checks process up to three saved names at a time, within a 45-second operation budget per batch. Explicit batch selections run sequentially; the tool accepts up to 1,000 named targets with `batch: true`. Check pending skips conclusive retained assessments but retries unknown or incomplete ones; Shift+C requests fresh checks with the current worker model. Checking never favorites names. Within each batch searches are concurrent; one bounded isolated request interprets source-linked excerpts. Decisive collisions skip registry requests.

## Provenance and usage

Each successful pool saves the creative system prompt, exact request prompts (including refills), effective brief with local exclusions, model, revision, and original candidates. Viewed rounds link to that pool and record whether names were newly generated, served from a reserve, or externally supplied. Historical unknown inputs are labeled unknown.

`/brand stats` reports provider-reported generation usage, costs and elapsed time for the most recent 50 successful pools. It is not a total-spend ledger: brief editing, assessment, failed and aborted requests are excluded. Tool-driven operations return their nested model usage to Pi; direct command usage is not assumed to appear in Pi's totals.

## Isolation and caching

Creative generation, brief editing, and worker assessment are separate single-turn requests. Each gets a distinct cache-routing identity scoped to this project run, model, and role. Identity is not a stored conversation or an idle cache warmup.

The creative prompt keeps stable instructions first and varying exclusions last. At most 24 recent exclusions appear in its sample; full duplicate enforcement remains local. Worker requests see only the product and bounded source-linked excerpts, not creative taste or the feedback record. Concurrent search completion does not reorder a batch.

Short cache retention is requested where supported. Actual hits depend on provider thresholds and expiry; compact prompts may not be cacheable. There is no padding, transcript replay, synthetic warmup, or promised savings. `/brand stats` reports actual generation cache reads, not a latency or quality guarantee.
