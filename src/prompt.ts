import type { BrandState } from "./types.ts";

/**
 * Short reminder injected into LLM context so later search rounds stay aware
 * of the path: what the user liked, what to avoid, and which direction to
 * explore next.
 */
export function buildBrandContext(state: BrandState, maxLiked = 20): string | undefined {
  const liked = state.liked.slice(-maxLiked).map((entry) => entry.name);
  if (liked.length === 0 && state.directionNotes.length === 0) return undefined;

  const parts: string[] = ["[brand] naming direction so far:"];
  if (state.product) parts.push(`Product: ${state.product}`);
  if (liked.length > 0) {
    parts.push(`Liked names (bias future rounds toward this vibe): ${liked.join(", ")}`);
  }
  if (state.dismissed.length > 0) {
    parts.push(`Avoid (already rejected): ${state.dismissed.slice(-20).join(", ")}`);
  }
  if (state.directionNotes.length > 0) {
    parts.push(`Direction notes: ${state.directionNotes.slice(-5).join(" | ")}`);
  }
  parts.push("Do not repeat seen names. When generating, call the brand_pick tool to confirm picks.");
  return parts.join("\n");
}

const SEEN_LIMIT = 60;

/** Prompt sent when /brand starts a new round. */
export function buildRoundPrompt(product: string, state: BrandState): string {
  const lines: string[] = [
    `Help me name this product: ${product}`,
    "",
    "Phase 1 is speed. Do not deep-verify everything upfront.",
    "",
    "Generate 20 candidates. Mix styles: short real words, 2-syllable compounds, invented but pronounceable, verb-able.",
    "Constraints: under 10 chars ideally, easy to spell after hearing once, no hyphens or numbers, no generic AI slop (no -ly, -ify, -AI suffix unless it earns it).",
    "",
    "Filter only the obvious using your own knowledge:",
    "- Drop names that are famous products or brands in any space (if a normal person hears it and thinks of the other product first, drop it).",
    "- Drop names that only work with a desperate dodge (getX, Xhq, Xly, tryX).",
    "- Group what remains by direction (e.g. playful vs plain vs invented) so choosing is easy.",
  ];

  const liked = state.liked.map((entry) => entry.name);
  if (liked.length > 0) {
    lines.push("", `Previously liked (match this vibe, do not repeat): ${liked.join(", ")}`);
  }
  if (state.directionNotes.length > 0) {
    lines.push("", `Direction notes: ${state.directionNotes.slice(-5).join(" | ")}`);
  }
  const seen = state.rounds.flatMap((round) => round.candidates.map((c) => c.name));
  if (seen.length > 0) {
    lines.push("", `Already suggested (do not repeat): ${seen.slice(-SEEN_LIMIT).join(", ")}`);
  }

  lines.push(
    "",
    "Then call the brand_pick tool with 12-15 survivors (name plus one-line flavor note each).",
    "Do NOT run npm, gh, DNS, or trademark checks in Phase 1. Availability deep checks happen only on picks, in a later step.",
  );
  return lines.join("\n");
}
