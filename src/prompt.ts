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

export function buildAvailabilityPrompt(state: BrandState, stage: "screen" | "deep" = "deep", refresh = false): string {
  if (state.finalists.length === 0) return "Choose up to three favorites as finalists with /brand finalists first.";
  return `Call brand_check once with stage ${stage} and refresh ${refresh} for the saved finalists (${state.finalists.join(", ")}). The tool owns cache lookup, bounded research and persistence. Do not do independent checks or re-research cached names.`;
}
