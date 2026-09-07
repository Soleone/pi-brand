import type { BrandState } from "./types.ts";

/**
 * Short reminder injected into LLM context so later search rounds stay aware
 * of the path: what the user liked, what to avoid, and which direction to
 * explore next.
 */
export function buildBrandContext(state: BrandState, maxLiked = 20): string | undefined {
  const liked = state.liked.slice(-maxLiked).map((entry) => entry.name);
  const hasAvailability = Object.keys(state.availability).length > 0;
  if (liked.length === 0 && state.directionNotes.length === 0 && !hasAvailability) return undefined;

  const parts: string[] = ["[brand] naming direction so far:"];
  if (state.product) parts.push(`Product: ${state.product}`);
  if (liked.length > 0) {
    parts.push(`Liked names (bias future rounds toward this vibe): ${liked.join(", ")}`);
  }
  if (state.dismissed.length > 0) {
    parts.push(`Avoid (already rejected): ${state.dismissed.slice(-20).join(", ")}`);
  }
  const checked = Object.entries(state.availability);
  if (checked.length > 0) {
    const rendered = checked.slice(-20).map(([name, entry]) => `${name} (${entry.score})`);
    parts.push(
      `Availability-checked (already researched in this project, NEVER re-check, trust these): ${rendered.join(", ")}`,
    );
  }
  if (state.directionNotes.length > 0) {
    parts.push(`Direction notes: ${state.directionNotes.slice(-5).join(" | ")}`);
  }
  parts.push(
    "Do not repeat seen names. When generating, call the brand_pick tool to confirm picks.",
  );
  parts.push(
    "User exits: /brand more (next shortlist, same direction) · /brand pivot <note> (new direction) · /brand check (availability deep-check of kept names). Offer these instead of asking open questions.",
  );
  return parts.join("\n");
}

const SEEN_LIMIT = 60;

/** Reuse the current direction and pull up another shortlist. */
export function buildMorePrompt(state: BrandState): string {
  const lines: string[] = [
    `Continue naming this product: ${state.product || "(product description missing, ask the user)"}`,
    "",
    "Same direction as before: keep the vibe of the liked names and honor every direction note. Do not ask what to change, just generate.",
    "",
    "Produce 12-15 brand new candidates.",
    "Constraints: under 10 chars ideally, easy to spell after hearing once, no hyphens or numbers, no generic AI slop (no -ly, -ify, -AI suffix unless it earns it).",
    "Drop names that are famous products or brands in any space, and names that only work with a desperate dodge (getX, Xhq, Xly, tryX).",
  ];
  const liked = state.liked.map((entry) => entry.name);
  if (liked.length > 0) {
    lines.push("", `Previously liked (match this vibe, do not repeat): ${liked.join(", ")}`);
  }
  if (state.directionNotes.length > 0) {
    lines.push("", `Direction notes (all of these apply): ${state.directionNotes.slice(-5).join(" | ")}`);
  }
  lines.push("", `Already suggested (do not repeat, including rejected): ${seenList(state)}`);
  lines.push("", "Then call the brand_pick tool with the survivors (name plus one-line flavor note each).");
  return lines.join("\n");
}

/** Change direction: the note is already saved, this pushes it to the front. */
export function buildPivotPrompt(state: BrandState, note: string): string {
  return `${buildMorePrompt(state)}\n\nHighest priority for this round, overriding older taste where they clash: ${note}`;
}

/** Deep-check availability for every kept name, cache first. */
export function buildAvailabilityPrompt(state: BrandState): string {
  const names = state.liked.map((entry) => entry.name);
  if (names.length === 0) {
    return "No kept names to availability-check. Run /brand to generate a shortlist and pick favorites first.";
  }
  const cached = names.filter((name) => state.availability[name.toLocaleLowerCase()]);
  const fresh = names.filter((name) => !state.availability[name.toLocaleLowerCase()]);
  const lines: string[] = [
    `Availability deep-check for these kept names: ${names.join(", ")}`,
    "",
    "Cache first, always. Call brand_score with just each name before researching anything.",
    "A cached result is final: do not re-check it, do not second-guess it.",
  ];
  if (cached.length > 0) {
    lines.push(`Already checked, report as-is: ${cached.join(", ")}`);
  }
  if (fresh.length > 0) {
    lines.push(
      "",
      `Research these uncached names now: ${fresh.join(", ")}`,
      "For each: npm registry scope availability, GitHub repo/org collisions, DNS for .com plus one hipster TLD (.sh, .io, .dev), and a web search for products or companies in the todo/task/agent space.",
      "Record each result with brand_score plus the collision signals so no future session repeats it. Do not run checks for names outside the kept list.",
      "",
      "Then report one compact table: name, score, what collided, and the best free domain found.",
    );
  }
  return lines.join("\n");
}

function seenList(state: BrandState): string {
  const seen = state.rounds.flatMap((round) => round.candidates.map((c) => c.name));
  const dismissed = state.dismissed;
  const merged = [...new Set([...seen, ...dismissed])];
  return merged.slice(-SEEN_LIMIT).join(", ") || "(none yet)";
}

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
    "Do NOT run npm, gh, DNS, or trademark checks in Phase 1. Availability deep checks happen only when the user runs /brand check.",
  );
  return lines.join("\n");
}
