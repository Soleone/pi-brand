import { generatePool, type GenerationRequest } from "./generation.ts";
import { buildNamingBrief } from "./prompt.ts";
import { availabilityKey, seenNames } from "./store.ts";
import type { BrandState, Candidate } from "./types.ts";

export async function takeBatch(state: BrandState, request: GenerationRequest, signal?: AbortSignal): Promise<Candidate[]> {
  const excluded = seenNames(state);
  const known = new Set<string>();
  state.reserve = state.reserve.filter((candidate) => {
    const key = availabilityKey(candidate.name);
    if (excluded.has(key) || known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (state.reserve.length === 0) {
    const result = await generatePool(buildNamingBrief(state), request, { signal });
    state.reserve = result.candidates;
    state.generationMetrics.push({
      createdAt: new Date().toISOString(), model: state.model,
      modelCalls: result.metrics.modelCalls, elapsedMs: result.metrics.elapsedMs,
      generated: result.candidates.length, usage: result.metrics.usage,
    });
    state.generationMetrics = state.generationMetrics.slice(-50);
  }
  return state.reserve.splice(0, 12);
}
