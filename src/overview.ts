import type { Usage } from "@earendil-works/pi-ai";
import { addUsage } from "./generation.ts";
import { brandDocumentPaths, excludedNames } from "./store.ts";
import type { BrandState } from "./types.ts";

export function brandOverview(state: BrandState): string {
  return [
    "Name your product", state.product || "No product brief yet",
    `Brief r${state.briefRevision} · ${state.liked.length} favorites`,
    `Explore: ${state.brief.direction || "Open exploration"}`,
    ...(state.brief.avoid ? [`Avoid: ${state.brief.avoid}`] : []),
    ...(state.brief.examples.length ? [`Taste examples: ${state.brief.examples.join(", ")}`] : []),
    state.reserve.length ? `${state.reserve.length} names remain from a previous pool. More will show those first.` : "More generates a new pool from this brief.",
    "Save favorites, give feedback, or check names when you’re ready.",
  ].join("\n");
}

export function generationStats(state: BrandState, path: string): string {
  const metrics = state.generationMetrics;
  const usage = metrics.reduce((sum, metric) => addUsage(sum, metric.usage), undefined as Usage | undefined);
  const documents = brandDocumentPaths(path);
  return [
    `Run: ${path}`, `Brief: ${documents.brief}`, `Feedback: ${documents.feedback}`,
    `${state.pools.length} recorded pools · ${state.rounds.length} viewed rounds · ${excludedNames(state).seen.size} seen names`,
    `Last ${metrics.length} generated pools (up to 50 retained): ${metrics.reduce((sum, metric) => sum + metric.modelCalls, 0)} model calls.`,
    `Reserve: ${state.reserve.length}. Creative: ${state.model}. Worker: ${state.workerModel ?? "same as creative"}. Creative reasoning: ${state.reasoning ?? "pi default"}. Worker reasoning: ${state.workerReasoning ?? "pi default"}.`,
    `Reported generation tokens: ${usage?.input ?? 0} uncached input, ${usage?.cacheRead ?? 0} cache reads, ${usage?.output ?? 0} output. Cost: $${(usage?.cost.total ?? 0).toFixed(4)}.`,
    `Last generation: ${metrics.at(-1)?.elapsedMs ?? 0}ms. Brief editing, assessment and failed/aborted request costs are not included here.`,
  ].join("\n");
}
