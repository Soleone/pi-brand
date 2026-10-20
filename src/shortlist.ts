import { isCheckStale } from "./checker.ts";
import { compareScores, formatScore, SCORE_INFO } from "./scoring.ts";
import { getAvailability } from "./store.ts";
import type { BrandState } from "./types.ts";

function markdown(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
}

/** A snapshot of saved decisions, never an implicit research request. */
export function formatShortlist(state: BrandState): string {
  if (!state.liked.length) throw new Error("Favorite a few names first, then export your shortlist.");
  const favorites = [...state.liked].sort((a, b) => compareScores(getAvailability(state, a.name)?.score ?? "unknown", getAvailability(state, b.name)?.score ?? "unknown"));
  const lines = ["# Naming shortlist", "", markdown(state.product), "", `Brief revision: ${state.briefRevision}`, "", "Preliminary collision research, not trademark clearance. Domain registration and pricing must be verified before committing.", ""];
  for (const entry of favorites) {
    const record = getAvailability(state, entry.name);
    lines.push(`## ${markdown(entry.name)}`, "");
    if (entry.flavor) lines.push(markdown(entry.flavor), "");
    lines.push(`**Finding:** ${record ? formatScore(record.score) : "Not checked"}`, "");
    if (isCheckStale(record, state)) lines.push("Requirements changed since this finding. Recheck before relying on it.", "");
    if (!record) { lines.push("No research has been performed for this name.", ""); continue; }
    lines.push(markdown(record.reason), "", `**Next step:** ${markdown(SCORE_INFO[record.score].nextStep)}`, "", `Checked: ${markdown(record.checkedAt)} (${record.stage ?? "legacy"})`, "");
    for (const warning of record.warnings ?? []) lines.push(`- Note: ${markdown(warning)}`);
    for (const query of record.searchQueries ?? []) lines.push(`- Search: ${markdown(query)}`);
    for (const source of record.evidence ?? []) {
      if (!/^https?:\/\//i.test(source.url)) continue;
      const url = source.url.replace(/[<>\s]/g, character => encodeURIComponent(character));
      lines.push(`- ${source.source}: ${markdown(source.detail)} <${url}>`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
