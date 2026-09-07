import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatScore } from "./scoring.ts";
import type { Candidate } from "./types.ts";

export interface PickOptions {
  title?: string;
  product?: string;
  /** Names kept from earlier rounds, shown so picks read as accumulating, not resetting. */
  likedSoFar?: string[];
}

type PickerContext = ExtensionContext | ExtensionCommandContext;

/** What the picker resolved to: keeps, a whole-round rejection, or cancel. */
export type PickOutcome =
  | { kind: "picked"; names: string[] }
  | { kind: "rejected"; names: string[]; comment: string };

const PAGE_SIZE = 10;

// Nerd Font icons (single cell in a patched font). The checkbox pair saves
// two columns over the old `[ ]` / `[x]` style and the table stays aligned.
const ICON_CHECKED = "󰄵";
const ICON_UNCHECKED = "󰄱";
const ICON_CURSOR = "❯";
const ICON_HEART = "";
const ICON_SEARCH = "";

function padEndVisible(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

type ScoreColor = "success" | "warning" | "error" | "dim";

function scoreColor(score: string | undefined): ScoreColor {
  switch (score) {
    case "perfect":
    case "good":
      return "success";
    case "decent":
      return "warning";
    case "bad":
    case "terrible":
      return "error";
    default:
      return "dim";
  }
}

/**
 * Multi-select picker for name candidates. Space toggles, Enter confirms the
 * toggled picks. Typing filters. Enter with nothing toggled and Esc open the
 * react prompt instead (type a note, Enter rejects the round, Esc backs out).
 * Enter never auto-picks the highlighted row. Ctrl+R also opens the prompt.
 */
export async function pickNames(
  ctx: PickerContext,
  candidates: Candidate[],
  options: PickOptions = {},
): Promise<PickOutcome | undefined> {
  if (candidates.length === 0) return undefined;
  if (!ctx.hasUI) return undefined;

  const ui = ctx.ui;
  if (typeof ui.custom !== "function") {
    return await confirmLoopFallback(ctx, candidates);
  }

  const title = options.title ?? "Pick favorites";
  const alreadyLiked = new Set((options.likedSoFar ?? []).map((name) => name.toLocaleLowerCase()));
  const keptNames = (options.likedSoFar ?? []).map((name) => name.trim()).filter(Boolean);

  // Fixed column widths so rows stay aligned while filtering.
  const nameWidth = Math.max(4, ...candidates.map((c) => visibleWidth(c.name)));
  const scoreWidth = Math.max(8, ...candidates.map((c) => visibleWidth(formatScore(c.score))));

  return await ui.custom<PickOutcome | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const headerLine = new Text("", 1, 0);
    const filterLine = new Text("", 1, 0);
    const keptLine = new Text("", 1, 0);
    const footerLine = new Text("", 1, 0);

    let query = "";
    let cursor = 0;
    let scroll = 0;
    const selected = new Set<string>();
    let finished = false;
    let rejecting = false;
    let rejectNote = "";

    const finish = (value: PickOutcome | undefined): void => {
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

    const renderRow = (
      candidate: Candidate,
      active: boolean,
      contentWidth: number,
    ): string => {
      const checked = selected.has(candidate.name);
      const score = formatScore(candidate.score);

      const cursorCell = active ? theme.fg("accent", ICON_CURSOR) : " ";
      const checkCell = checked
        ? theme.fg("success", ICON_CHECKED)
        : theme.fg("dim", ICON_UNCHECKED);

      const paddedName = padEndVisible(candidate.name, nameWidth);
      const nameCell = active
        ? theme.fg("accent", theme.bold(paddedName))
        : checked
          ? theme.fg("accent", paddedName)
          : paddedName;

      const paddedScore = padEndVisible(score, scoreWidth);
      const scoreCell = theme.fg(scoreColor(candidate.score), paddedScore);

      const liked = alreadyLiked.has(candidate.name.toLocaleLowerCase());
      const styleSuffix = candidate.style ? `  ${theme.fg("dim", `· ${candidate.style}`)}` : "";
      const heartSuffix = liked ? ` ${theme.fg("error", ICON_HEART)}` : "";
      const suffixWidth = visibleWidth(
        `${candidate.style ? `  · ${candidate.style}` : ""}${liked ? " ♥" : ""}`,
      );

      const prefixWidth = 1 + 1 + 1 + 1 + nameWidth + 2 + scoreWidth + 2;
      const maxFlavor = Math.max(0, contentWidth - prefixWidth - suffixWidth);
      let flavorCell = "";
      if (candidate.flavor && maxFlavor > 0) {
        const truncated = truncateToWidth(candidate.flavor, maxFlavor, "…");
        flavorCell = theme.fg("muted", truncated);
      }

      return `${cursorCell} ${checkCell} ${nameCell}  ${scoreCell}  ${flavorCell}${styleSuffix}${heartSuffix}`;
    };

    // Custom list component so rows can truncate to the live viewport width
    // instead of wrapping and breaking column alignment.
    const listView = {
      render: (width: number): string[] => {
        const rows = filtered();
        clampCursor(rows);
        const contentWidth = Math.max(1, width - 2);
        if (rows.length === 0) {
          return [` ${theme.fg("warning", "No matches — backspace to clear the filter.")}`];
        }
        const visible = rows.slice(scroll, scroll + PAGE_SIZE);
        const lines = visible.map((candidate, index) =>
          ` ${renderRow(candidate, scroll + index === cursor, contentWidth)}`,
        );
        if (rows.length > PAGE_SIZE) {
          lines.push(
            ` ${theme.fg("dim", `${scroll + 1}–${scroll + visible.length} of ${rows.length}`)}`,
          );
        }
        return lines;
      },
      invalidate: () => {},
    };

    const render = (): void => {
      const rows = filtered();
      clampCursor(rows);

      const picked = selected.size;
      const countCell =
        picked > 0
          ? theme.fg("success", `${ICON_CHECKED} ${picked} picked`)
          : theme.fg("dim", `${ICON_UNCHECKED} nothing picked yet`);
      const header = theme.bold(title);
      const productCell = options.product ? theme.fg("dim", `  ·  ${options.product}  ·  `) : theme.fg("dim", "  ·  ");
      headerLine.setText(`${header}${productCell}${countCell}`);

      const filterIcon = theme.fg("muted", `${ICON_SEARCH} `);
      filterLine.setText(
        query
          ? `${filterIcon}${query}${theme.fg("accent", "▍")}${theme.fg("dim", `  ·  ${rows.length}/${candidates.length}`)}`
          : `${filterIcon}${theme.fg("dim", "type to filter…")}`,
      );

      if (keptNames.length === 0) {
        keptLine.setText("");
      } else {
        const shown = keptNames.slice(-12);
        const prefix = keptNames.length > 12 ? `+${keptNames.length - 12} more · ` : "";
        keptLine.setText(
          `${theme.fg("error", ICON_HEART)} ${theme.fg("muted", `Kept (${keptNames.length}): `)}${theme.fg("text", `${prefix}${shown.join(", ")}`)}`,
        );
      }

      if (rejecting) {
        const prompt =
          rejectNote.length > 0
            ? `${rejectNote}${theme.fg("warning", "▍")}`
            : theme.fg("dim", "why are they all wrong? (optional)");
        const escHint = rejectNote.length > 0 ? "esc back" : "esc cancel";
        footerLine.setText(
          `${theme.fg("warning", `Reject all ${candidates.length} — nothing kept from this round.`)}\n` +
            `${theme.fg("muted", "> ")}${prompt}  ${theme.fg("dim", `·  ⏎ reject  ·  ${escHint}`)}`,
        );
      } else if (selected.size > 0) {
        footerLine.setText(
          `${theme.fg("muted", "␣")} ${theme.fg("dim", "toggle")}  ${theme.fg("dim", "·")}  ` +
            `${theme.fg("muted", "⏎")} ${theme.fg("dim", `confirm (${selected.size})`)}  ${theme.fg("dim", "·")}  ` +
            `${theme.fg("muted", "esc")} ${theme.fg("dim", "react with a note")}  ${theme.fg("dim", "·")}  ` +
            `${theme.fg("muted", "↑↓")} ${theme.fg("dim", "move")}`,
        );
      } else {
        footerLine.setText(
          `${theme.fg("muted", "␣")} ${theme.fg("dim", "toggle")}  ${theme.fg("dim", "·")}  ` +
            `${theme.fg("muted", "⏎/esc")} ${theme.fg("dim", "react with a note")}  ${theme.fg("dim", "·")}  ` +
            `${theme.fg("muted", "↑↓")} ${theme.fg("dim", "move")}`,
        );
      }
      tui.requestRender();
    };

    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(headerLine);
    container.addChild(filterLine);
    container.addChild(keptLine);
    container.addChild(listView);
    container.addChild(footerLine);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    render();

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (rejecting) {
          if (matchesKey(data, Key.escape)) {
            if (rejectNote.length === 0) {
              finish(undefined);
            } else {
              rejecting = false;
              rejectNote = "";
              render();
            }
            return;
          }
          if (matchesKey(data, Key.enter)) {
            finish({
              kind: "rejected",
              names: candidates.map((c) => c.name),
              comment: rejectNote.trim(),
            });
            return;
          }
          if (matchesKey(data, Key.backspace)) {
            rejectNote = rejectNote.slice(0, -1);
            render();
            return;
          }
          if (matchesKey(data, Key.ctrl("u"))) {
            rejectNote = "";
            render();
            return;
          }
          if (/^[\x20-\x7e]+$/.test(data)) {
            rejectNote += data;
            render();
          }
          return;
        }
        if (matchesKey(data, Key.escape)) {
          rejecting = true;
          rejectNote = "";
          render();
          return;
        }
        if (matchesKey(data, Key.ctrl("r"))) {
          rejecting = true;
          rejectNote = "";
          render();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const rows = filtered();
          if (rows.length === 0) {
            finish(undefined);
            return;
          }
          if (selected.size === 0) {
            rejecting = true;
            rejectNote = "";
            render();
            return;
          }
          // Preserve candidate order in the result.
          finish({
            kind: "picked",
            names: candidates.map((c) => c.name).filter((name) => selected.has(name)),
          });
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
        if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
          cursor -= 1;
          render();
          return;
        }
        if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
          cursor += 1;
          render();
          return;
        }
        if (matchesKey(data, Key.pageUp)) {
          cursor -= PAGE_SIZE;
          render();
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          cursor += PAGE_SIZE;
          render();
          return;
        }
        if (matchesKey(data, Key.home)) {
          cursor = 0;
          render();
          return;
        }
        if (matchesKey(data, Key.end)) {
          cursor = Number.MAX_SAFE_INTEGER;
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
): Promise<PickOutcome | undefined> {
  const picks: string[] = [];
  for (const candidate of candidates) {
    const label = candidate.flavor ? `${candidate.name} (${candidate.flavor})` : candidate.name;
    const yes = await ctx.ui.confirm("Like this name?", label);
    if (yes) picks.push(candidate.name);
  }
  return { kind: "picked", names: picks };
}
