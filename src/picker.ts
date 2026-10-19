import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatScore } from "./scoring.ts";
import type { Candidate } from "./types.ts";

export interface PickOptions {
  title?: string;
  context?: string;
  origin?: string;
  selectionOnly?: boolean;
  maxSelection?: number;
  initialNames?: string[];
}

export type PickOutcome =
  | { kind: "picked"; names: string[] }
  | { kind: "action"; action: "more" | "feedback" | "favorites" | "details"; names: string[] };

const PAGE_SIZE = 10;

export async function pickNames(ctx: ExtensionContext, candidates: Candidate[], options: PickOptions = {}): Promise<PickOutcome | undefined> {
  if (!ctx.hasUI || !candidates.length) return;
  if (ctx.mode !== "tui") return selectLoop(ctx, candidates, options);
  const available = new Set(candidates.map((entry) => entry.name));
  const selected = new Set((options.initialNames ?? []).filter((name) => available.has(name)).slice(0, options.maxSelection ?? candidates.length));
  return ctx.ui.custom<PickOutcome | undefined>((tui, theme, _keys, done) => {
    const container = new Container();
    const input = new Input({ prompt: "Filter: ", placeholder: "type to filter…" });
    let cursor = 0;
    let scroll = 0;
    let warning = "";
    const names = () => candidates.filter((entry) => selected.has(entry.name)).map((entry) => entry.name);
    const rows = () => candidates.filter((entry) => `${entry.name} ${entry.flavor ?? ""}`.toLocaleLowerCase().includes(input.getValue().toLocaleLowerCase()));
    const text = (render: () => string) => ({
      render: (width: number) => render().split("\n").filter(Boolean).map((line) => ` ${truncateToWidth(line, Math.max(0, width - 2), "…")}`),
      invalidate() {},
    });
    container.addChild(new DynamicBorder((line) => theme.fg("accent", line)));
    container.addChild(text(() => theme.bold(options.title ?? "Pick favorites")));
    container.addChild(text(() => options.origin ?? ""));
    container.addChild(text(() => options.context ?? ""));
    container.addChild(input);
    container.addChild({
      render(width: number) {
        const filtered = rows();
        cursor = Math.max(0, Math.min(cursor, filtered.length - 1));
        if (cursor < scroll) scroll = cursor;
        if (cursor >= scroll + PAGE_SIZE) scroll = cursor - PAGE_SIZE + 1;
        if (!filtered.length) return [truncateToWidth(" No matches. Clear the filter to see names.", width, "…")];
        const lines = filtered.slice(scroll, scroll + PAGE_SIZE).map((entry, index) => {
          const active = scroll + index === cursor;
          const status = entry.score ? ` · ${formatScore(entry.score)}` : "";
          const line = `${active ? "›" : " "} [${selected.has(entry.name) ? "x" : " "}] ${entry.name}${status}${entry.flavor ? `  ${entry.flavor}` : ""}`;
          return truncateToWidth(active ? theme.fg("accent", line) : line, width, "…");
        });
        if (filtered.length > PAGE_SIZE) lines.push(truncateToWidth(` ${scroll + 1}-${Math.min(scroll + PAGE_SIZE, filtered.length)} of ${filtered.length}`, width, "…"));
        return lines;
      },
      invalidate() {},
    });
    container.addChild(text(() => `${selected.size} ${options.selectionOnly ? "selected" : "favorites selected"}${warning ? ` · ${warning}` : ""}`));
    if (!options.selectionOnly) container.addChild(text(() => "1 More names · 2 Give feedback · 3 Review favorites"));
    container.addChild(text(() => options.selectionOnly
      ? "Space toggle · Enter save · Esc cancel"
      : "Space favorite · Enter/Esc save and close · ? Batch details"));
    container.addChild(new DynamicBorder((line) => theme.fg("accent", line)));
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width) => container.render(width).map((line) => truncateToWidth(line, width, "…")),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) { done(options.selectionOnly ? undefined : { kind: "picked", names: names() }); return; }
        if (matchesKey(data, Key.enter)) { done({ kind: "picked", names: names() }); return; }
        if (!options.selectionOnly && ["1", "2", "3", "?"].includes(data)) {
          const action = ({ "1": "more", "2": "feedback", "3": "favorites", "?": "details" } as const)[data as "1" | "2" | "3" | "?"];
          done({ kind: "action", action, names: names() });
          return;
        }
        if (data === " ") {
          const current = rows()[cursor];
          if (current) {
            if (selected.has(current.name)) selected.delete(current.name);
            else if (options.maxSelection && selected.size >= options.maxSelection) warning = `At most ${options.maxSelection}; deselect one first.`;
            else { selected.add(current.name); warning = ""; cursor++; }
          }
        } else if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) cursor--;
        else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) cursor++;
        else if (matchesKey(data, Key.pageUp)) cursor -= PAGE_SIZE;
        else if (matchesKey(data, Key.pageDown)) cursor += PAGE_SIZE;
        else { input.handleInput(data); cursor = 0; scroll = 0; }
        tui.requestRender();
      },
    };
  });
}

async function selectLoop(ctx: ExtensionContext, candidates: Candidate[], options: PickOptions): Promise<PickOutcome | undefined> {
  const picks = new Set((options.initialNames ?? []).filter((name) => candidates.some((entry) => entry.name === name)).slice(0, options.maxSelection ?? candidates.length));
  while (true) {
    const choices = ["Save and close", ...(options.selectionOnly ? [] : ["More names", "Give feedback", "Review favorites", "Batch details"]), ...candidates.map((entry) => `[${picks.has(entry.name) ? "x" : " "}] ${entry.name}`)];
    const title = [options.title ?? "Pick favorites", options.origin, options.context].filter(Boolean).join("\n");
    const choice = await ctx.ui.select(title, choices);
    const names = candidates.filter((entry) => picks.has(entry.name)).map((entry) => entry.name);
    if (!choice) return options.selectionOnly ? undefined : { kind: "picked", names };
    if (choice === "Save and close") return { kind: "picked", names };
    const action = ({ "More names": "more", "Give feedback": "feedback", "Review favorites": "favorites", "Batch details": "details" } as const)[choice as "More names"];
    if (!options.selectionOnly && action) return { kind: "action", action, names };
    const candidate = candidates.find((entry) => choice === `[${picks.has(entry.name) ? "x" : " "}] ${entry.name}`);
    if (!candidate) continue;
    if (picks.has(candidate.name)) picks.delete(candidate.name);
    else if (!options.maxSelection || picks.size < options.maxSelection) picks.add(candidate.name);
    else ctx.ui.notify(`Choose at most ${options.maxSelection}. Deselect one first.`, "warning");
  }
}
