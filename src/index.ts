import fs from "node:fs";
import { Type, type Usage } from "@earendil-works/pi-ai";
import { BorderedLoader, withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { ASSESSMENT_SCHEMA, buildCollisionSearchQueries, checkFinalists, isCheckStale, readSearchEvidence, shouldRefreshUnknown, type CheckDependencies } from "./checker.ts";
import { recordExternalPool, takeBatch } from "./engine.ts";
import { applyBriefChanges, contentKey, feedbackSummary, formatBrief, namingContent, parseBrief } from "./brief.ts";
import { BRIEF_CHANGES, prepareFeedback } from "./feedback.ts";
import { addUsage } from "./generation.ts";
import { generationRequest, requestStructured } from "./model.ts";
import { pickNames } from "./picker.ts";
import { selectBrandModels, validateBrandModel } from "./model-settings.ts";
import { generationStats } from "./overview.ts";
import { chooseWorkspaceAction, roundDetails } from "./workspace.ts";
import type { WorkspacePosition } from "./workspace-ui.ts";
import { selectBrandOption } from "./selection.ts";
import { formatShortlist } from "./shortlist.ts";
import { buildAvailabilityPrompt } from "./prompt.ts";
import { formatScore, needsCheck, scoreFromSignals, type CollisionSignals } from "./scoring.ts";
import { brandDocumentPaths, saveFeedbackDocument, saveShortlistDocument, addLikes, availabilityKey, dismissNames, excludedNames, getAvailability, getAvailabilityBatch, loadBrandState, activeNames, removeLikes, selectNames, recordAvailability, recordRound, saveBrandState, setFinalists } from "./store.ts";
import { type AvailabilityRecord, type BrandState, type Candidate, type FeedbackEntry, type NamingContent } from "./types.ts";

const CANDIDATE_SCHEMA = Type.Object({ name: Type.String({ maxLength: 60 }), flavor: Type.Optional(Type.String({ maxLength: 120 })), style: Type.Optional(Type.String({ maxLength: 60 })) });
const SIGNALS_SCHEMA = {
  famousCollision: Type.Optional(Type.Boolean()), sameSpaceCollision: Type.Optional(Type.Boolean()),
  giantAssociation: Type.Optional(Type.Boolean()), unrelatedCount: Type.Optional(Type.Integer({ minimum: 0 })), comParked: Type.Optional(Type.Boolean()),
};
const CHECK_OPTIONS = Type.Object({
  stage: Type.Optional(Type.Union([Type.Literal("screen"), Type.Literal("deep")])),
  refresh: Type.Optional(Type.Boolean()),
  names: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { minItems: 1, maxItems: 1000 })),
  batch: Type.Optional(Type.Boolean()),
  uncheckedOnly: Type.Optional(Type.Boolean()),
  allFavorites: Type.Optional(Type.Boolean()),
});

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

async function updateFeedback(ctx: ExtensionContext, text: string, source: FeedbackEntry["source"], changes?: Partial<NamingContent>, author: FeedbackEntry["author"] = "user") {
  let prepared;
  try { prepared = await prepareFeedback(ctx, load(ctx).state, text, changes); }
  catch (error) {
    if (text.trim() && text.length <= 6000) await mutate(ctx, state => {
      const entry = applyBriefChanges(state, {}, { text, source, author });
      entry.error = error instanceof Error ? error.message : String(error);
    });
    throw error;
  }
  const entry = await mutate(ctx, (state) => {
    if (contentKey(namingContent(state)) !== prepared.beforeKey) throw new Error("The brief changed while feedback was being interpreted. Please retry against the updated brief.");
    return applyBriefChanges(state, prepared.changes, { text, source, author });
  });
  ctx.ui.notify(feedbackSummary(entry), "info");
  return { entry, usage: prepared.usage };
}

function namesFrom(text: string, state: BrandState): string[] {
  const whole = [...state.liked, ...state.rounds.flatMap((round) => round.candidates)].find((entry) => availabilityKey(entry.name) === availabilityKey(text));
  return whole ? [whole.name] : text.split(text.includes(",") ? /\s*,\s*/ : /\s+/).map((name) => name.trim()).filter(Boolean);
}

function showRecord(ctx: ExtensionContext, name: string, record?: AvailabilityRecord): void {
  if (!record) { ctx.ui.notify(`${name}: not checked yet.`, "info"); return; }
  ctx.ui.notify([
    `${name}: ${formatScore(record.score)}. ${record.reason}`,
    `Checked ${record.checkedAt} (${record.stage ?? "legacy"}). Not trademark clearance.`,
    ...(record.warnings ?? []),
    ...(record.evidence ?? []).map((source) => `${source.source}: ${source.detail}\n${source.url}`),
    "Refresh this result from Review favorites → Details.",
  ].join("\n"), "info");
}

function updateBrief(state: BrandState, command: string, tail: string): void {
  if (command === "words") {
    if (tail !== "single" && tail !== "multiple") throw new Error("Usage: /brand words single|multiple");
    applyBriefChanges(state, { singleWord: tail === "single" }, { text: `words ${tail}`, source: "command", author: "user" });
  }
  if (command === "length") applyBriefChanges(state, { maxLength: Number(tail) }, { text: `length ${tail}`, source: "command", author: "user" });
  if (command === "domains") { const domains = tail.split(/[\s,]+/).map((suffix) => suffix.replace(/^\./, "").toLowerCase()); if (!domains.length || domains.length > 3 || domains.some((suffix) => !/^[a-z]{2,12}$/.test(suffix))) throw new Error("Choose 1-3 suffixes, e.g. /brand domains com app"); state.brief.domains = [...new Set(domains)]; }
  if (command === "packages") { if (tail !== "on" && tail !== "off") throw new Error("Usage: /brand packages on|off"); state.brief.checkPackages = tail === "on"; }
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

/** pi exposes `tools` and `executeTool` as non-enumerable, so a spread would silently drop them. */
function withToolSignal(ctx: ExtensionToolContext, signal: AbortSignal | undefined): ExtensionToolContext {
  return Object.assign(Object.create(ctx), { signal: signal ?? ctx.signal }) as ExtensionToolContext;
}

function checkDependencies(ctx: ExtensionToolContext, state: BrandState): CheckDependencies {
  return {
    search: async (name, signal) => {
      if (!ctx.tools.some((tool) => tool.name === "web_search")) throw new Error("Enable the web_search extension, then run /brand check refresh.");
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        try {
          const queries = buildCollisionSearchQueries(name, state.product);
          const outcome = await ctx.executeTool("web_search", {
            queries,
            numResults: 3, includeContent: false, workflow: "none",
          }, { signal });
          if (outcome.isError) throw new Error("Web search failed or was blocked.");
          return readSearchEvidence(outcome.result, queries.length);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          lastError = error;
        }
        if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      throw lastError instanceof Error ? lastError : new Error("Web search failed or was blocked.");
    },
    assess: async (prompt, signal) => {
      const response = await requestStructured<{ results: Awaited<ReturnType<CheckDependencies["assess"]>>["results"] }>(ctx, state.workerModel ?? state.model, prompt, ASSESSMENT_SCHEMA, signal, "worker");
      return { results: response.value.results, usage: response.usage };
    },
    fetch,
  };
}

async function runCheck(ctx: ExtensionToolContext, stage: "screen" | "deep", refresh = false, names?: string[], allFavorites = false, options: { batch?: boolean; uncheckedOnly?: boolean } = {}) {
  const run = load(ctx);
  let targets: string[];
  if (allFavorites) {
    if (names !== undefined) throw new Error("Choose either specific names or all favorites, not both.");
    targets = [...new Map(run.state.liked.map((entry) => [availabilityKey(entry.name), entry.name])).values()];
  } else if (names !== undefined) {
    const saved = new Map([...run.state.rounds.flatMap(round => round.candidates), ...activeNames(run.state), ...run.state.liked].map(entry => [availabilityKey(entry.name), entry.name]));
    targets = [...new Set(names.map(name => saved.get(availabilityKey(name))).filter((name): name is string => !!name))];
    if (targets.length !== new Set(names.map(availabilityKey)).size) throw new Error("Checks can only target saved names.");
  } else targets = run.state.finalists.length ? run.state.finalists : run.state.liked.map((entry) => entry.name);
  if (targets.length === 0) throw new Error("Save some names first.");
  if (!allFavorites && !options.batch && targets.length > 3) throw new Error("Choose up to three names, or explicitly request batch true.");
  if (options.uncheckedOnly && !refresh) {
    const known = new Map([...run.state.rounds.flatMap(round => round.candidates), ...run.state.liked].map(entry => [availabilityKey(entry.name), entry]));
    targets = targets.filter(name => {
      const score = getAvailability(run.state, name)?.score ?? known.get(availabilityKey(name))?.score;
      return needsCheck(score) || isCheckStale(getAvailability(run.state, name), run.state);
    });
  }
  if (!targets.length) return textResult("No pending checks. Existing findings are saved; use refresh to explicitly recheck them.", { records: {}, cached: [] }, undefined, false);

  const records: Record<string, AvailabilityRecord> = Object.create(null);
  const cached: string[] = [];
  const errors: Record<string, string> = Object.create(null);
  let usage: Usage | undefined;
  const batchCount = Math.ceil(targets.length / 3);
  try {
    for (let offset = 0; offset < targets.length; offset += 3) {
      const batch = targets.slice(offset, offset + 3);
      const checkState = { ...run.state, finalists: batch };
      ctx.ui.setStatus?.("brand", `Checking names ${offset + 1}-${offset + batch.length} of ${targets.length} (${stage}, batch ${Math.floor(offset / 3) + 1}/${batchCount})...`);
      const result = await checkFinalists(checkState, stage, checkDependencies(ctx, checkState), { refresh, signal: ctx.signal });
      for (const [name, record] of Object.entries(result.records)) if (record.score === "error") errors[name] = record.reason;
      await mutate(ctx, (state) => {
        for (const [name, record] of Object.entries(result.records)) {
          if (result.cached.some((entry) => availabilityKey(entry) === name)) continue;
          // Another writer may have completed this name while this operation was awaiting I/O.
          const hit = getAvailability(state, name);
          // Failed research must not erase a useful earlier finding or make its timestamp look fresh.
          if (hit && !needsCheck(hit.score) && record.score === "error") {
            const retained = { ...hit, warnings: [...(hit.warnings ?? []).filter(warning => !warning.startsWith("Refresh failed:")), `Refresh failed: ${record.reason} Previous assessment retained.`] };
            recordAvailability(state, name, retained);
            result.records[name] = retained;
            continue;
          }
          if (hit && !refresh && hit.stage !== "screen" && !shouldRefreshUnknown(hit, stage) && !isCheckStale(hit, state)) {
            result.records[name] = hit;
            continue;
          }
          recordAvailability(state, name, record);
        }
      });
      Object.assign(records, result.records);
      cached.push(...result.cached);
      usage = addUsage(usage, result.usage);
    }
  } finally { ctx.ui.setStatus?.("brand", undefined); }
  const summaries = targets.map((name) => {
    const record = records[availabilityKey(name)];
    const isCached = cached.some((entry) => availabilityKey(entry) === availabilityKey(name));
    const diagnostics = record.warnings?.length
      ? `; ${record.warnings.slice(0, 2).map((warning) => warning.replace(/\s+/g, " ").slice(0, 180)).join("; ")}`
      : "";
    return `${name}: ${formatScore(record.score)} (${record.reason}${diagnostics})${isCached ? " [cached]" : ""}`;
  });
  const failed = Object.keys(errors).length;
  const review = targets.filter(name => !errors[availabilityKey(name)] && records[availabilityKey(name)].score === "review").length;
  const noun = allFavorites ? (targets.length === 1 ? "favorite" : "favorites") : (targets.length === 1 ? "name" : "names");
  const completion = `Check finished: ${targets.length} ${noun}; ${targets.length - failed - review} assessed, ${review} need review, ${failed} failed (${stage}; ${cached.length} cached).`;
  const summary = `${completion}\n${summaries.slice(0, 10).join("\n")}${summaries.length > 10 ? `\n… and ${summaries.length - 10} more. Reopen the workspace to see every status.` : ""}`;
  ctx.ui.notify(`${summary}\nSources: /brand evidence <name>. These findings are not legal clearance.`, failed ? "error" : "info");
  return { ...textResult(summary, { records, cached, errors }, usage, false), ...(failed ? { isError: true } : {}) };
}

export default function registerPiBrand(pi: ExtensionAPI): void {
  const active = new Set<AbortController>();
  let busy = false;
  let resumeWorkspace: { sessionId: string; position: WorkspacePosition } | undefined;

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

  async function openModelSettings(ctx: ExtensionContext) {
    const selected = await selectBrandModels(ctx, load(ctx).state);
    if (!selected) return;
    await mutate(ctx, (state) => {
      if (state.model !== selected.model) { state.reserve = []; state.reservePoolId = undefined; }
      state.model = selected.model;
      state.workerModel = selected.workerModel;
    });
    ctx.ui.notify("Brand models saved. Main model unchanged; cached checks retained.", "info");
  }

  async function runWorkspace(ctx: ExtensionContext, initial?: Candidate[], screenedCtx?: ExtensionToolContext, overviewFirst = false, resumePosition?: WorkspacePosition) {
    if (busy) throw new Error("A naming workspace is already open. Finish it first.");
    busy = true;
    let usage: Usage | undefined;
    let overview = overviewFirst;
    let favoritesFirst = false;
    let supplied = initial;
    const position: WorkspacePosition = resumePosition ?? { tab: "names", cursor: 0 };
    const workspacePicks = new Set<string>();
    const checkCtx = screenedCtx ?? ("executeTool" in ctx ? ctx as ExtensionToolContext : undefined);
    try {
      while (true) {
        if (overview) {
          const run = load(ctx);
          const action = await chooseWorkspaceAction(ctx, run.state, run.path, favoritesFirst, position);
          favoritesFirst = false;
          const favoriteChanges = action?.favoriteChanges ?? [];
          if (favoriteChanges.length) await mutate(ctx, state => {
            for (const change of favoriteChanges) {
              if (!change.liked) {
                removeLikes(state, [change.name]);
                workspacePicks.delete(change.name);
              } else {
                const round = state.rounds.find(entry => entry.id === change.roundId);
                const candidates = round?.candidates ?? activeNames(state);
                const picked = candidates.filter(entry => availabilityKey(entry.name) === availabilityKey(change.name));
                if (picked.length) {
                  addLikes(state, round, picked);
                  workspacePicks.add(change.name);
                }
              }
            }
          });
          if (!action || action.kind === "close") return textResult("Naming workspace closed. Favorite changes saved.", { picked: [...workspacePicks] }, usage);
          if (action.kind === "stay") continue;
          try {
            if (action.kind === "export") {
              const current = load(ctx);
              const path = saveShortlistDocument(current.path, formatShortlist(current.state));
              position.notice = `Shortlist exported: ${path}`;
              ctx.ui.notify(`Shortlist saved, with findings and sources: ${path}`, "info");
              continue;
            }
            if (action.kind === "add") {
              const name = (await ctx.ui.input("Add a name", "Name only, up to 60 characters"))?.trim();
              if (!name) continue;
              if (name.length > 60 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error("Use a single-line name of up to 60 characters, without control characters.");
              await mutate(ctx, state => selectNames(state, [name]));
              position.tab = "names";
              position.roundId = undefined;
              position.query = "";
              position.marked = [];
              position.focusName = name;
              continue;
            }
            if (action.kind === "check") {
              if (checkCtx) {
                const result = await runCheck(checkCtx, action.stage, action.refresh, action.names, action.allFavorites, action);
                usage = addUsage(usage, result.usage);
                position.notice = result.content[0].text.split("\n")[0];
                continue;
              }
              pi.sendUserMessage(buildAvailabilityPrompt(load(ctx).state, action.stage, action.refresh, action.names, action.allFavorites, action), { deliverAs: "followUp" });
              if (ctx.mode === "tui") resumeWorkspace = { sessionId: ctx.sessionManager.getSessionId(), position };
              return textResult("Checking saved names.", { picked: [...workspacePicks] }, usage);
            }
            if (action.kind === "feedback" || action.kind === "similar") {
              const text = action.kind === "similar" ? 'More like "' + action.name + '" in meaning and feel. Keep unrelated instructions.' : await ctx.ui.editor("What should change? Unrelated brief sections will be kept.", "");
              if (!text?.trim()) continue;
              const result = await updateFeedback(ctx, text, action.kind === "similar" ? "similar" : "picker");
              usage = addUsage(usage, result.usage);
              if (ctx.mode === "tui") continue;
              overview = false;
            } else if (action.kind === "brief") {
              const changes = parseBrief(action.markdown);
              const entry = await mutate(ctx, state => {
                if (contentKey(namingContent(state)) !== contentKey(namingContent(run.state))) throw new Error("Brief changed while the editor was open. Reopen it before saving.");
                return applyBriefChanges(state, changes, { text: action.markdown, source: "brief-editor", author: "user" });
              });
              ctx.ui.notify(feedbackSummary(entry), "info");
              continue;
            } else if (action.kind === "feedback-document") {
              await withFileMutationQueue(run.path, async () => saveFeedbackDocument(run.path, action.markdown, action.original));
              ctx.ui.notify("Feedback annotations saved. Active brief unchanged.", "info");
              continue;
            } else if (action.kind === "models") { await openModelSettings(ctx); continue; }
            else if (action.kind === "setting") { await mutate(ctx, state => updateBrief(state, action.field, action.value)); continue; }
            else if (action.kind === "discard") {
              if (await ctx.ui.confirm(`Discard ${action.names.length} ${action.names.length === 1 ? "name" : "names"}?`, `${action.names.slice(0, 8).join(", ")}${action.names.length > 8 ? ", …" : ""}\nRemoves active selections and favorites. Saved rounds and evidence remain in History.`)) {
                await mutate(ctx, state => dismissNames(state, action.names));
                for (const name of action.names) workspacePicks.delete(name);
              }
              continue;
            } else if (action.kind === "select") { await mutate(ctx, state => selectNames(state, action.names)); continue; }
            else if (action.kind === "dismiss") {
              if (await ctx.ui.confirm('Remove ' + action.name + '?', "Removes the favorite and prevents future suggestions. Saved round history stays intact.")) await mutate(ctx, state => dismissNames(state, [action.name]));
              favoritesFirst = true;
              continue;
            } else if (action.kind === "evidence") { showRecord(ctx, action.name, getAvailability(run.state, action.name)); favoritesFirst = true; continue; }
            else if (action.kind === "keep") {
              await mutate(ctx, state => {
                const round = state.rounds.find(entry => entry.id === action.roundId);
                if (round) addLikes(state, round, round.candidates.filter(entry => action.names.includes(entry.name)));
              });
              continue;
            } else overview = false;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (action.kind === "check") position.notice = `Check stopped: ${message}`;
            ctx.ui.notify(message, "error");
            continue;
          }
        }
        const prepared = await withFileMutationQueue(load(ctx).path, async () => {
          const run = load(ctx);
          if (!run.state.product) throw new Error("Start with /brand <what the product does>.");
          const previousMetric = run.state.generationMetrics.at(-1);
          let candidates: Candidate[];
          if (supplied) {
            candidates = supplied;
            supplied = undefined;
            recordExternalPool(run.state, candidates);
          } else candidates = await generateWithProgress(ctx, run.state);
          const metric = run.state.generationMetrics.at(-1);
          if (metric && metric !== previousMetric) { usage = addUsage(usage, metric.usage); pi.appendEntry("brand-generation", metric); }
          const seen = excludedNames(run.state).seen;
          const unique = new Set<string>();
          candidates = candidates.filter(entry => {
            const key = availabilityKey(entry.name);
            if (!key || seen.has(key) || unique.has(key)) return false;
            unique.add(key); return true;
          });
          if (!candidates.length) throw new Error("No fresh names in this pool. Give feedback to explore a different route.");
          if (screenedCtx) {
            run.state.reserve.unshift(...candidates.slice(3));
            run.state.reservePoolId = run.state.lastBatch?.poolId;
            candidates = candidates.slice(0, 3);
            const checked = await checkFinalists({ ...run.state, finalists: candidates.map(entry => entry.name) }, "screen", checkDependencies(screenedCtx, run.state), { signal: ctx.signal });
            usage = addUsage(usage, checked.usage);
            for (const [name, record] of Object.entries(checked.records)) if (!checked.cached.some(entry => availabilityKey(entry) === name)) recordAvailability(run.state, name, record);
          }
          candidates = candidates.map(entry => {
            const record = getAvailability(run.state, entry.name);
            return record ? { ...entry, score: record.score, scoreReason: record.reason } : entry;
          });
          const round = recordRound(run.state, { product: run.state.product, candidates, ...run.state.lastBatch, briefRevision: run.state.briefRevision });
          saveBrandState(run.path, run.state);
          return { run, round, candidates };
        });
        const { run, round, candidates } = prepared;
        if (ctx.mode === "tui" && ctx.hasUI) {
          position.tab = "names";
          position.cursor = 0;
          position.roundId = undefined;
          position.query = "";
          position.marked = [];
          overview = true;
          continue;
        }
        const origin = round.origin === "reserve" ? "Remaining names from the previous pool; no new generation." : round.origin === "external" ? "Externally supplied names; original generation prompt unknown." : 'Generated from brief r' + round.briefRevision + '.';
        if (!ctx.hasUI) return textResult(origin + "\n" + candidates.map(entry => entry.name).join(", ") + "\nUse /brand keep <names> to save favorites; /brand round inspects the inputs.", { roundId: round.id, picked: [] as string[] }, usage);
        const outcome = await pickNames(ctx, candidates, { title: "Pick favorites", origin, context: 'Explore: ' + (run.state.brief.direction || "Open exploration") });
        const picked = await mutate(ctx, state => addLikes(state, round, candidates.filter(entry => outcome?.names.includes(entry.name))));
        if (!outcome || outcome.kind === "picked") {
          ctx.ui.notify(`Favorites saved: ${picked.join(", ") || "none new"}. /brand resumes; viewed names remain in History.`, "info");
          return textResult('Saved favorites: ' + (picked.join(", ") || "none new") + '. Unselected names are only marked seen, not disliked.', { roundId: round.id, picked }, usage);
        }
        overview = outcome.action !== "more";
        if (outcome.action === "feedback") {
          const text = await ctx.ui.editor("What should change? Unrelated brief sections will be kept.", "");
          if (text?.trim()) {
            try { const result = await updateFeedback(ctx, text, "picker"); usage = addUsage(usage, result.usage); overview = false; }
            catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
          }
        }
        if (outcome.action === "favorites") favoritesFirst = true;
        if (outcome.action === "details") {
          const action = await selectBrandOption(ctx, "Batch details", ["Read generation inputs", "More like a name", "Back"]);
          if (action === "Read generation inputs") await ctx.ui.editor("Saved inputs · read only", roundDetails(load(ctx).state, round.id));
          if (action === "More like a name") {
            const name = await selectBrandOption(ctx, "Use a name as a reference (does not favorite it)", candidates.map(entry => entry.name));
            if (name) {
              try { const result = await updateFeedback(ctx, 'More like "' + name + '" in meaning and feel. Keep unrelated instructions.', "similar"); usage = addUsage(usage, result.usage); overview = false; }
              catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
            }
          }
        }
      }
    } finally { busy = false; }
  }

  pi.registerCommand("brand-settings", {
    description: "Choose creative and worker models for this project's naming run",
    handler: async (_args, ctx) => {
      try { await ctx.waitForIdle(); if (busy) throw new Error("Finish the open naming workspace first."); await openModelSettings(ctx); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });

  pi.registerTool({
    name: "brand_generate", label: "Generate names", executionMode: "sequential",
    description: "Generate and pick names from the canonical saved brief. Usually call without arguments. Save user feedback through brand_feedback first, not as a replacement direction. Optional screened mode checks three names before display, only when explicitly requested.",
    parameters: Type.Object({ product: Type.Optional(Type.String({ maxLength: 6000 })), direction: Type.Optional(Type.String({ maxLength: 6000 })), screened: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.product?.trim() && params.product.trim() !== load(ctx).state.product) await updateFeedback(ctx, params.product, "chat", { product: params.product.trim() }, "assistant");
      const feedback = params.direction?.trim() ? await updateFeedback(ctx, params.direction, "chat", undefined, "assistant") : undefined;
      const result = await runWorkspace(ctx, undefined, params.screened ? ctx : undefined);
      const usage = addUsage(feedback?.usage, result.usage);
      return { ...result, ...(usage ? { usage } : {}) };
    },
  });
  pi.registerTool({
    name: "brand_context", label: "Naming context",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Read the canonical naming brief and external document paths. Read this before interpreting naming feedback. Feedback history is reference only; round inspection returns the actual saved generation inputs, not a reconstruction.",
    parameters: Type.Object({ section: Type.Optional(Type.Union([Type.Literal("brief"), Type.Literal("feedback"), Type.Literal("round")])), roundId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const run = load(ctx);
      const documents = brandDocumentPaths(run.path);
      if (params.section === "feedback") {
        const text = fs.existsSync(documents.feedback) ? fs.readFileSync(documents.feedback, "utf8") : "No saved feedback yet.";
        return textResult(`${text.length > 16000 ? "Recent excerpt (last 16000 characters):\n" : ""}${text.slice(-16000)}\nFull editable history: ${documents.feedback}`, { path: documents.feedback }, undefined, false);
      }
      if (params.section === "round") {
        const round = params.roundId ? run.state.rounds.find((entry) => entry.id === params.roundId) : run.state.rounds.at(-1);
        if (!round) throw new Error("No matching saved round.");
        const pool = run.state.pools.find((entry) => entry.id === round.poolId);
        const text = JSON.stringify({ round, pool: pool ?? "Legacy round: generation inputs were not recorded." }, null, 2);
        return textResult(text.length > 30000 ? `${text.slice(0, 30000)}\n[Truncated. Full saved inputs: ${run.path}]` : text, { round, pool }, undefined, false);
      }
      return textResult(`Brief r${run.state.briefRevision}\n${formatBrief(namingContent(run.state))}\nFavorite taste references: ${run.state.liked.map(entry => entry.name).join(", ") || "none"}\nBrief: ${documents.brief}\nFeedback: ${documents.feedback}`, { revision: run.state.briefRevision, favorites: run.state.liked.map(entry => entry.name), selected: run.state.selected, documents }, undefined, false);
    },
  });
  pi.registerTool({
    name: "brand_feedback", label: "Update naming brief", executionMode: "sequential",
    promptGuidelines: ["For naming feedback: inspect brand_context, then pass the user's original words to brand_feedback with a targeted interpretation. Preserve unrelated instructions. Explain the returned brief changes before generating again. Favorites already provide positive taste examples; update the brief for other rules."],
    description: "Save the user's original feedback and apply a targeted update to the naming brief. Read brand_context first. Preserve unrelated instructions. Optional changes are your explicit interpretation of the original feedback; otherwise an isolated brief editor interprets it. Returns the actual changes; does not generate names.",
    parameters: Type.Object({ feedback: Type.String({ minLength: 1, maxLength: 6000 }), changes: Type.Optional(BRIEF_CHANGES) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await updateFeedback(ctx, params.feedback, "chat", params.changes);
      return textResult(feedbackSummary(result.entry), result.entry, result.usage, false);
    },
  });
  pi.registerTool({
    name: "brand_check", label: "Check names", executionMode: "sequential",
    description: "Check saved names without favoriting them. Up to three by default; batch true checks a named selection in batches of three. uncheckedOnly retries failed or legacy incomplete checks but skips assessed names and review findings; refresh true explicitly rechecks with the current worker model. allFavorites checks saved favorites.",
    parameters: CHECK_OPTIONS,
    async execute(_id, params, signal, _update, ctx) {
      const position = resumeWorkspace?.sessionId === ctx.sessionManager.getSessionId() ? resumeWorkspace.position : undefined;
      try {
        const result = await runCheck(withToolSignal(ctx, signal), params.stage ?? "deep", params.refresh, params.names, params.allFavorites, params);
        if (position) position.notice = result.content[0].text.split("\n")[0];
        return result;
      } catch (error) {
        if (position) position.notice = `Check stopped: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
    },
  });
  pi.registerTool({
    name: "brand_pick", label: "Pick names", executionMode: "sequential", exposure: "codemode",
    description: "Compatibility picker for externally generated names. Prefer brand_generate, which owns bounded generation and deduplication.",
    parameters: Type.Object({ candidates: Type.Array(CANDIDATE_SCHEMA, { maxItems: 30 }), product: Type.Optional(Type.String()), directionHint: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.product?.trim()) await updateFeedback(ctx, params.product, "chat", { product: params.product.trim() }, "assistant");
      if (params.directionHint?.trim()) await updateFeedback(ctx, params.directionHint, "chat", undefined, "assistant");
      return runWorkspace(ctx, params.candidates.map((candidate) => ({ ...candidate, name: candidate.name.trim() })));
    },
  });
  pi.registerTool({
    name: "brand_score", label: "Availability cache", executionMode: "sequential", exposure: "codemode",
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
    name: "brand_seen", label: "Seen names", exposure: "codemode", description: "Cheap local batch duplicate check. The naming engine already performs this automatically.",
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
    description: "Name your product: more names, feedback, favorites, and the editable brief",
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();
        const [head = "", ...rest] = args.trim().split(/\s+/);
        const tail = rest.join(" ").trim();
        const command = head.toLowerCase();
        if (busy && !["help", "likes", "liked", "stats", "evidence", "excluded"].includes(command)) throw new Error("Finish the open naming picker before changing this run.");
        const run = load(ctx);
        if (command === "help") { ctx.ui.notify(HELP, "info"); return; }
        if (command === "overview" || command === "status" || (!command && run.state.product)) { await runWorkspace(ctx, undefined, undefined, true); return; }
        if (command === "settings") { await openModelSettings(ctx); return; }
        if (command === "likes" || command === "liked") {
          ctx.ui.notify(`Favorites (${run.state.liked.length}): ${run.state.liked.map((entry) => `${entry.name}${entry.score ? ` (${entry.score})` : ""}`).join(", ") || "none"}\nFinalists: ${run.state.finalists.join(", ") || "none"}`, "info"); return;
        }
        if (command === "shortlist") {
          const path = saveShortlistDocument(run.path, formatShortlist(run.state));
          ctx.ui.notify(`Shortlist saved, with findings and sources: ${path}`, "info");
          return;
        }
        if (command === "stats") { ctx.ui.notify(generationStats(run.state, run.path), "info"); return; }
        if (command === "brief") {
          const documents = brandDocumentPaths(run.path);
          if (tail === "edit" && ctx.hasUI) {
            const markdown = await ctx.ui.editor(`Naming brief · ${documents.brief}`, formatBrief(namingContent(run.state)));
            if (markdown !== undefined) {
              const content = parseBrief(markdown);
              const entry = await mutate(ctx, state => {
                if (contentKey(namingContent(state)) !== contentKey(namingContent(run.state))) throw new Error("Brief changed while editing. Reopen before saving.");
                return applyBriefChanges(state, content, { text: markdown, source: "brief-editor", author: "user" });
              });
              ctx.ui.notify(feedbackSummary(entry), "info");
            }
          } else ctx.ui.notify(`Brief r${run.state.briefRevision}\n${formatBrief(namingContent(run.state))}\n${documents.brief}`, "info");
          return;
        }
        if (command === "round") { const text = roundDetails(run.state, tail || undefined); if (ctx.hasUI) await ctx.ui.editor("Saved generation inputs · read only", text); else ctx.ui.notify(text, "info"); return; }
        if (command === "model" || command === "worker") {
          if (command !== "worker" || tail !== "same") validateBrandModel(ctx, tail);
          await mutate(ctx, (state) => {
            if (command === "model") { if (state.model !== tail) state.reserve = []; state.model = tail; }
            else state.workerModel = tail === "same" ? undefined : tail;
          }); ctx.ui.notify(`${command === "model" ? "Creative" : "Worker"} model: ${tail}. Main model unchanged. Cached checks retained.`, "info"); return;
        }
        if (command === "words" || command === "length" || command === "domains" || command === "packages") {
          await mutate(ctx, (state) => updateBrief(state, command, tail));
          ctx.ui.notify("Brief updated. Existing checks are retained; use /brand check refresh to update them.", "info"); return;
        }
        if (command === "note" || command === "feedback" || command === "pivot") {
          await updateFeedback(ctx, tail, "command");
          if (command !== "pivot") return;
          await runWorkspace(ctx); return;
        }
        if (command === "finalists") {
          if (!tail) await chooseFinalists(ctx);
          else { await mutate(ctx, (state) => setFinalists(state, namesFrom(tail, state))); ctx.ui.notify(`Finalists: ${load(ctx).state.finalists.join(", ")}.`, "info"); }
          return;
        }
        if (command === "evidence") { showRecord(ctx, tail, getAvailability(run.state, tail)); return; }
        if (command === "check" || command === "screen") {
          if (tail === "all" || tail === "all refresh") {
            const names = activeNames(run.state).map(entry => entry.name);
            if (!names.length) throw new Error("No active names to check.");
            pi.sendUserMessage(buildAvailabilityPrompt(run.state, command === "screen" ? "screen" : "deep", tail === "all refresh", names, false, { batch: true, uncheckedOnly: tail === "all" }));
            return;
          }
          let names = tail && tail !== "refresh" ? namesFrom(tail, run.state) : run.state.finalists;
          if (!names.length) {
            if (!ctx.hasUI) throw new Error("Specify saved names: /brand check <name>, <name>.");
            const result = await pickNames(ctx, activeNames(run.state), { title: "Select up to 3 names to check", selectionOnly: true, maxSelection: 3 });
            if (result?.kind !== "picked" || !result.names.length) return;
            names = result.names;
          }
          pi.sendUserMessage(buildAvailabilityPrompt(run.state, command === "screen" ? "screen" : "deep", tail === "refresh", names)); return;
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
          await mutate(ctx, (state) => dismissNames(state, namesFrom(tail, state)));
          ctx.ui.notify("Names discarded from the active list and favorites. History and cached checks are retained.", "info"); return;
        }
        if (command === "excluded") { ctx.ui.notify(`${excludedNames(run.state).seen.size} seen/excluded names:\n${[...excludedNames(run.state).seen].sort().join(", ")}`, "info"); return; }
        if (command === "history") {
          const documents = brandDocumentPaths(run.path);
          if (ctx.hasUI && fs.existsSync(documents.feedback)) {
            const original = fs.readFileSync(documents.feedback, "utf8");
            const markdown = await ctx.ui.editor(`Feedback history · ${documents.feedback}\nEdit the naming brief to change what applies.`, original);
            if (markdown !== undefined) await withFileMutationQueue(run.path, async () => saveFeedbackDocument(run.path, markdown, original));
          } else ctx.ui.notify(`Feedback: ${documents.feedback}\nRun history: ${run.path}`, "info");
          return;
        }
        if (command === "clear") {
          if (!ctx.hasUI || !await ctx.ui.confirm("Clear this naming run?", "Deletes rounds, favorites, finalists, reserve and cached checks. Other runs and the migration backup are unchanged.")) return;
          fs.copyFileSync(run.path, `${run.path}.${Date.now()}.reset-backup`);
          await mutate(ctx, state => { state.rounds = []; state.liked = []; state.selected = []; state.finalists = []; state.reserve = []; state.reservePoolId = undefined; state.pools = []; state.lastBatch = undefined; state.availability = {}; state.dismissed = []; state.generationMetrics = []; });
          ctx.ui.notify("Naming history cleared with an external backup. Brief, feedback and models retained.", "info"); return;
        }
        if (!["more", "again", "next"].includes(command) && args.trim()) {
          await updateFeedback(ctx, args.trim(), "command", { product: args.trim() });
        }
        if (!load(ctx).state.product) {
          if (!ctx.hasUI) throw new Error("Usage: /brand <what the product does>");
          const product = await ctx.ui.input("What does the product do?");
          if (!product?.trim()) return;
          await updateFeedback(ctx, product.trim(), "command", { product: product.trim() });
        }
        const result = await runWorkspace(ctx);
        if (!ctx.hasUI) ctx.ui.notify(result.content[0].text, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.on("agent_end", (_event, ctx) => {
    const resume = resumeWorkspace;
    resumeWorkspace = undefined;
    if (!resume || ctx.mode !== "tui" || busy || ctx.sessionManager.getSessionId() !== resume.sessionId) return;
    // Do not await an interactive screen here: Pi must finish agent_end to clear its run loader.
    void runWorkspace(ctx, undefined, undefined, true, resume.position).catch(error => {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    });
  });
  pi.on("session_shutdown", () => {
    resumeWorkspace = undefined;
    for (const controller of active) controller.abort(new Error("Session closed"));
  });
}

const HELP = [
  "/brand  resume: Names · Favorites · History; Space marks · f favorites · c checks pending · Shift+C rechecks · d discards",
  "/brand <product>  start naming",
  "/brand more  show the remaining pool, or generate from the active brief",
  "/brand feedback <comment>  interpret feedback and show targeted brief changes",
  "/brand pivot <comment>  apply feedback, then generate",
  "/brand brief [edit]  read or edit the canonical naming document",
  "/brand history  editable feedback history (reference only)",
  "/brand round [id]  actual saved generation inputs and origin",
  "/brand shortlist  export favorites with saved findings and sources; no new research",
  "/brand check [name, name|refresh]  check selected favorites; no promotion required",
  "/brand evidence <name>  retained sources and findings, not legal clearance",
  "Settings and diagnostics: /brand settings · stats · words single|multiple · length <3-30> · domains <suffixes> · packages on|off",
  "Advanced: /brand screen · screened · model <provider/id> · worker <provider/id|same> · keep <names> · dismiss <names> · excluded · clear",
  "Compatibility: note = feedback · overview/status = resume · likes · finalists [names]",
  "Run data, brief and feedback stay outside the project; /brand stats shows their paths.",
].join("\n");
