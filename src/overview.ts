import type { Usage } from "@earendil-works/pi-ai";
import { addUsage } from "./generation.ts";
import { excludedNames, getAvailability } from "./store.ts";
import type { BrandState } from "./types.ts";

export const OVERVIEW_ACTIONS = [
  "Browse favorites", "Choose finalists", "Check finalists", "Read evidence",
  "More names", "Edit brief", "Model settings", "History and exclusions", "Generation stats", "Close overview",
];

export function brandOverview(state: BrandState): string {
  const next = state.liked.length === 0 ? "Pick favorites" : state.finalists.length === 0 ? "Choose up to 3 finalists" : "Review finalist evidence, or check them";
  return [
    "Brand overview",
    state.product || "No product brief yet",
    `${state.liked.length} favorites · ${state.finalists.length}/3 finalists · ${state.reserve.length} reserved · ${excludedNames(state).seen.size} seen/excluded`,
    ...state.finalists.map((name) => {
      const record = getAvailability(state, name);
      return `${name}: ${record ? `${record.score} (${record.stage}, ${record.checkedAt})` : "not checked"}`;
    }),
    `Direction: ${state.brief.direction || "default"}`,
    `Rules: ${state.brief.singleWord ? "single words" : "multiple words allowed"}, max ${state.brief.maxLength} characters · Domains: ${state.brief.domains.join(", ")} · Packages: ${state.brief.checkPackages ? "on" : "off"}`,
    `Creative: ${state.model} · Worker: ${state.workerModel ?? "same as creative"}`,
    `Next: ${next}. Generating more is optional.`,
  ].join("\n");
}

export function generationStats(state: BrandState, path: string): string {
  const metrics = state.generationMetrics;
  const usage = metrics.reduce((sum, metric) => addUsage(sum, metric.usage), undefined as Usage | undefined);
  return [
    `Run: ${path}`,
    `Last ${metrics.length} generated pools (up to 50 retained): ${metrics.reduce((sum, metric) => sum + metric.modelCalls, 0)} model calls, ${metrics.reduce((sum, metric) => sum + metric.generated, 0)} candidates.`,
    `Reserve: ${state.reserve.length}. Creative: ${state.model}. Worker: ${state.workerModel ?? "same as creative"}.`,
    `Reported generation tokens: ${usage?.input ?? 0} uncached input, ${usage?.cacheRead ?? 0} cache reads, ${usage?.output ?? 0} output. Cost: $${(usage?.cost.total ?? 0).toFixed(4)}.`,
    `Last generation: ${metrics.at(-1)?.elapsedMs ?? 0}ms. Assessment and failed/aborted request costs are not included here.`,
  ].join("\n");
}
