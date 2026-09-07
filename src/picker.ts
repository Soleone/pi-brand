import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";

import { formatScore } from "./scoring.ts";
import type { Candidate } from "./types.ts";

export interface PickOptions {
  title?: string;
  product?: string;
}

type PickerContext = ExtensionContext | ExtensionCommandContext;

const PAGE_SIZE = 10;

/**
 * Multi-select picker for name candidates. Space toggles, Enter confirms,
 * Esc cancels. Typing filters. If nothing is toggled, Enter picks the
 * highlighted row so a single favorite is one keypress.
 */
export async function pickNames(
  ctx: PickerContext,
  candidates: Candidate[],
  options: PickOptions = {},
): Promise<string[] | undefined> {
  if (candidates.length === 0) return undefined;
  if (!ctx.hasUI) return undefined;

  const ui = ctx.ui;
  if (typeof ui.custom !== "function") {
    return await confirmLoopFallback(ctx, candidates);
  }

  const title = options.title ?? "Pick favorites";
  const alreadyLiked = new Set<string>();

  return await ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const headerLine = new Text("", 1, 0);
    const filterLine = new Text("", 1, 0);
    const listArea = new Text("", 1, 0);
    const footerLine = new Text("", 1, 0);

    let query = "";
    let cursor = 0;
    let scroll = 0;
    const selected = new Set<string>();
    let finished = false;

    const finish = (value: string[] | undefined): void => {
      if (finished) return;
      finished = true;
      done(value);
    };

    const filtered = (): Candidate[] => {
      const needle = query.toLocaleLowerCase();
      if (!needle) return candidates;
      return candidates.filter((candidate) =>
        `${candidate.name} ${candidate.flavor ?? ""} ${candidate.style ?? ""}`
          .toLocaleLowerCase()
          .includes(needle),
      );
    };

    const clampCursor = (rows: Candidate[]): void => {
      if (rows.length === 0) {
        cursor = 0;
        scroll = 0;
        return;
      }
      cursor = Math.max(0, Math.min(cursor, rows.length - 1));
      if (cursor < scroll) scroll = cursor;
      if (cursor >= scroll + PAGE_SIZE) scroll = cursor - PAGE_SIZE + 1;
    };

    const render = (): void => {
      const rows = filtered();
      clampCursor(rows);
      const visible = rows.slice(scroll, scroll + PAGE_SIZE);

      const picked = selected.size;
      const header = options.product
        ? `${title}  ·  ${options.product}  ·  ${picked} picked`
        : `${title}  ·  ${picked} picked`;
      headerLine.setText(theme.fg("accent", theme.bold(header)));
      filterLine.setText(
        theme.fg("muted", "Filter  ") +
          (query ? theme.fg("accent", query) : theme.fg("dim", "type to search")),
      );

      if (rows.length === 0) {
        listArea.setText(theme.fg("warning", "No matches. Backspace to clear the filter."));
      } else {
        const lines = visible.map((candidate, index) => {
          const absolute = scroll + index;
          const active = absolute === cursor;
          const checked = selected.has(candidate.name);
          const box = checked ? "[x]" : "[ ]";
          const score = formatScore(candidate.score);
          const flavor = candidate.flavor ? `  ${candidate.flavor}` : "";
          const style = candidate.style ? `  (${candidate.style})` : "";
          const mark = alreadyLiked.has(candidate.name.toLocaleLowerCase()) ? "  ♥" : "";
          const line = `${box} ${candidate.name}  <${score}>${flavor}${style}${mark}`;
          if (active) return theme.fg("accent", `▸ ${line}`);
          if (checked) return theme.fg("accent", `  ${line}`);
          return `  ${line}`;
        });
        const position =
          rows.length > PAGE_SIZE
            ? theme.fg("dim", `  ${scroll + 1}-${scroll + visible.length} of ${rows.length}`)
            : "";
        listArea.setText([...lines, position].filter(Boolean).join("\n"));
      }

      footerLine.setText(
        theme.fg("dim", "Space toggle · Enter confirm · Esc cancel · ↑↓ move"),
      );
      tui.requestRender();
    };

    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(headerLine);
    container.addChild(filterLine);
    container.addChild(listArea);
    container.addChild(footerLine);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    render();

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, Key.escape)) {
          finish(undefined);
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const rows = filtered();
          if (rows.length === 0) {
            finish(undefined);
            return;
          }
          if (selected.size === 0) {
            finish([rows[cursor]?.name ?? rows[0].name]);
            return;
          }
          // Preserve candidate order in the result.
          finish(candidates.map((c) => c.name).filter((name) => selected.has(name)));
          return;
        }
        if (data === " ") {
          const rows = filtered();
          const current = rows[cursor];
          if (current) {
            if (selected.has(current.name)) selected.delete(current.name);
            else selected.add(current.name);
            if (cursor < rows.length - 1) cursor += 1;
            render();
          }
          return;
        }
        if (matchesKey(data, Key.up)) {
          cursor -= 1;
          render();
          return;
        }
        if (matchesKey(data, Key.down)) {
          cursor += 1;
          render();
          return;
        }
        if (matchesKey(data, Key.backspace)) {
          if (query.length > 0) {
            query = query.slice(0, -1);
            cursor = 0;
            scroll = 0;
            render();
          }
          return;
        }
        if (matchesKey(data, Key.ctrl("u"))) {
          query = "";
          cursor = 0;
          scroll = 0;
          render();
          return;
        }
        if (/^[\x20-\x7e]+$/.test(data)) {
          query += data;
          cursor = 0;
          scroll = 0;
          render();
        }
      },
    };
  });
}

/** Fallback for RPC/test contexts without custom TUI: confirm each name. */
async function confirmLoopFallback(
  ctx: PickerContext,
  candidates: Candidate[],
): Promise<string[] | undefined> {
  const picks: string[] = [];
  for (const candidate of candidates) {
    const label = candidate.flavor ? `${candidate.name} (${candidate.flavor})` : candidate.name;
    const yes = await ctx.ui.confirm("Like this name?", label);
    if (yes) picks.push(candidate.name);
  }
  return picks;
}
