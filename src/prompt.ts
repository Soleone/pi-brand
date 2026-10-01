import type { NamingBrief } from "./generation.ts";
import { seenNames } from "./store.ts";
import type { BrandState } from "./types.ts";

export function buildNamingBrief(state: BrandState): NamingBrief {
  return {
    product: state.product,
    direction: state.brief.direction,
    examples: state.liked.slice(-8).map((entry) => entry.name),
    constraints: { singleWord: state.brief.singleWord, maxLength: state.brief.maxLength },
    excluded: [...seenNames(state)],
  };
}

/** Commands use the isolated engine directly; these short prompts are fallbacks. */
export function buildMorePrompt(_state: BrandState): string {
  return "Call brand_generate once for the current naming run. The tool owns generation, deduplication and the picker. Do not generate names or research independently.";
}

export function buildAvailabilityPrompt(state: BrandState, stage: "screen" | "deep" = "deep", refresh = false, names = state.finalists, allFavorites = false): string {
  if (allFavorites) return `Call brand_check once with stage ${stage}, refresh ${refresh}, and allFavorites true to check every saved favorite in batches of up to three. The tool owns cache lookup, bounded research and persistence. Do not do independent checks or re-research cached names.`;
  if (names.length === 0) return "Choose up to three favorites as finalists with /brand finalists first.";
  const target = names.length === 1 ? "saved favorite" : "saved favorites";
  return `Call brand_check once with stage ${stage}, refresh ${refresh}, and names ${JSON.stringify(names)} for these ${target}. The tool owns cache lookup, bounded research and persistence. Do not do independent checks or re-research cached names.`;
}
