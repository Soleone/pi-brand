import fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatBrief, namingContent } from "./brief.ts";
import { brandOverview, generationStats } from "./overview.ts";
import { pickNames } from "./picker.ts";
import { selectBrandOption } from "./selection.ts";
import { brandDocumentPaths, excludedNames, getAvailability } from "./store.ts";
import type { BrandState } from "./types.ts";
import { showNamingWorkspace, type FavoriteChange, type WorkspacePosition } from "./workspace-ui.ts";

export type WorkspaceAction = (
  | { kind: "more" | "add" | "feedback" | "models" | "close" | "stay" }
  | { kind: "brief"; markdown: string }
  | { kind: "feedback-document"; markdown: string; original: string }
  | { kind: "check"; names?: string[]; allFavorites?: boolean; batch?: boolean; uncheckedOnly?: boolean; stage: "deep" | "screen"; refresh: boolean }
  | { kind: "similar" | "dismiss" | "evidence"; name: string }
  | { kind: "discard" | "select"; names: string[] }
  | { kind: "setting"; field: "domains" | "packages"; value: string }
  | { kind: "keep"; names: string[]; roundId: string }
) & { favoriteChanges?: FavoriteChange[] };

export function roundDetails(state: BrandState, roundId = state.rounds.at(-1)?.id): string {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) return "No saved rounds yet.";
  const pool = state.pools.find((entry) => entry.id === round.poolId);
  return JSON.stringify({ round, pool: pool ?? "Legacy round: the generation inputs were not recorded." }, null, 2);
}

async function favoriteAction(ctx: ExtensionContext, state: BrandState): Promise<WorkspaceAction | undefined> {
  if (!state.liked.length) { ctx.ui.notify("No favorites yet. Save names from a round first.", "info"); return; }
  const favorites = [...state.liked].reverse();
  const rows = favorites.map((entry) => ({ name: entry.name, label: `${entry.name} · ${getAvailability(state, entry.name)?.score ?? "not checked"}` }));
  while (true) {
    const selected = await selectBrandOption(ctx, "Review favorites · checks are not legal clearance", ["Check selected favorites", "Check all favorites", ...rows.map((entry) => entry.label), "Back"]);
    if (!selected || selected === "Back") return;
    if (selected === "Check all favorites") return { kind: "check", allFavorites: true, stage: "deep", refresh: false };
    if (selected === "Check selected favorites") {
      const result = await pickNames(ctx, favorites, { title: "Select up to 3 names to check", selectionOnly: true, maxSelection: 3 });
      if (result?.kind === "picked" && result.names.length) return { kind: "check", names: result.names, stage: "deep", refresh: false };
      continue;
    }
    const row = rows.find((entry) => entry.label === selected);
    if (!row) continue;
    const action = await selectBrandOption(ctx, row.name, ["Check availability", "More like this", "Remove favorite", "Details", "Back"]);
    if (action === "Check availability") return { kind: "check", names: [row.name], stage: "deep", refresh: false };
    if (action === "More like this") return { kind: "similar", name: row.name };
    if (action === "Remove favorite") return { kind: "dismiss", name: row.name };
    if (action !== "Details") continue;
    const detail = await selectBrandOption(ctx, `${row.name} · availability details`, ["Read evidence", "Refresh availability", "Quick screen", "Refresh quick screen", "Back"]);
    if (detail === "Read evidence") return { kind: "evidence", name: row.name };
    if (detail === "Refresh availability") return { kind: "check", names: [row.name], stage: "deep", refresh: true };
    if (detail === "Quick screen" || detail === "Refresh quick screen") return { kind: "check", names: [row.name], stage: "screen", refresh: detail.startsWith("Refresh") };
  }
}

async function settingsAction(ctx: ExtensionContext, state: BrandState): Promise<WorkspaceAction | undefined> {
  const setting = await selectBrandOption(ctx, "Settings", ["Models", "Domain suffixes", "Package/repository checks", "Back"]);
  if (setting === "Models") return { kind: "models" };
  if (setting === "Domain suffixes") {
    const value = await ctx.ui.input("Domain suffixes (1-3)", state.brief.domains.join(" "));
    if (value !== undefined) return { kind: "setting", field: "domains", value };
  }
  if (setting === "Package/repository checks") {
    const value = await selectBrandOption(ctx, "Check npm and GitHub too?", ["Off", "On", "Back"]);
    if (value === "Off" || value === "On") return { kind: "setting", field: "packages", value: value.toLowerCase() };
  }
}

async function detailAction(ctx: ExtensionContext, state: BrandState, statePath: string): Promise<WorkspaceAction | undefined> {
  const documents = brandDocumentPaths(statePath);
  const choice = await selectBrandOption(ctx, `Brief r${state.briefRevision} / Details\n${documents.brief}`, ["Edit naming brief", "Feedback history", "Why these names?", "Settings", "History", "Statistics", "Back"]);
  if (choice === "Edit naming brief") {
    const markdown = await ctx.ui.editor("Naming brief · save to apply; Esc cancels", fs.existsSync(documents.brief) ? fs.readFileSync(documents.brief, "utf8") : formatBrief(namingContent(state)));
    if (markdown !== undefined) return { kind: "brief", markdown };
  }
  if (choice === "Feedback history") {
    const original = fs.existsSync(documents.feedback) ? fs.readFileSync(documents.feedback, "utf8") : "# Feedback history\n";
    const markdown = await ctx.ui.editor(`Feedback history · annotations do not change the active brief\n${documents.feedback}`, original);
    if (markdown !== undefined) return { kind: "feedback-document", markdown, original };
  }
  if (choice === "Why these names?") await ctx.ui.editor("Saved generation inputs · read only", roundDetails(state));
  if (choice === "Statistics") ctx.ui.notify(generationStats(state, statePath), "info");
  if (choice === "Settings") return settingsAction(ctx, state);
  if (choice === "History") {
    const section = await selectBrandOption(ctx, "History · seen does not mean disliked", ["Saved rounds", "Seen names", "Dismissed names", "Back"]);
    if (section === "Seen names") await ctx.ui.editor("Previously shown names · read only", [...excludedNames(state).seen].sort().join("\n"));
    if (section === "Dismissed names") await ctx.ui.editor("Explicitly dismissed names · read only", state.dismissed.join("\n"));
    if (section === "Saved rounds") {
      const labels = [...state.rounds].reverse().map((round) => ({ round, label: `${round.id} · ${round.createdAt} · ${round.origin ?? "legacy"}` }));
      const selected = await selectBrandOption(ctx, "Saved rounds", [...labels.map((entry) => entry.label), "Back"]);
      const round = labels.find((entry) => entry.label === selected)?.round;
      if (round) {
        const action = await selectBrandOption(ctx, round.candidates.map((entry) => entry.name).join(", "), ["Read generation inputs", "Save names as favorites", "Back"]);
        if (action === "Read generation inputs") await ctx.ui.editor("Saved inputs · read only", roundDetails(state, round.id));
        if (action === "Save names as favorites") {
          const result = await pickNames(ctx, round.candidates, { title: "Save favorites from this round", selectionOnly: true });
          if (result?.kind === "picked") return { kind: "keep", names: result.names, roundId: round.id };
        }
      }
    }
  }
}

export async function chooseWorkspaceAction(ctx: ExtensionContext, state: BrandState, statePath: string, favoritesFirst = false, position: WorkspacePosition = { tab: "names", cursor: 0 }): Promise<WorkspaceAction | undefined> {
  if (!ctx.hasUI) { ctx.ui.notify(brandOverview(state), "info"); return; }
  if (ctx.mode === "tui") {
    if (favoritesFirst) { position.tab = "favorites"; position.cursor = 0; }
    const result = await showNamingWorkspace(ctx, state, position);
    const action = result.action;
    const documents = brandDocumentPaths(statePath);
    let next: WorkspaceAction = { kind: "close" };
    if (action?.kind === "edit-brief") {
      const markdown = await ctx.ui.editor("Naming brief · save to apply; Esc cancels", formatBrief(namingContent(state)));
      if (markdown !== undefined) next = { kind: "brief", markdown };
    } else if (action?.kind === "annotations") {
      const original = fs.existsSync(documents.feedback) ? fs.readFileSync(documents.feedback, "utf8") : "# Feedback history\n";
      const markdown = await ctx.ui.editor("Feedback history · annotations do not change the active brief", original);
      if (markdown !== undefined) next = { kind: "feedback-document", markdown, original };
    } else if (action?.kind === "inputs") {
      await ctx.ui.editor("Saved generation inputs · read only", roundDetails(state, position.roundId));
    } else if (action?.kind === "settings") {
      next = await settingsAction(ctx, state) ?? next;
    } else if (action) next = action;
    // Auxiliary editors return to the workspace, including when cancelled.
    if (action && next.kind === "close") next = { kind: "stay" };
    return { ...next, favoriteChanges: result.favoriteChanges };
  }
  if (favoritesFirst) {
    const action = await favoriteAction(ctx, state);
    if (action) return action;
  }
  while (true) {
    const choice = await selectBrandOption(ctx, brandOverview(state), ["More names", "Give feedback", "Review favorites", "Brief / Details", "Close"]);
    if (!choice || choice === "Close") return;
    if (choice === "More names") return { kind: "more" };
    if (choice === "Give feedback") return { kind: "feedback" };
    const action = choice === "Review favorites" ? await favoriteAction(ctx, state) : await detailAction(ctx, state, statePath);
    if (action) return action;
  }
}
