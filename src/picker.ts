import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatScore } from "./scoring.ts";
import type { Candidate } from "./types.ts";

export interface PickOptions {
  title?: string;
  product?: string;
  /** Names kept from earlier rounds, shown so picks read as accumulating, not resetting. */
  likedSoFar?: string[];
  direction?: string;
  /** How many of this round's candidates were dropped as already seen. */
  droppedDuplicates?: string[];
  /** Total names permanently excluded in this project, for the header tally. */
  excludedTotal?: number;
  selectionOnly?: boolean;
  maxSelection?: number;
  initialNames?: string[];
}

type PickerContext = ExtensionContext | ExtensionCommandContext;

/** What the picker resolved to: keeps, a whole-round rejection, or a chosen next step. */
export type PickAction = "more-same" | "more-new" | "check" | "overview";

export type PickOutcome =
  | { kind: "picked"; names: string[] }
  | { kind: "rejected"; names: string[]; comment: string }
  | { kind: "action"; action: PickAction; names: string[]; note?: string };

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

/**
 * One- or two-line text block that truncates instead of wrapping, so a long
 * product name or action row can never spill over and misalign the picker.
 */
function makeLine(pad = 1): { setText(text: string): void; invalidate(): void; render(width: number): string[] } {
  let text = "";
  return {
    setText: (next: string) => {
      text = next;
    },
    invalidate: () => {},
    render: (width: number): string[] => {
      if (!text) return [];
      const inner = Math.max(1, width - pad * 2);
      const margin = " ".repeat(pad);
      return text.split("\n").map((line) => margin + truncateToWidth(line, inner, "…"));
    },
  };
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
 * toggled picks, and the digit keys on the action row switch to the next step
 * in one press: 1 more names same direction, 2 new direction (asks for a
 * note), 3 choose finalists and check, 0 save picks and return to overview.
 * Digits are free because candidate names never
 * contain them. Esc opens the react prompt (type a note, Enter rejects the
 * round, Esc on an empty note cancels); Enter with nothing toggled does too.
 * Enter never auto-picks the highlighted row.
 */
export async function pickNames(
  ctx: PickerContext,
  candidates: Candidate[],
  options: PickOptions = {},
): Promise<PickOutcome | undefined> {
  if (candidates.length === 0) return undefined;
  if (!ctx.hasUI) return undefined;

  const ui = ctx.ui;
  if (ctx.mode !== "tui" || typeof ui.custom !== "function") {
    return await selectLoopFallback(ctx, candidates, options);
  }

  const title = options.title ?? "Pick favorites";
  const alreadyLiked = new Set((options.likedSoFar ?? []).map((name) => name.toLocaleLowerCase()));
  const keptNames = (options.likedSoFar ?? []).map((name) => name.trim()).filter(Boolean);
  const hasScores = candidates.some((candidate) => candidate.score !== undefined);

  // Fixed column widths so rows stay aligned while filtering.
  const nameWidth = Math.max(4, ...candidates.map((c) => visibleWidth(c.name)));
  const scoreWidth = Math.max(8, ...candidates.map((c) => visibleWidth(formatScore(c.score))));

  return await ui.custom<PickOutcome | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const headerLine = makeLine();
    const filterLine = makeLine();
    const keptLine = makeLine();
    const actionLine = makeLine();
    const footerLine = makeLine();

    let query = "";
    let cursor = 0;
    let scroll = 0;
    const available = new Set(candidates.map((candidate) => candidate.name));
    const selected = new Set((options.initialNames ?? []).filter((name) => available.has(name)).slice(0, options.maxSelection ?? candidates.length));
    let selectionWarning = "";
    let finished = false;
    // "reject" nukes the round, "direction" keeps the picks and pivots.
    let noteMode: "none" | "reject" | "direction" = "none";
    let noteText = "";

    const selectedNames = (): string[] =>
      candidates.map((c) => c.name).filter((name) => selected.has(name));

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
      const scoreCell = hasScores ? `  ${theme.fg(scoreColor(candidate.score), paddedScore)}` : "";

      const liked = alreadyLiked.has(candidate.name.toLocaleLowerCase());
      const styleSuffix = candidate.style ? `  ${theme.fg("dim", `· ${candidate.style}`)}` : "";
      const heartSuffix = liked ? ` ${theme.fg("error", ICON_HEART)}` : "";
      const suffixWidth = visibleWidth(
        `${candidate.style ? `  · ${candidate.style}` : ""}${liked ? " ♥" : ""}`,
      );

      const prefixWidth = 1 + 1 + 1 + 1 + nameWidth + (hasScores ? 2 + scoreWidth : 0) + 2;
      const maxFlavor = Math.max(0, contentWidth - prefixWidth - suffixWidth);
      let flavorCell = "";
      if (candidate.flavor && maxFlavor > 0) {
        const truncated = truncateToWidth(candidate.flavor, maxFlavor, "…");
        flavorCell = theme.fg("muted", truncated);
      }

      return `${cursorCell} ${checkCell} ${nameCell}${scoreCell}  ${flavorCell}${styleSuffix}${heartSuffix}`;
    };

    // Custom list component so rows can truncate to the live viewport width
    // instead of wrapping and breaking column alignment.
    const listView = {
      render: (width: number): string[] => {
        const rows = filtered();
        clampCursor(rows);
        const contentWidth = Math.max(1, width - 2);
        if (rows.length === 0) {
          return [truncateToWidth(` ${theme.fg("warning", "No matches. Backspace to clear the filter.")}`, width, "…")];
        }
        const visible = rows.slice(scroll, scroll + PAGE_SIZE);
        const lines = visible.map((candidate, index) =>
          truncateToWidth(` ${renderRow(candidate, scroll + index === cursor, contentWidth)}`, width, "…"),
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
          : theme.fg("dim", `${ICON_UNCHECKED} none picked`);
      const header = theme.bold(title);
      const dups = options.droppedDuplicates ?? [];
      const tally: string[] = [];
      if (options.excludedTotal && options.excludedTotal > 0) {
        tally.push(
          `${options.excludedTotal} excluded${dups.length > 0 ? ` · ${dups.length} of yours were dups` : ""}`,
        );
      }
      // Counts come before the product line: if the row has to truncate, it
      // should lose the decorative description, not the state summary.
      const tail = [
        options.product ? theme.fg("dim", options.product) : "",
      ].filter(Boolean);
      headerLine.setText(
        [header, countCell, ...tally.map((text) => theme.fg("dim", text)), ...tail]
          .filter(Boolean)
          .join(theme.fg("dim", "  ·  ")),
      );

      const filterIcon = theme.fg("muted", `${ICON_SEARCH} `);
      filterLine.setText(
        query
          ? `${filterIcon}${query}${theme.fg("accent", "▍")}${theme.fg("dim", `  ·  ${rows.length}/${candidates.length}`)}`
          : `${filterIcon}${theme.fg("dim", "type to filter…")}`,
      );

      if (keptNames.length === 0) {
        keptLine.setText("");
      } else {
        const shown = keptNames.slice(-6);
        const prefix = keptNames.length > 6 ? `+${keptNames.length - 6} more · ` : "";
        keptLine.setText(
          `${theme.fg("error", ICON_HEART)} ${theme.fg("muted", `Favorites (${keptNames.length}): `)}${theme.fg("text", `${prefix}${shown.join(", ")}`)}`,
        );
      }

      const availabilityLabel = "choose up to 3 finalists";

      const key = (label: string): string => theme.fg("accent", label);
      const sep = theme.fg("dim", "  ·  ");

      if (options.selectionOnly) {
        actionLine.setText(`Save up to ${options.maxSelection ?? 3} finalists. ${selected.size} selected.`);
        footerLine.setText(selectionWarning || "Space: toggle · Enter: save · Esc: cancel · Type: filter");
      } else if (noteMode === "none") {
        actionLine.setText(
          `${key("⏎")} ${theme.fg("dim", selected.size > 0 ? `save ${selected.size}` : "reject round")}${sep}` +
            `${key("1")} ${theme.fg("dim", "more")}${sep}${key("2")} ${theme.fg("dim", "direction…")}\n` +
            `${key("3")} ${theme.fg("dim", availabilityLabel)}${sep}${key("4")} ${theme.fg("dim", "more like highlighted")}\n` +
            `${key("0")} ${theme.fg("dim", "overview: save picks, reserve the rest")}`,
        );
        footerLine.setText(
          `${theme.fg("muted", "␣")} ${theme.fg("dim", "toggle")}  ${theme.fg("dim", "·")}  ` +
            `${theme.fg("muted", "↑↓")} ${theme.fg("dim", "move")}  ${theme.fg("dim", "·")}  ` +
            `${theme.fg("muted", "type")} ${theme.fg("dim", "filter")}  ${theme.fg("dim", "·")}  ` +
            `${theme.fg("muted", "esc")} ${theme.fg("dim", "reject round with a note")}`,
        );
      } else {
        const askingDirection = noteMode === "direction";
        const prompt =
          noteText.length > 0
            ? `${noteText}${theme.fg(askingDirection ? "accent" : "warning", "▍")}`
            : theme.fg(
                "dim",
                askingDirection
                  ? "what should change? e.g. less cute, more verb-able"
                  : "why are they all wrong? (optional)",
              );
        actionLine.setText(
          askingDirection
            ? `${theme.fg("accent", `New direction: ${selected.size} kept${noteText ? "" : " (empty = same direction)"}.`)}\n` +
                `${theme.fg("muted", "> ")}${prompt}`
            : `${theme.fg("warning", `Reject all ${candidates.length}: nothing kept from this round.`)}\n` +
                `${theme.fg("muted", "> ")}${prompt}`,
        );
        const escHint = askingDirection || noteText.length > 0 ? "back" : "cancel";
        footerLine.setText(
          `${theme.fg("muted", "⏎")} ${theme.fg("dim", askingDirection ? "generate" : "reject")}  ` +
            `${theme.fg("dim", "·")}  ${theme.fg("muted", `esc ${escHint}`)}`,
        );
      }
      tui.requestRender();
    };

    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(headerLine);
    container.addChild(filterLine);
    container.addChild(keptLine);
    container.addChild(listView);
    container.addChild(actionLine);
    container.addChild(footerLine);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    render();

    return {
      render: (width) => container.render(width).map((line) => truncateToWidth(line, Math.max(0, width), "…")),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (noteMode !== "none") {
          if (matchesKey(data, Key.escape)) {
            if (noteMode === "direction" || noteText.length > 0) {
              noteMode = "none";
              noteText = "";
              render();
            } else {
              finish(undefined);
            }
            return;
          }
          if (matchesKey(data, Key.enter)) {
            const note = noteText.trim();
            if (noteMode === "direction") {
              finish(
                note
                  ? { kind: "action", action: "more-new", names: selectedNames(), note }
                  : { kind: "action", action: "more-same", names: selectedNames() },
              );
            } else {
              finish({ kind: "rejected", names: candidates.map((c) => c.name), comment: note });
            }
            return;
          }
          if (matchesKey(data, Key.backspace)) {
            noteText = noteText.slice(0, -1);
            render();
            return;
          }
          if (matchesKey(data, Key.ctrl("u"))) {
            noteText = "";
            render();
            return;
          }
          if (/^[\x20-\x7e]+$/.test(data)) {
            noteText += data;
            render();
          }
          return;
        }
        if (matchesKey(data, Key.escape)) {
          if (options.selectionOnly) { finish(undefined); return; }
          noteMode = "reject";
          noteText = "";
          render();
          return;
        }
        if (!options.selectionOnly && matchesKey(data, Key.ctrl("r"))) {
          noteMode = "reject";
          noteText = "";
          render();
          return;
        }
        // Digits are navigation keys, not part of name filters.
        if (!options.selectionOnly && data === "0") {
          finish({ kind: "action", action: "overview", names: selectedNames() });
          return;
        }
        if (!options.selectionOnly && data === "1") {
          finish({ kind: "action", action: "more-same", names: selectedNames() });
          return;
        }
        if (!options.selectionOnly && data === "2") {
          noteMode = "direction";
          noteText = "";
          render();
          return;
        }
        if (!options.selectionOnly && data === "3") {
          finish({ kind: "action", action: "check", names: selectedNames() });
          return;
        }
        if (!options.selectionOnly && data === "4") {
          const current = filtered()[cursor];
          if (current) finish({ kind: "action", action: "more-new", names: [...new Set([...selectedNames(), current.name])], note: `More like "${current.name}" in meaning and feel. ${options.direction ?? "Keep the existing spelling and word constraints."}` });
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const rows = filtered();
          if (rows.length === 0) {
            finish(undefined);
            return;
          }
          if (selected.size === 0 && !options.selectionOnly) {
            noteMode = "reject";
            noteText = "";
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
            if (selected.has(current.name)) { selected.delete(current.name); selectionWarning = ""; }
            else if (options.maxSelection && selected.size >= options.maxSelection) {
              selectionWarning = `At most ${options.maxSelection} finalists. Deselect one first.`;
            } else { selected.add(current.name); selectionWarning = ""; }
            if (!selectionWarning && cursor < rows.length - 1) cursor += 1;
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

/** RPC supports select dialogs but not custom terminal components. */
async function selectLoopFallback(ctx: PickerContext, candidates: Candidate[], options: PickOptions): Promise<PickOutcome | undefined> {
  const picks = [...new Set(options.initialNames ?? [])].filter((name) => candidates.some((candidate) => candidate.name === name)).slice(0, options.maxSelection ?? candidates.length);
  const finish = "Save selection";
  const overview = "Overview: save picks, reserve the rest";
  const more = "More names";
  const direction = "Change direction";
  const finalists = "Choose finalists";
  const similar = "More like a name";
  const reject = "Reject round with a note";
  while (true) {
    const actions = options.selectionOnly ? [] : [overview, more, direction, finalists, similar, reject];
    const choices = [finish, ...actions, ...candidates.map((candidate) => `${picks.includes(candidate.name) ? "[x]" : "[ ]"} ${candidate.name}`)];
    const choice = await ctx.ui.select(options.title ?? "Pick favorites", choices);
    if (!choice) return undefined;
    if (choice === finish) return { kind: "picked", names: picks };
    if (!options.selectionOnly) {
      if (choice === overview) return { kind: "action", action: "overview", names: picks };
      if (choice === more) return { kind: "action", action: "more-same", names: picks };
      if (choice === finalists) return { kind: "action", action: "check", names: picks };
      if (choice === direction || choice === reject) {
        const note = await ctx.ui.input(choice === direction ? "What should change?" : "Why reject this round? (optional)");
        if (note === undefined) continue;
        if (choice === reject) return { kind: "rejected", names: candidates.map((candidate) => candidate.name), comment: note };
        return { kind: "action", action: note.trim() ? "more-new" : "more-same", names: picks, note: note.trim() };
      }
      if (choice === similar) {
        const name = await ctx.ui.select("More like which name?", candidates.map((candidate) => candidate.name));
        if (!name) continue;
        return { kind: "action", action: "more-new", names: [...new Set([...picks, name])], note: `More like "${name}" in meaning and feel. ${options.direction ?? "Keep the existing spelling and word constraints."}` };
      }
    }
    const candidate = candidates.find((entry) => choice === `[${picks.includes(entry.name) ? "x" : " "}] ${entry.name}`);
    if (!candidate) continue;
    const index = picks.indexOf(candidate.name);
    if (index >= 0) picks.splice(index, 1);
    else if (!options.maxSelection || picks.length < options.maxSelection) picks.push(candidate.name);
    else ctx.ui.notify(`Choose at most ${options.maxSelection} finalists. Deselect one first.`, "warning");
  }
}
