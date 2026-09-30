import { Type, type Usage } from "@earendil-works/pi-ai";
import { BorderedLoader, withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { ASSESSMENT_SCHEMA, checkFinalists, extractWebEvidence, type CheckDependencies } from "./checker.ts";
import { takeBatch } from "./engine.ts";
import { addUsage } from "./generation.ts";
import { generationRequest, requestStructured } from "./model.ts";
import { pickNames } from "./picker.ts";
import { buildAvailabilityPrompt } from "./prompt.ts";
import { scoreFromSignals, type CollisionSignals } from "./scoring.ts";
import { addLikes, availabilityKey, dismissNames, excludedNames, getAvailability, getAvailabilityBatch, loadBrandState, recordAvailability, recordRound, saveBrandState, setDirection, setFinalists } from "./store.ts";
import { emptyBrandState, type AvailabilityRecord, type BrandState, type Candidate } from "./types.ts";

const CANDIDATE_SCHEMA = Type.Object({ name: Type.String({ maxLength: 60 }), flavor: Type.Optional(Type.String({ maxLength: 120 })), style: Type.Optional(Type.String({ maxLength: 60 })) });
const SIGNALS_SCHEMA = {
  famousCollision: Type.Optional(Type.Boolean()), sameSpaceCollision: Type.Optional(Type.Boolean()),
  giantAssociation: Type.Optional(Type.Boolean()), unrelatedCount: Type.Optional(Type.Integer({ minimum: 0 })), comParked: Type.Optional(Type.Boolean()),
};
const CHECK_OPTIONS = Type.Object({ stage: Type.Optional(Type.Union([Type.Literal("screen"), Type.Literal("deep")])), refresh: Type.Optional(Type.Boolean()) });

function textResult<T>(text: string, details: T, usage?: Usage, terminate = true) {
  return { content: [{ type: "text" as const, text }], details, ...(usage ? { usage } : {}), ...(terminate ? { terminate: true } : {}) };
}

function load(ctx: ExtensionContext) {
  const run = loadBrandState(ctx.cwd, ctx.isProjectTrusted());
  for (const warning of run.warnings) ctx.ui.notify(warning, "warning");
  return run;
}

async function mutate<T>(ctx: ExtensionContext, change: (state: BrandState) => T): Promise<T> {
  const path = load(ctx).path;
  return withFileMutationQueue(path, async () => {
    const run = load(ctx);
    const result = change(run.state);
    saveBrandState(path, run.state);
    return result;
  });
}

function namesFrom(text: string, state: BrandState): string[] {
  const whole = [...state.liked, ...state.rounds.flatMap((round) => round.candidates)].find((entry) => availabilityKey(entry.name) === availabilityKey(text));
  return whole ? [whole.name] : text.split(text.includes(",") ? /\s*,\s*/ : /\s+/).map((name) => name.trim()).filter(Boolean);
}

function showRecord(ctx: ExtensionContext, name: string, record?: AvailabilityRecord): void {
  if (!record) { ctx.ui.notify(`${name}: not checked yet.`, "info"); return; }
  ctx.ui.notify([
    `${name}: ${record.score}. ${record.reason}`,
    `Checked ${record.checkedAt} (${record.stage ?? "legacy"}). Not trademark clearance.`,
    ...(record.warnings ?? []),
    ...(record.evidence ?? []).map((source) => `${source.source}: ${source.detail}\n${source.url}`),
    "Refresh only when needed: /brand check refresh",
  ].join("\n"), "info");
}

async function chooseFinalists(ctx: ExtensionContext, initial?: string[]): Promise<boolean> {
  const run = load(ctx);
  if (run.state.liked.length === 0) { ctx.ui.notify("Pick some favorites first with /brand.", "info"); return false; }
  if (!ctx.hasUI) { ctx.ui.notify("Use /brand finalists <name>, <name> to choose up to three favorites.", "info"); return false; }
  const outcome = await pickNames(ctx, [...run.state.liked].reverse(), {
    title: "Choose finalists", selectionOnly: true, maxSelection: 3,
    initialNames: initial && initial.length <= 3 ? initial : run.state.finalists,
  });
  if (!outcome || outcome.kind !== "picked") return false;
  await mutate(ctx, (state) => setFinalists(state, outcome.names));
  ctx.ui.notify(`Finalists: ${outcome.names.join(", ") || "none"}. Favorites are unchanged.`, "info");
  return outcome.names.length > 0;
}

function checkDependencies(ctx: ExtensionToolContext, state: BrandState): CheckDependencies {
  const generic = new Set(["the", "and", "with", "for", "app", "simple", "elegant", "delight", "first", "fast", "rich"]);
  const category = (state.product.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((word) => !generic.has(word)).slice(0, 2).join(" ") || "app";
  return {
    search: async (name, signal) => {
      if (!ctx.tools.some((tool) => tool.name === "web_search")) throw new Error("Enable the web_search extension, then run /brand check refresh.");
      const outcome = await ctx.executeTool("web_search", {
        queries: [`\"${name}\" ${category} app company`, `\"${name}\" software brand company`],
        numResults: 3, includeContent: false, workflow: "none",
      }, { signal });
      if (outcome.isError) throw new Error("Web search failed or was blocked.");
      return extractWebEvidence(outcome.result.content);
    },
    assess: async (prompt, signal) => {
      const response = await requestStructured<{ results: Awaited<ReturnType<CheckDependencies["assess"]>>["results"] }>(ctx, state.model, prompt, ASSESSMENT_SCHEMA, signal);
      return { results: response.value.results, usage: response.usage };
    },
    fetch,
  };
}

async function runCheck(ctx: ExtensionToolContext, stage: "screen" | "deep", refresh = false) {
  const run = load(ctx);
  ctx.ui.setStatus?.("brand", `Checking ${run.state.finalists.length} finalists (${stage}, 45s maximum)...`);
  const result = await checkFinalists(run.state, stage, checkDependencies(ctx, run.state), { refresh, signal: ctx.signal })
    .finally(() => ctx.ui.setStatus?.("brand", undefined));
  await mutate(ctx, (state) => {
    for (const [name, record] of Object.entries(result.records)) {
      if (result.cached.some((entry) => availabilityKey(entry) === name)) continue;
      // Another writer may have completed this name while this operation was awaiting I/O.
      const hit = getAvailability(state, name);
      if (hit && !refresh && hit.stage !== "screen") continue;
      recordAvailability(state, name, record);
    }
  });
  const summary = run.state.finalists.map((name) => {
    const record = result.records[availabilityKey(name)];
    return `${name}: ${record.score} (${record.reason})${result.cached.includes(name) ? " [cached]" : ""}`;
  }).join("\n");
  ctx.ui.notify(`${summary}\nSources: /brand evidence <name>. These findings are not legal clearance.`, "info");
  return textResult(summary, { records: result.records, cached: result.cached }, result.usage);
}

export default function registerPiBrand(pi: ExtensionAPI): void {
  const active = new Set<AbortController>();
  let busy = false;

  async function generateWithProgress(ctx: ExtensionContext, state: BrandState): Promise<Candidate[]> {
    const controller = new AbortController();
    active.add(controller);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    try {
      if (state.reserve.length > 0 || ctx.mode !== "tui") return await takeBatch(state, generationRequest(ctx, state.model), signal);
      const result = await ctx.ui.custom<{ candidates?: Candidate[]; error?: Error }>((tui, theme, _keys, done) => {
        const loader = new BorderedLoader(tui, theme, `Generating a ranked pool with ${state.model} (45s maximum)...`);
        loader.onAbort = () => controller.abort(new Error("Name generation cancelled"));
        takeBatch(state, generationRequest(ctx, state.model), signal).then(
          (candidates) => done({ candidates }),
          (error) => done({ error: error instanceof Error ? error : new Error(String(error)) }),
        );
        return loader;
      });
      if (result.error) throw result.error;
      return result.candidates ?? [];
    } finally { active.delete(controller); }
  }

  async function runRounds(ctx: ExtensionContext, initial?: Candidate[], screenedCtx?: ExtensionToolContext) {
    if (busy) throw new Error("A naming picker is already open. Finish it first.");
    busy = true;
    let usage: Usage | undefined;
    let initialCandidates = initial;
    try {
      while (true) {
        const prepared = await withFileMutationQueue(load(ctx).path, async () => {
          const run = load(ctx);
          if (!run.state.product) throw new Error("Start with /brand <what the product does>.");
          const before = run.state.generationMetrics.at(-1);
          let candidates = initialCandidates ?? await generateWithProgress(ctx, run.state);
          initialCandidates = undefined;
          const metric = run.state.generationMetrics.at(-1);
          if (metric && metric !== before) {
            usage = addUsage(usage, metric.usage);
            pi.appendEntry("brand-generation", metric);
          }
          const excluded = excludedNames(run.state).seen;
          const unique = new Set<string>();
          candidates = candidates.filter((candidate) => {
            const key = availabilityKey(candidate.name);
            if (!key || excluded.has(key) || unique.has(key)) return false;
            unique.add(key); return true;
          });
          if (candidates.length === 0) throw new Error("No fresh candidates in this batch. Try /brand more or /brand pivot <direction>.");
          for (const candidate of candidates) {
            const hit = getAvailability(run.state, candidate.name);
            if (hit) { candidate.score = hit.score; candidate.scoreReason = hit.reason; }
          }
          if (screenedCtx) {
            // Explicit screened mode inspects only three names, not an entire speculative pool.
            run.state.reserve.unshift(...candidates.slice(3));
            candidates = candidates.slice(0, 3);
            ctx.ui.setStatus?.("brand", "Quick-screening three names (45s maximum)...");
            const screen = await checkFinalists({ ...run.state, finalists: candidates.map((candidate) => candidate.name) }, "screen", checkDependencies(screenedCtx, run.state), { signal: ctx.signal })
              .finally(() => ctx.ui.setStatus?.("brand", undefined));
            usage = addUsage(usage, screen.usage);
            for (const candidate of candidates) {
              const record = screen.records[availabilityKey(candidate.name)];
              if (!screen.cached.some((name) => availabilityKey(name) === availabilityKey(candidate.name))) recordAvailability(run.state, candidate.name, record);
              candidate.score = record.score; candidate.scoreReason = record.reason;
            }
          }
          const round = recordRound(run.state, { product: run.state.product, candidates });
          saveBrandState(run.path, run.state);
          return { run, round, candidates, excluded };
        });
        const { run, round, candidates, excluded } = prepared;
        if (!ctx.hasUI) {
          return textResult(`Saved candidates: ${candidates.map((candidate) => candidate.name).join(", ")}. Use /brand keep <names> to save favorites.`, { roundId: round.id, picked: [] as string[] }, usage);
        }
        const outcome = await pickNames(ctx, candidates, {
          title: screenedCtx ? "Quick-screened names (3 at a time)" : "Pick favorites",
          product: run.state.product, direction: run.state.brief.direction,
          likedSoFar: run.state.liked.map((entry) => entry.name), excludedTotal: excluded.size + candidates.length,
        });
        if (!outcome) {
          await mutate(ctx, (state) => {
            state.rounds = state.rounds.filter((entry) => entry.id !== round.id);
            state.reserve = [...candidates, ...state.reserve].slice(0, 24);
          });
          return textResult("Picker cancelled; batch returned to the reserve.", { roundId: undefined, picked: [] as string[] }, usage);
        }
        if (outcome.kind === "rejected") {
          await mutate(ctx, (state) => {
            dismissNames(state, outcome.names);
            if (outcome.comment.trim()) setDirection(state, outcome.comment);
          });
          ctx.ui.notify("Round rejected. /brand more continues; /brand pivot <note> changes direction.", "info");
          return textResult("Round rejected; direction saved.", { roundId: round.id, picked: [] as string[] }, usage);
        }
        const picked = await mutate(ctx, (state) => {
          const added = addLikes(state, round, candidates.filter((candidate) => outcome.names.includes(candidate.name)));
          if (outcome.kind === "action" && outcome.note) setDirection(state, outcome.note);
          return added;
        });
        if (outcome.kind === "action" && outcome.action !== "check") continue;
        if (outcome.kind === "action") {
          if (await chooseFinalists(ctx, outcome.names)) {
            if (screenedCtx) {
              const checked = await runCheck(screenedCtx, "deep");
              usage = addUsage(usage, checked.usage);
            } else pi.sendUserMessage(buildAvailabilityPrompt(load(ctx).state), { deliverAs: "followUp" });
          }
        } else ctx.ui.notify(`Favorites saved: ${picked.join(", ") || "none new"}. /brand more · /brand finalists · /brand check`, "info");
        return textResult(`Saved favorites: ${picked.join(", ") || "none new"}.`, { roundId: round.id, picked }, usage);
      }
    } finally { busy = false; }
  }

  pi.registerTool({
    name: "brand_generate", label: "Generate names", executionMode: "sequential",
    description: "Run bounded isolated naming and the picker for the saved brief. Optional screened mode checks three names before display, only when the user explicitly requests it.",
    parameters: Type.Object({ product: Type.Optional(Type.String({ maxLength: 1000 })), direction: Type.Optional(Type.String({ maxLength: 1000 })), screened: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.product?.trim() || params.direction?.trim()) await mutate(ctx, (state) => {
        if (params.product?.trim()) { if (state.product !== params.product.trim()) state.reserve = []; state.product = params.product.trim(); }
        if (params.direction?.trim()) setDirection(state, params.direction);
      });
      return runRounds(ctx, undefined, params.screened ? ctx : undefined);
    },
  });
  pi.registerTool({
    name: "brand_check", label: "Check finalists", executionMode: "sequential",
    description: "Own one bounded availability operation for the saved 1-3 finalists. Cache, parallel search, evidence, optional registry checks and persistence are handled here. Refresh only on explicit user request.",
    parameters: CHECK_OPTIONS,
    async execute(_id, params, _signal, _update, ctx) { return runCheck(ctx, params.stage ?? "deep", params.refresh); },
  });
  pi.registerTool({
    name: "brand_pick", label: "Pick names", executionMode: "sequential",
    description: "Compatibility picker for externally generated names. Prefer brand_generate, which owns bounded generation and deduplication.",
    parameters: Type.Object({ candidates: Type.Array(CANDIDATE_SCHEMA, { maxItems: 30 }), product: Type.Optional(Type.String()), directionHint: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.product?.trim()) await mutate(ctx, (state) => { if (state.product !== params.product!.trim()) state.reserve = []; state.product = params.product!.trim(); });
      return runRounds(ctx, params.candidates.map((candidate) => ({ ...candidate, name: candidate.name.trim() })));
    },
  });
  pi.registerTool({
    name: "brand_score", label: "Availability cache", executionMode: "sequential",
    description: "Lookup cached availability in a batch using names, or a single name. Legacy signal recording remains supported; missing signals stay unknown. Prefer brand_check for evidence-backed research.",
    parameters: Type.Object({ name: Type.Optional(Type.String()), names: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })), ...SIGNALS_SCHEMA, force: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const names = params.names ?? (params.name ? [params.name] : []);
      if (names.length === 0) throw new Error("Provide name or names.");
      const hasSignals = Object.keys(SIGNALS_SCHEMA).some((key) => params[key as keyof typeof params] !== undefined);
      if (!hasSignals) {
        const result = getAvailabilityBatch(load(ctx).state, names);
        return textResult(JSON.stringify(result), result, undefined, false);
      }
      if (!params.name || params.names) throw new Error("Signal recording requires a single name.");
      const name = params.name;
      const record = await mutate(ctx, (state) => {
        const cached = getAvailability(state, name);
        if (cached && !params.force) return cached;
        const signals: Partial<CollisionSignals> = {};
        for (const key of Object.keys(SIGNALS_SCHEMA) as (keyof CollisionSignals)[]) {
          const value = params[key];
          if (value !== undefined) Object.assign(signals, { [key]: value });
        }
        const verdict = scoreFromSignals(signals);
        return recordAvailability(state, name, { ...verdict, signals, stage: "legacy", warnings: ["Legacy signal-only result; no retained sources. Not legal clearance."] });
      });
      return textResult(`${name}: ${record.score}. ${record.reason}`, { name, ...record }, undefined, false);
    },
  });
  pi.registerTool({
    name: "brand_seen", label: "Seen names", description: "Cheap local batch duplicate check. The naming engine already performs this automatically.",
    parameters: Type.Object({ names: Type.Array(Type.String(), { maxItems: 100 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      const seen = excludedNames(load(ctx).state).seen;
      const names = [...new Set(params.names.map(availabilityKey))];
      const open = names.filter((name) => !seen.has(name));
      const result = { open, blocked: names.length - open.length, seenTotal: seen.size };
      return textResult(JSON.stringify(result), result, undefined, false);
    },
  });

  pi.registerCommand("brand", {
    description: "Name a product using a compact isolated engine. more / pivot / finalists / check / brief / stats",
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();
        const [head = "", ...rest] = args.trim().split(/\s+/);
        const tail = rest.join(" ").trim();
        const command = head.toLowerCase();
        if (busy && !["help", "likes", "liked", "status", "stats", "brief", "evidence", "excluded"].includes(command)) throw new Error("Finish the open naming picker before changing this run.");
        const run = load(ctx);
        if (command === "help") { ctx.ui.notify(HELP, "info"); return; }
        if (command === "likes" || command === "liked" || command === "status") {
          ctx.ui.notify(`Favorites (${run.state.liked.length}): ${run.state.liked.map((entry) => `${entry.name}${entry.score ? ` (${entry.score})` : ""}`).join(", ") || "none"}\nFinalists: ${run.state.finalists.join(", ") || "none"}`, "info"); return;
        }
        if (command === "stats") {
          const metrics = run.state.generationMetrics;
          const usage = metrics.reduce<Usage | undefined>((sum, metric) => addUsage(sum, metric.usage), undefined);
          ctx.ui.notify(`Run: ${run.path}\nLast ${metrics.length} generated pools (up to 50 retained): ${metrics.reduce((sum, metric) => sum + metric.modelCalls, 0)} model calls, ${metrics.reduce((sum, metric) => sum + metric.generated, 0)} candidates.\nReserve: ${run.state.reserve.length}. Model: ${run.state.model}.\nReported tokens: ${usage?.input ?? 0} uncached input, ${usage?.cacheRead ?? 0} cache reads, ${usage?.output ?? 0} output. Cost: $${(usage?.cost.total ?? 0).toFixed(4)}.\nLast generation: ${metrics.at(-1)?.elapsedMs ?? 0}ms.`, "info"); return;
        }
        if (command === "brief") { ctx.ui.notify(JSON.stringify({ product: run.state.product, model: run.state.model, ...run.state.brief }, null, 2), "info"); return; }
        if (command === "model") {
          if (!/^[^/]+\/.+$/.test(tail)) throw new Error("Usage: /brand model <provider/model-id>");
          await mutate(ctx, (state) => { state.model = tail; state.reserve = []; }); ctx.ui.notify(`Naming model: ${tail}. Main model unchanged.`, "info"); return;
        }
        if (command === "words" || command === "length" || command === "domains" || command === "packages") {
          await mutate(ctx, (state) => {
            if (command === "words") { if (tail !== "single" && tail !== "multiple") throw new Error("Usage: /brand words single|multiple"); state.brief.singleWord = tail === "single"; state.reserve = []; }
            if (command === "length") { const length = Number(tail); if (!Number.isInteger(length) || length < 3 || length > 30) throw new Error("Length must be 3-30 characters."); state.brief.maxLength = length; state.reserve = []; }
            if (command === "domains") { const domains = tail.split(/[\s,]+/).map((suffix) => suffix.replace(/^\./, "").toLowerCase()); if (!domains.length || domains.length > 3 || domains.some((suffix) => !/^[a-z]{2,12}$/.test(suffix))) throw new Error("Choose 1-3 suffixes, e.g. /brand domains com app"); state.brief.domains = [...new Set(domains)]; }
            if (command === "packages") { if (tail !== "on" && tail !== "off") throw new Error("Usage: /brand packages on|off"); state.brief.checkPackages = tail === "on"; }
          }); ctx.ui.notify("Brief updated. Existing checks are retained; use /brand check refresh to update them.", "info"); return;
        }
        if (command === "note" || command === "pivot") {
          await mutate(ctx, (state) => setDirection(state, tail));
          if (command === "note") { ctx.ui.notify("Direction updated; old notes remain archived.", "info"); return; }
          await runRounds(ctx); return;
        }
        if (command === "finalists") {
          if (!tail) await chooseFinalists(ctx);
          else { await mutate(ctx, (state) => setFinalists(state, namesFrom(tail, state))); ctx.ui.notify(`Finalists: ${load(ctx).state.finalists.join(", ")}.`, "info"); }
          return;
        }
        if (command === "evidence" || (command === "check" && tail && tail !== "refresh")) { showRecord(ctx, tail, getAvailability(run.state, tail)); return; }
        if (command === "check" || command === "screen") {
          if (tail && tail !== "refresh") throw new Error("Usage: /brand screen [refresh]");
          if (run.state.finalists.length === 0 && !await chooseFinalists(ctx)) return;
          pi.sendUserMessage(buildAvailabilityPrompt(load(ctx).state, command === "screen" ? "screen" : "deep", tail === "refresh")); return;
        }
        if (command === "screened") {
          if (!run.state.product) throw new Error("Start with /brand <product> first.");
          pi.sendUserMessage("Call brand_generate once with screened true. I explicitly want three names quick-screened before display. The tool owns the workflow; do no independent research."); return;
        }
        if (command === "keep") {
          const names = namesFrom(tail, run.state);
          if (names.length === 0) throw new Error("Usage: /brand keep <name>, <name>");
          await mutate(ctx, (state) => {
            const candidates = state.rounds.flatMap((round) => round.candidates);
            const picked = names.map((name) => candidates.find((entry) => availabilityKey(entry.name) === availabilityKey(name)));
            if (picked.some((candidate) => !candidate)) throw new Error("Keep names from a saved candidate batch.");
            addLikes(state, undefined, picked as Candidate[]);
          }); ctx.ui.notify("Favorites saved.", "info"); return;
        }
        if (command === "dismiss" || command === "drop") {
          if (!tail) throw new Error("Usage: /brand dismiss <name>, <name>");
          await mutate(ctx, (state) => {
            const names = namesFrom(tail, state);
            dismissNames(state, names);
            const keys = new Set(names.map(availabilityKey));
            state.finalists = state.finalists.filter((name) => !keys.has(availabilityKey(name)));
          }); ctx.ui.notify("Names dismissed. Their taste/history and cached checks are retained.", "info"); return;
        }
        if (command === "excluded") { ctx.ui.notify(`${excludedNames(run.state).seen.size} excluded names.`, "info"); return; }
        if (command === "clear") {
          if (!ctx.hasUI || !await ctx.ui.confirm("Clear this naming run?", "Deletes rounds, favorites, finalists, reserve and cached checks. Other runs and the migration backup are unchanged.")) return;
          await mutate(ctx, (state) => { const blank = emptyBrandState(state.product); blank.model = state.model; blank.brief = state.brief; Object.assign(state, blank); }); ctx.ui.notify("Run cleared.", "info"); return;
        }
        if (!["more", "again", "next"].includes(command) && args.trim()) {
          await mutate(ctx, (state) => { const product = args.trim().slice(0, 1000); if (state.product !== product) state.reserve = []; state.product = product; });
        }
        if (!load(ctx).state.product) {
          if (!ctx.hasUI) throw new Error("Usage: /brand <what the product does>");
          const product = await ctx.ui.input("What does the product do?");
          if (!product?.trim()) return;
          await mutate(ctx, (state) => { state.product = product.trim().slice(0, 1000); });
        }
        const result = await runRounds(ctx);
        if (!ctx.hasUI) ctx.ui.notify(result.content[0].text, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.on("session_shutdown", () => { for (const controller of active) controller.abort(new Error("Session closed")); });
}

const HELP = [
  "/brand <product>  isolated naming + favorites picker",
  "/brand more  next reserve batch, or a new bounded pool",
  "/brand pivot <note>  update direction and generate",
  "/brand note <note>  update direction without generating",
  "/brand likes  favorites and finalists",
  "/brand finalists [names separated by commas]  choose up to three",
  "/brand check [refresh]  deeper checks of finalists, cache first",
  "/brand screen [refresh]  quick web screen of finalists",
  "/brand screened  opt in to screening three names before display",
  "/brand evidence <name>  retained findings and sources",
  "/brand model <provider/id>  naming model only",
  "/brand brief · words single|multiple · length <3-30> · domains <suffixes> · packages on|off",
  "/brand stats · keep <names> · dismiss <names> · excluded · clear · help",
].join("\n");
