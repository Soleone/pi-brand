import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isCheckStale } from "./checker.ts";
import { availabilityKey, getAvailability } from "./store.ts";
import { compareScores, formatScore, needsCheck, SCORE_INFO, type AvailabilityScore } from "./scoring.ts";
import type { BrandState, Candidate } from "./types.ts";
import type { WorkspaceAction } from "./workspace.ts";

export interface FavoriteChange { name: string; roundId?: string; liked: boolean }
export interface WorkspacePosition { tab: "all" | "candidates" | "favorites" | "history"; cursor: number; roundId?: string; query?: string; marked?: string[]; focusName?: string; notice?: string; sort?: "recent" | "best" }
type ScreenAction = WorkspaceAction | { kind: "edit-brief" } | { kind: "annotations" } | { kind: "inputs" } | { kind: "settings" };
export interface WorkspaceScreenResult { action?: ScreenAction; favoriteChanges: FavoriteChange[] }

const PAGE_SIZE = 10;
const TABS = [["all", "All"], ["candidates", "Candidates"], ["favorites", " Favorites"]] as const;
type ListTab = (typeof TABS)[number][0];

/** Active labels keep their cell width so the strip never shifts between tabs. */
export function tabCell(label: string, active: boolean): string {
  return active ? `[${label}]` : ` ${label} `;
}

/** One color per assessment state: green usable, yellow caution, red clash, blue or gray needs a check. */
export function scoreColor(score: AvailabilityScore | undefined): Parameters<Theme["fg"]>[0] {
  switch (score) {
    case "perfect": return "success";
    case "good": return "text";
    case "decent": return "warning";
    case "bad": return "warning";
    case "terrible": return "error";
    case "review": return "warning";
    case "error": return "accent";
    case "unknown": return "muted";
    default: return "dim";
  }
}

/** Scores that read as green or yellow: conclusive, with no name clash or failed check. */
export function isCandidateScore(score: AvailabilityScore | undefined): boolean {
  return score === "perfect" || score === "good" || score === "decent" || score === "bad" || score === "review";
}

/** Pad terminal columns, not code units (names may contain wide or combining characters). */
export function nameCell(text: string, width: number): string {
  const clipped = truncateToWidth(text.replace(/[\r\n\t]/g, " "), Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function nameColumnWidth(names: Candidate[], width: number): number {
  return Math.max(4, Math.min(28, Math.max(12, ...names.map(entry => visibleWidth(entry.name))), width - (width >= 20 ? 16 : 4)));
}

export async function showNamingWorkspace(ctx: ExtensionContext, state: BrandState, position: WorkspacePosition): Promise<WorkspaceScreenResult> {
  return ctx.ui.custom<WorkspaceScreenResult>((tui, theme, _keys, done) => {
    const input = new Input({ prompt: "/ ", placeholder: "Search names…" });
    input.setValue(position.query ?? "");
    const favorites = new Set(state.liked.map(entry => availabilityKey(entry.name)));
    const changes = new Map<string, FavoriteChange>();
    const selectedNames = new Set(state.selected.map(availabilityKey));
    const discarded = new Set(state.dismissed.map(availabilityKey));
    const marked = new Set(position.marked ?? []);
    let notice = position.notice ?? "";
    delete position.notice;
    let historyReturn: ListTab = position.tab === "history" ? "all" : position.tab;
    let screen: "list" | "detail" | "brief" | "generate" | "similar" = "list";
    let searching = false;
    let focused = false;
    let detail: Candidate | undefined;
    let detailScroll = 0;
    let detailActions = false;
    const finish = (action?: ScreenAction) => {
      position.query = input.getValue();
      position.marked = [...marked];
      done({ action, favoriteChanges: [...changes.values()] });
    };
    const rounds = [...state.rounds].reverse();
    const activeRound = () => state.rounds.find(round => round.id === position.roundId) ?? state.rounds.at(-1);
    const assessmentScore = (entry: Candidate): Candidate["score"] => {
      const record = getAvailability(state, entry.name);
      return isCheckStale(record, state) ? "unknown" : record?.score ?? entry.score;
    };
    const entries = () => {
      const known = new Map([...rounds.flatMap(round => round.candidates), ...state.liked].map(entry => [availabilityKey(entry.name), entry]));
      for (const name of state.selected) if (!known.has(availabilityKey(name))) known.set(availabilityKey(name), { name });
      const active = [...known.values()].filter(entry => (position.tab === "favorites" ? favorites : selectedNames).has(availabilityKey(entry.name)));
      const source = position.tab === "all" && position.roundId
        ? activeRound()?.candidates ?? []
        : position.tab === "candidates"
          ? active.filter(entry => isCandidateScore(assessmentScore(entry)))
          : active;
      const filtered = source.filter(entry => `${entry.name} ${entry.flavor ?? ""}`.toLocaleLowerCase().includes(input.getValue().toLocaleLowerCase()));
      return position.sort === "best" ? filtered.sort((a, b) => compareScores(assessmentScore(a) ?? "unknown", assessmentScore(b) ?? "unknown")) : filtered;
    };
    const focusName = position.focusName;
    if (focusName) {
      position.cursor = Math.max(0, entries().findIndex(entry => availabilityKey(entry.name) === availabilityKey(focusName)));
      delete position.focusName;
    }
    const visibleNames = new Set(entries().map(entry => availabilityKey(entry.name)));
    for (const key of marked) if (!visibleNames.has(key)) marked.delete(key);
    const toggle = (entry: Candidate) => {
      const key = availabilityKey(entry.name);
      const liked = !favorites.has(key);
      if (liked) { favorites.add(key); selectedNames.add(key); discarded.delete(key); } else favorites.delete(key);
      changes.set(key, { name: entry.name, roundId: rounds.find(round => round.candidates.some(candidate => availabilityKey(candidate.name) === key))?.id, liked });
    };
    const selected = () => entries()[position.cursor];
    const setTab = (tab: WorkspacePosition["tab"]) => {
      position.tab = tab; position.cursor = 0; position.roundId = undefined; input.setValue(""); searching = false; marked.clear(); notice = "";
    };
    const isPending = (entry: Candidate) => needsCheck(assessmentScore(entry));
    const paint = (width: number): string[] => {
      const fg = (color: Parameters<Theme["fg"]>[0], text: string) => theme.fg(color, text);
      const remaining = [...changes.values()].some(change => change.liked !== state.liked.some(entry => availabilityKey(entry.name) === availabilityKey(change.name))) ? 0 : state.reserve.length;
      const rule = fg("borderMuted", "─".repeat(Math.max(0, width)));
      const lines = [` ${fg("accent", theme.bold(" Brand"))}  ${fg("dim", `${selectedNames.size} selected · ${favorites.size} ${favorites.size === 1 ? "favorite" : "favorites"} · Brief r${state.briefRevision}`)}`];
      if (screen === "list") {
        lines.push(" " + TABS.map(([tab, label]) => position.tab === tab ? fg("accent", theme.bold(tabCell(label, true))) : fg("muted", tabCell(label, false))).join("  "), rule);
        if (searching || input.getValue()) lines.push(...input.render(Math.max(1, width)));
        if (position.tab === "history") {
          position.cursor = Math.max(0, Math.min(position.cursor, rounds.length - 1));
          const start = Math.max(0, position.cursor - PAGE_SIZE + 1);
          lines.push(fg("dim", "   ROUND                 DATE         SOURCE     NAMES"));
          for (const [index, round] of rounds.slice(start, start + PAGE_SIZE).entries()) {
            const text = `${start + index === position.cursor ? " › " : "   "}${nameCell(round.id, 20)}  ${round.createdAt.slice(0, 10)}   ${nameCell(round.origin ?? "legacy", 9)} ${round.candidates.length}`;
            lines.push(start + index === position.cursor ? fg("accent", text) : text);
          }
          if (!rounds.length) lines.push(fg("muted", " No rounds yet. Press g to prepare generation."));        } else {
          const rows = entries();
          position.cursor = Math.max(0, Math.min(position.cursor, rows.length - 1));
          const start = Math.max(0, position.cursor - PAGE_SIZE + 1);
          const nameWidth = nameColumnWidth(rows, width);
          const assessment = width >= 20;
          lines.push(fg("dim", `  ${nameCell("NAME", nameWidth)}${assessment ? "    ASSESSMENT" : ""}${position.sort === "best" ? " · Best first" : ""}`));
          for (const [index, entry] of rows.slice(start, start + PAGE_SIZE).entries()) {
            const active = start + index === position.cursor;
            const score = assessmentScore(entry);
            const color = scoreColor(score);
            const key = availabilityKey(entry.name);
            const favorite = favorites.has(key) ? fg("warning", "") : discarded.has(key) ? fg("dim", "") : " ";
            const status = score ? `${score === "unknown" || score === "review" ? "" : ""} ${formatScore(score)}` : "—";
            const mark = marked.has(key) ? fg("accent", "") : " ";
            const name = nameCell(entry.name, nameWidth);
            lines.push(`${mark} ${active ? fg("accent", theme.bold(name)) : discarded.has(key) ? fg("dim", name) : name} ${favorite}${assessment ? `  ${fg(color, status)}` : ""}`);
          }
          if (!rows.length) lines.push(fg("muted", input.getValue() ? " No matches. / to change search; Esc clears it." : position.tab === "favorites" ? " No favorites yet. Press f on a name to star it." : position.tab === "candidates" ? " No possible candidates yet. Press c to check pending names or g to generate." : " No names yet. Press g to prepare generation."));
          if (position.tab === "favorites" && rows.length) lines.push(fg("dim", " e Export shortlist with findings and sources · no new research"));
          if (rows.length > PAGE_SIZE) lines.push(fg("dim", ` ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length}`));
          if (position.tab === "all" && position.roundId && activeRound()) lines.push(fg("dim", ` History: ${activeRound()!.id} · ${activeRound()!.origin ?? "legacy"} · brief r${activeRound()!.briefRevision ?? "?"}`));
          const checkActions = marked.size ? `${marked.size} marked · c Check marked · Shift+C Recheck marked · d Discard marked` : `c Check pending (${rows.filter(isPending).length}) · Shift+C Recheck all (${rows.length})`;
          lines.push(...wrapTextWithAnsi(checkActions, Math.max(1, width - 2)).map(line => fg("muted", ` ${line}`)));
          if (rows.some(entry => getAvailability(state, entry.name)?.score === "unknown")) {
            lines.push(...wrapTextWithAnsi("Older incomplete results need a fresh check. Press c to update them.", Math.max(1, width - 2)).map(line => fg("warning", ` ${line}`)));
          }
        }
        if (notice) lines.push(...wrapTextWithAnsi(notice, Math.max(1, width - 2)).map(line => fg("warning", ` ${line}`)));
        lines.push(rule);
        for (const hint of [
          position.tab === "history" ? " h/Esc back · ↑↓ move · Enter open round" : " Tab/←→ tabs · h history · ↑↓ move · Enter details · Space mark · a all · s sort",
          position.tab === "history" ? " b brief · g generate" : ` f ${marked.size ? "favorite marked" : "favorite"} · d discard · / search · n add · b brief · g generate · Esc back`,
        ]) lines.push(...wrapTextWithAnsi(fg("dim", hint), Math.max(1, width)));
      } else if (screen === "brief") {
        const content = [
          theme.bold("Naming brief"), state.product || "No product description yet.", "",
          theme.bold("Explore"), state.brief.direction || "Open exploration", "",
          theme.bold("Avoid"), state.brief.avoid || "Nothing specified", "",
          theme.bold("Style"), state.brief.style,
          `Examples: ${state.brief.examples.join(", ") || "none"}`,
          `${state.brief.singleWord ? "Single word" : "Multiple words allowed"} · max ${state.brief.maxLength} characters`,
        ].flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 2)));
        detailScroll = Math.min(detailScroll, Math.max(0, content.length - 12));
        lines.push(rule, ...content.slice(detailScroll, detailScroll + 12).map(line => ` ${line}`), rule,
          fg("dim", " e edit brief · f give feedback (AI) · h feedback history"), fg("dim", " i generation inputs · s settings · ↑↓ scroll · b/Esc back"));
      } else if (screen === "generate") {
        lines.push(rule, fg("accent", " Generate names"), ` Active brief: r${state.briefRevision}`,
          ...wrapTextWithAnsi(` ${state.brief.direction || state.product || "Set a product brief before generating."}`, Math.max(1, width)).slice(0, 3),
          ` Taste: ${favorites.size} favorites + ${state.brief.examples.length} brief examples. Selected names are not taste references.`,
          remaining ? ` Show remaining pool: ${remaining} names available. No new model call.` : ` New pool with ${state.model}. Up to 45 seconds.`, rule,
          fg("dim", ` Enter ${remaining ? "show next batch" : "start generation"} · b inspect brief · Esc back`));
      } else if (screen === "similar") {
        lines.push(rule, fg("accent", " Refine toward this name"), ` ${detail?.name ?? ""}`,
          " AI updates the brief toward this name. It does not generate yet.",
          " Unrelated brief instructions are preserved.", rule, fg("dim", " Enter start · Esc back"));
      } else if (detail) {
        const record = getAvailability(state, detail.name);
        const saved = favorites.has(availabilityKey(detail.name));
        const contentWidth = Math.max(1, Math.min(width - 2, 86));
        const title = `${fg("muted", position.tab === "favorites" ? "Favorites /" : position.tab === "candidates" ? "Candidates /" : position.roundId ? "History /" : "All /")} ${fg("accent", theme.bold(detail.name))}  ${saved ? fg("warning", " Favorite") : fg("dim", discarded.has(availabilityKey(detail.name)) ? "Discarded" : selectedNames.has(availabilityKey(detail.name)) ? "Selected" : "History")}`;
        lines.splice(0, 1, ...wrapTextWithAnsi(title, contentWidth).map(line => ` ${line}`));
        if (detail.flavor) lines.push(...wrapTextWithAnsi(detail.flavor, contentWidth).map(line => ` ${line}`));
        lines.push("");
        const content: string[] = [];
        const field = (label: string, value: string) => {
          const stacked = contentWidth < 36;
          const wrapped = wrapTextWithAnsi(value, Math.max(1, contentWidth - (stacked ? 0 : 13)));
          if (stacked) content.push(fg("muted", label), ...wrapped);
          else content.push(...wrapped.map((line, index) => `${fg("muted", nameCell(index === 0 ? label : "", 13))}${line}`));
        };
        const score = record?.score ?? detail.score;
        const color = scoreColor(score);
        field("Availability", isCheckStale(record, state) ? fg("warning", `Outdated · ${formatScore(score)}`) : score ? fg(color, formatScore(score)) : "Not checked");
        const reason = record?.reason ?? detail.scoreReason;
        if (reason) field("Finding", reason);
        if (isCheckStale(record, state)) field("Next step", "Product or lookup requirements changed. Press c to update this finding.");
        else if (score) field("Next step", SCORE_INFO[score].nextStep);
        if (record?.model) field("Model", record.model);
        if (record) field("Checked", `${record.stage === "screen" ? "Quick screen" : record.stage === "deep" ? "Deep check" : "Legacy"} · ${record.checkedAt}`);
        for (const warning of record?.warnings ?? []) field("Warning", fg("warning", warning));
        if (record) {
          content.push("");
          field("Evidence", record.evidence?.length ? `${record.evidence.length} ${record.evidence.length === 1 ? "source" : "sources"}` : "No retained sources");
          for (const query of record.searchQueries ?? []) field("Search", query);
          for (const source of record.evidence ?? []) {
            field(source.source, source.detail);
            field("", fg("dim", source.url));
          }
        }
        detailScroll = Math.min(detailScroll, Math.max(0, content.length - 10));
        lines.push(...content.slice(detailScroll, detailScroll + 10).map(line => ` ${line}`));
        if (content.length > 10) lines.push(fg("dim", ` ${detailScroll + 1}–${Math.min(detailScroll + 10, content.length)} of ${content.length} · ↑↓ scroll`));
        if (record || score) lines.push("", ...wrapTextWithAnsi(fg("dim", "Preliminary findings, not trademark clearance."), contentWidth).map(line => ` ${line}`));
        lines.push("", fg("borderMuted", "─".repeat(Math.min(width, 88))));
        const actions: [string, string][] = [["Space", saved ? "Remove favorite" : "Save favorite"], ["c", score === "error" ? "Retry check" : "Check availability"], ["m", "More like this"], ["?", detailActions ? "Fewer actions" : "More actions"]];
        if (detailActions) actions.push(["r", "Refresh check"], ["x", "Quick screen"], ["d", "Discard name"]);
        if (!selectedNames.has(availabilityKey(detail.name))) actions.push(["s", "Restore to list"]);
        actions.push(["Esc", "Back"]);
        const columns = contentWidth >= 62 ? 2 : 1;
        for (let index = 0; index < actions.length; index += columns) {
          const row = actions.slice(index, index + columns).map(([key, label]) => `${fg("accent", nameCell(key, 6))}${fg("muted", nameCell(label, columns === 2 ? 24 : Math.max(1, contentWidth - 6)))}`).join("  ");
          lines.push(` ${row}`);
        }
      }
      return lines.map(line => truncateToWidth(line, Math.max(0, width), "…"));
    };
    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = value && searching; },
      render: paint,
      invalidate() { input.invalidate(); },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("c"))) { finish(); return; }
        const escape = matchesKey(data, Key.escape);
        const enter = matchesKey(data, Key.enter);
        const forceCheck = data === "C" || matchesKey(data, Key.shift("c"));
        if (searching) {
          if (escape || enter) searching = false;
          else { input.handleInput(data); position.cursor = 0; marked.clear(); notice = ""; }
        } else if (escape) {
          if (screen !== "list") screen = "list";
          else if (marked.size) marked.clear();
          else if (input.getValue()) { input.setValue(""); position.cursor = 0; }
          else if (position.roundId) setTab("all");
          else if (position.tab === "history") setTab(historyReturn);
          else { finish(); return; }
        } else if (screen === "generate") {
          if (enter) { finish({ kind: "more" }); return; }
          if (data === "b") { screen = "brief"; detailScroll = 0; }
        } else if (screen === "similar") {
          if (enter && detail) { finish({ kind: "similar", name: detail.name }); return; }
        } else if (screen === "brief") {
          if (data === "b") screen = "list";
          else if (data === "e") { finish({ kind: "edit-brief" }); return; }
          else if (data === "f") { finish({ kind: "feedback" }); return; }
          else if (data === "h") { finish({ kind: "annotations" }); return; }
          else if (data === "i") { finish({ kind: "inputs" }); return; }
          else if (data === "s") { finish({ kind: "settings" }); return; }
          else if (matchesKey(data, Key.down)) detailScroll++;
          else if (matchesKey(data, Key.up)) detailScroll = Math.max(0, detailScroll - 1);
        } else if (screen === "detail" && detail) {
          if (data === "?") detailActions = !detailActions;
          else if (data === " " || data === "f") toggle(detail);
          else if (["c", "r", "x"].includes(data)) {
            finish({ kind: "check", names: [detail.name], stage: data === "x" ? "screen" : "deep", refresh: data === "r" }); return;
          }
          else if (data === "m") screen = "similar";
          else if (data === "d") { finish({ kind: "discard", names: [detail.name] }); return; }
          else if (data === "s") { finish({ kind: "select", names: [detail.name] }); return; }
          else if (matchesKey(data, Key.down)) detailScroll++;
          else if (matchesKey(data, Key.up)) detailScroll = Math.max(0, detailScroll - 1);
        } else {
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.left)) {
            if (position.tab === "history") setTab(historyReturn);
            else {
              const index = TABS.findIndex(([tab]) => tab === position.tab);
              setTab(TABS[(index + (matchesKey(data, Key.left) ? TABS.length - 1 : 1)) % TABS.length]![0]);
            }
          } else if (data === "/" && position.tab !== "history") searching = true;
          else if (data === "h") {
            if (position.tab === "history") setTab(historyReturn);
            else { historyReturn = position.tab; setTab("history"); }
          }
          else if ((data === "n" || data === "N" || matchesKey(data, Key.shift("n"))) && position.tab !== "history") {
            finish({ kind: "add" }); return;
          }
          else if (data === "g") screen = "generate";
          else if (data === "b") { screen = "brief"; detailScroll = 0; }
          else if ((data === "c" || forceCheck) && position.tab !== "history") {
            const targets = entries().filter(entry => marked.size ? marked.has(availabilityKey(entry.name)) : forceCheck || isPending(entry));
            if (targets.length) {
              finish({ kind: "check", names: targets.map(entry => entry.name), stage: "deep", refresh: forceCheck, batch: true, uncheckedOnly: !marked.size && !forceCheck }); return;
            }
            notice = "No pending checks. Enter reads findings; Shift+C rechecks explicitly.";
          } else if (data === "s" && position.tab !== "history") {
            const name = selected()?.name;
            position.sort = position.sort === "best" ? "recent" : "best";
            position.cursor = Math.max(0, entries().findIndex(entry => entry.name === name));
            notice = position.sort === "best" ? "Best findings first. Unchecked and failed names follow assessed names." : "Recent order restored.";
          } else if (data === "e" && position.tab === "favorites") {
            finish({ kind: "export" }); return;
          } else if (data === "a" && position.tab !== "history") {
            const rows = entries();
            if (rows.length && rows.every(entry => marked.has(availabilityKey(entry.name)))) marked.clear();
            else for (const entry of rows) marked.add(availabilityKey(entry.name));
          } else if (data === "f" && position.tab !== "history") {
            const focusKey = availabilityKey(selected()?.name ?? "");
            const targets = entries().filter(entry => marked.size ? marked.has(availabilityKey(entry.name)) : availabilityKey(entry.name) === focusKey);
            const promote = !targets.every(entry => favorites.has(availabilityKey(entry.name)));
            for (const entry of targets) if (favorites.has(availabilityKey(entry.name)) !== promote) toggle(entry);
          }
          else if (data === "d" && position.tab !== "history") {
            const focusKey = availabilityKey(selected()?.name ?? "");
            const targets = entries().filter(entry => marked.size ? marked.has(availabilityKey(entry.name)) : availabilityKey(entry.name) === focusKey);
            if (targets.length) { finish({ kind: "discard", names: targets.map(entry => entry.name) }); return; }
          }
          else if (matchesKey(data, Key.up)) position.cursor--;
          else if (matchesKey(data, Key.down)) position.cursor++;
          else if (matchesKey(data, Key.pageUp)) position.cursor -= PAGE_SIZE;
          else if (matchesKey(data, Key.pageDown)) position.cursor += PAGE_SIZE;
          else if (enter && position.tab === "history") {
            const round = rounds[position.cursor];
            if (round) { setTab("all"); position.roundId = round.id; }
          } else if (enter && selected()) { detail = selected(); detailScroll = 0; detailActions = false; screen = "detail"; }
          else if (data === " " && position.tab !== "history" && selected()) {
            const key = availabilityKey(selected()!.name);
            if (marked.has(key)) marked.delete(key); else marked.add(key);
          }
        }
        const count = position.tab === "history" ? rounds.length : entries().length;
        position.cursor = Math.max(0, Math.min(position.cursor, count - 1));
        input.focused = focused && searching;
        tui.requestRender();
      },
    };
  });
}
