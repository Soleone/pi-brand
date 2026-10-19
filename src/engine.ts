import { createHash } from "node:crypto";
import { GENERATION_SYSTEM_PROMPT, generatePool, type GenerationRequest } from "./generation.ts";
import { buildNamingBrief } from "./prompt.ts";
import { availabilityKey, seenNames } from "./store.ts";
import type { BrandState, Candidate, GenerationPool } from "./types.ts";

export function generationInputKey(state: BrandState): string {
  const { excluded: _excluded, ...brief } = buildNamingBrief(state);
  return createHash("sha256").update(JSON.stringify({ model: state.model, brief })).digest("hex");
}

export function recordExternalPool(state: BrandState, candidates: Candidate[]): void {
  const pool: GenerationPool = {
    id: `p-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), origin: "external",
    model: "external (not recorded)", briefRevision: state.briefRevision, inputKey: generationInputKey(state),
    brief: buildNamingBrief(state), prompts: [], candidates: structuredClone(candidates),
  };
  state.pools.push(pool);
  state.lastBatch = { poolId: pool.id, origin: "external" };
}

export async function takeBatch(state: BrandState, request: GenerationRequest, signal?: AbortSignal): Promise<Candidate[]> {
  const excluded = seenNames(state);
  const inputKey = generationInputKey(state);
  let pool = state.pools.find((entry) => entry.id === state.reservePoolId);
  if (!pool || pool.inputKey !== inputKey) {
    state.reserve = [];
    state.reservePoolId = undefined;
  }
  const known = new Set<string>();
  state.reserve = state.reserve.filter((candidate) => {
    const key = availabilityKey(candidate.name);
    if (excluded.has(key) || known.has(key)) return false;
    known.add(key);
    return true;
  });
  let origin: "generated" | "reserve" = "reserve";
  if (state.reserve.length === 0) {
    const brief = buildNamingBrief(state);
    const result = await generatePool(brief, request, { signal });
    pool = {
      id: `p-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), model: state.model,
      briefRevision: state.briefRevision, inputKey, brief, prompts: result.prompts,
      systemPrompt: GENERATION_SYSTEM_PROMPT, candidates: structuredClone(result.candidates), origin: "generated",
    };
    state.pools.push(pool);
    state.reservePoolId = pool.id;
    state.reserve = result.candidates;
    state.generationMetrics.push({
      createdAt: pool.createdAt, model: state.model,
      modelCalls: result.metrics.modelCalls, elapsedMs: result.metrics.elapsedMs,
      generated: result.candidates.length, usage: result.metrics.usage,
    });
    state.generationMetrics = state.generationMetrics.slice(-50);
    origin = "generated";
  }
  state.lastBatch = { poolId: pool!.id, origin: pool!.origin === "external" ? "external" : origin };
  return state.reserve.splice(0, 12);
}
