import { createHash } from "node:crypto";
import type { BrandState, FeedbackEntry, NamingContent } from "./types.ts";

export function namingContent(state: BrandState): NamingContent {
  return {
    product: state.product, direction: state.brief.direction, avoid: state.brief.avoid,
    style: state.brief.style, examples: [...state.brief.examples],
    singleWord: state.brief.singleWord, maxLength: state.brief.maxLength,
  };
}

export function validateNamingContent(content: NamingContent): void {
  for (const field of ["product", "direction", "avoid", "style"] as const) {
    if (typeof content[field] !== "string" || content[field].length > 6000) throw new Error(`${field} must be text of at most 6000 characters. Nothing was truncated.`);
  }
  if (typeof content.singleWord !== "boolean") throw new Error("Single word must be yes or no.");
  if (!Number.isInteger(content.maxLength) || content.maxLength < 3 || content.maxLength > 30) throw new Error("Length must be 3-30 characters.");
  if (!Array.isArray(content.examples) || content.examples.length > 30 || content.examples.some((name) => typeof name !== "string" || !name.trim() || name.length > 60 || /[\r\n]/.test(name))) throw new Error("Use at most 30 examples, one per line, up to 60 characters each.");
}

export function formatBrief(content: NamingContent): string {
  return [
    "# Naming brief", "", "This is the source of truth for naming. Edit these sections to change the next generation.",
    "Feedback history is reference only. Favorites are not implicit instructions; add taste examples here.",
    "Format uses letters only (and spaces when multiple words are allowed). Keep the six section headings.", "",
    "## Product", content.product, "", "## Explore", content.direction, "", "## Avoid", content.avoid,
    "", "## Style", content.style, "", "## Examples", ...content.examples.map((name) => `- ${name}`),
    "", "## Format", `Single word: ${content.singleWord ? "yes" : "no"}`, `Maximum length: ${content.maxLength}`, "",
  ].join("\n");
}

export function parseBrief(markdown: string): NamingContent {
  const sections = new Map<string, string>();
  const matches = [...markdown.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  const required = ["Product", "Explore", "Avoid", "Style", "Examples", "Format"];
  for (const match of matches) {
    const title = match[1].trim();
    if (!required.includes(title) || sections.has(title)) throw new Error(`Unknown or duplicate brief section: ${title}. Keep the six section headings.`);
    sections.set(title, match[2].trim());
  }
  if (required.some((title) => !sections.has(title))) throw new Error("Brief must contain Product, Explore, Avoid, Style, Examples and Format sections. Existing data was not replaced.");
  const format = sections.get("Format")!;
  const single = format.match(/^Single word: (yes|no)$/m);
  const length = format.match(/^Maximum length: (\d+)$/m);
  if (!single || !length || format.split(/\r?\n/).filter(Boolean).length !== 2) throw new Error("Format must contain 'Single word: yes' (or no) and 'Maximum length: 12' (3-30).");
  const examples = sections.get("Examples")!.split(/\r?\n/).filter(Boolean).map((line) => {
    if (!line.startsWith("- ")) throw new Error("Examples must be a list: one '- Name' per line.");
    return line.slice(2).trim();
  });
  const content = {
    product: sections.get("Product")!, direction: sections.get("Explore")!, avoid: sections.get("Avoid")!,
    style: sections.get("Style")!, examples, singleWord: single[1] === "yes", maxLength: Number(length[1]),
  };
  validateNamingContent(content);
  return content;
}

export function contentKey(content: NamingContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function documentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function applyBriefChanges(
  state: BrandState, changes: Partial<NamingContent>,
  feedback: Pick<FeedbackEntry, "text" | "source" | "author">,
): FeedbackEntry {
  const before = namingContent(state);
  const after = { ...before, ...changes };
  validateNamingContent(after);
  const labels: Record<keyof NamingContent, string> = { product: "Product", direction: "Explore", avoid: "Avoid", style: "Style", examples: "Examples", singleWord: "Single word", maxLength: "Maximum length" };
  const changed = (Object.keys(labels) as (keyof NamingContent)[]).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  if (changed.length) {
    state.product = after.product;
    Object.assign(state.brief, { direction: after.direction, avoid: after.avoid, style: after.style, examples: after.examples, singleWord: after.singleWord, maxLength: after.maxLength });
    state.briefRevision++;
    state.reserve = [];
    state.reservePoolId = undefined;
  }
  const entry: FeedbackEntry = {
    id: `f-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), ...feedback,
    briefRevision: state.briefRevision, before, after,
    changes: changed.map((field) => `${labels[field]}: ${JSON.stringify(before[field])} → ${JSON.stringify(after[field])}`),
  };
  state.feedback.push(entry);
  return entry;
}

export function feedbackSummary(entry: FeedbackEntry): string {
  if (!entry.changes.length) return `Feedback saved. Brief r${entry.briefRevision} unchanged.`;
  const summary = entry.changes.map(change => change.length > 200 ? `${change.slice(0, 197)}…` : change);
  return `Brief r${entry.briefRevision} updated:\n${summary.join("\n")}\nOther sections kept. Older reserved names cleared. Full changes are in feedback history.`;
}

export function formatFeedbackEntry(entry: FeedbackEntry): string {
  return [
    `<!-- feedback:${entry.id} -->`, `## ${entry.createdAt} · ${entry.author} · ${entry.source}`, "",
    ...entry.text.split("\n").map((line) => `> ${line}`), "",
    entry.source === "legacy" ? "Imported historical note. Original author and date are unknown; not replayed into generation." : `Applied to brief r${entry.briefRevision}.`,
    ...(entry.error ? [`Not applied: ${entry.error}`] : []),
    ...entry.changes.map((change) => `- ${change}`), "",
  ].join("\n");
}
