import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyBrandState, type BrandState } from "../src/types.ts";
import { nameCell, nameColumnWidth, showNamingWorkspace, type WorkspacePosition, type WorkspaceScreenResult } from "../src/workspace-ui.ts";

function fixture(): BrandState {
  const state = emptyBrandState("A delight-first todo app");
  state.brief.direction = "Task center and headquarters";
  state.brief.avoid = "Obscure dictionary words";
  state.rounds.push({ id: "round-1", createdAt: "2026-10-19T00:00:00Z", product: state.product, origin: "generated", briefRevision: 2,
    candidates: [{ name: "TaskHQ" }, { name: "A much longer name" }, { name: "仕事" }, { name: "Cafe\u0301" }] });
  state.selected = state.rounds[0]!.candidates.map(entry => entry.name);
  state.liked.push({ name: "TaskHQ", likedAt: "2026-10-19T00:00:00Z" });
  state.availability.taskhq = { score: "good", reason: "Some unrelated usage", stage: "deep", checkedAt: "2026-10-19T00:00:00Z" };
  return state;
}

async function run(keys: string[], options: { state?: BrandState; widths?: number[]; position?: WorkspacePosition } = {}) {
  const frames: string[][] = [];
  let result: WorkspaceScreenResult | undefined;
  const ctx = { ui: { custom: async (factory: Function) => {
    const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, (value: WorkspaceScreenResult) => { result = value; });
    const render = () => {
      for (const width of options.widths ?? [80]) {
        const lines: string[] = component.render(width);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
        frames.push(lines);
      }
    };
    render();
    for (const key of keys) {
      assert.equal(result, undefined, "keys supplied after the screen finished");
      component.handleInput(key); render();
    }
    assert.ok(result, "screen must complete");
    return result;
  } } } as unknown as ExtensionContext;
  await showNamingWorkspace(ctx, options.state ?? fixture(), options.position ?? { tab: "names", cursor: 0 });
  return { result: result!, frames };
}

const esc = "\x1b";
const down = "\x1b[B";

test("workspace opens on a compact name table, not the brief or a filter input", async () => {
  const { frames } = await run([esc]);
  const screen = frames[0]!.join("\n");
  assert.match(screen, /NAME.*ASSESSMENT/);
  assert.match(screen, /TaskHQ\s+\s+ good/);
  assert.match(screen, /A much longer name\s+—/);
  const table = frames[0]!.filter(line => /NAME|TaskHQ|A much longer name|仕事|Cafe/.test(line)).join("\n");
  assert.doesNotMatch(table, /STATE|CHECK|selected|favorite|not checked|deep/);
  assert.doesNotMatch(screen, /delight-first|Task center|Obscure dictionary|Filter:/);
  assert.ok(frames[0]!.length <= 12);
});

test("columns use display width, are capped, and never overflow during navigation or resizing", async () => {
  assert.equal(visibleWidth(nameCell("仕事", 8)), 8);
  assert.equal(visibleWidth(nameCell("Cafe\u0301", 8)), 8);
  assert.equal(visibleWidth(nameCell("A long name", 5)), 5);
  assert.equal(nameColumnWidth([{ name: "x".repeat(60) }], 100), 28);
  await run([down, down, "\r", down, esc, "b", down, esc, esc], { widths: [1, 12, 24, 41, 42, 61, 62, 80, 120] });
  const { frames } = await run([down, down, esc]);
  const rows = frames[0]!.filter(line => /TaskHQ|A much longer name/.test(line));
  assert.ok(rows.every(row => row.startsWith("  ")));
  assert.doesNotMatch(frames[0]!.join("\n"), /\[ \]|\[x\]|›/);
  const header = frames[0]!.find(line => line.includes("ASSESSMENT"))!;
  assert.equal(header.indexOf("ASSESSMENT"), rows[1]!.indexOf("—"));
  assert.equal(header.indexOf("ASSESSMENT"), rows[0]!.indexOf(""));
});

test("compact assessments retain short labels and favorites remain independent of marks", async () => {
  const state = fixture();
  const scores = ["perfect", "good", "decent", "bad", "terrible", "unknown"] as const;
  state.rounds[0]!.candidates = scores.map((score, index) => ({ name: `Name${index}`, score }));
  state.selected = state.rounds[0]!.candidates.map(entry => entry.name);
  state.liked = [{ name: "Name0", likedAt: "2026-10-19", score: "perfect" }];
  const { frames } = await run([" ", "f", esc, esc], { state, widths: [24, 42, 80] });
  for (const score of scores) assert.match(frames[2]!.join("\n"), new RegExp(`${score === "unknown" ? "" : ""} ${score}`));
  assert.match(frames[5]!.find(line => line.includes("Name0"))!, /^ Name0\s+/);
  assert.doesNotMatch(frames[8]!.find(line => line.includes("Name0"))!, //);
  const history = fixture(); history.dismissed = ["仕事"]; history.selected = history.selected.filter(name => name !== "仕事");
  const discarded = await run([esc, esc], { state: history, position: { tab: "names", cursor: 0, roundId: "round-1" } });
  assert.match(discarded.frames[0]!.find(line => line.includes("仕事"))!, /仕事\s+\s+—/);
});

test("Enter opens details and navigation never triggers generation or checks", async () => {
  const { result, frames } = await run(["\r", "\r", esc, "\t", "\r", esc, "\t", "\r", "1", "2", "3", esc, esc]);
  assert.equal(result.action, undefined);
  assert.deepEqual(result.favoriteChanges, []);
  assert.ok(frames.some(lines => lines.some(line => /Some unrelated usage/.test(line))));
});

test("bulk marks are temporary and checks never promote names to favorites", async () => {
  const { result, frames } = await run([" ", down, " ", "c"]);
  assert.deepEqual(result.action, { kind: "check", names: ["TaskHQ", "A much longer name"], stage: "deep", refresh: false, batch: true, uncheckedOnly: false });
  assert.deepEqual(result.favoriteChanges, []);
  assert.match(frames[3]!.join("\n"), /2 marked.*Check marked.*Discard marked/);
  assert.ok(frames[3]!.find(line => line.includes("NAME"))!.startsWith("  NAME"));
  assert.ok(frames[3]!.find(line => line.includes("TaskHQ"))!.startsWith(" TaskHQ"));
  assert.ok(frames[3]!.find(line => line.includes("A much longer name"))!.startsWith(" A much longer name"));
  assert.ok(frames[3]!.find(line => line.includes("仕事"))!.startsWith("  仕事"));
  const markedRows = frames[3]!.filter(line => /TaskHQ|A much longer name/.test(line));
  const header = frames[3]!.find(line => line.includes("ASSESSMENT"))!;
  assert.equal(visibleWidth(markedRows[0]!.slice(0, markedRows[0]!.indexOf(""))), visibleWidth(header.slice(0, header.indexOf("ASSESSMENT"))));
  const discarded = await run([" ", down, " ", "d"]);
  assert.deepEqual(discarded.result.action, { kind: "discard", names: ["TaskHQ", "A much longer name"] });
  assert.deepEqual(discarded.result.favoriteChanges, []);
});

test("check unchecked targets the current list; Shift+C explicitly refreshes all", async () => {
  const unchecked = await run(["c"]);
  assert.deepEqual(unchecked.result.action, { kind: "check", names: ["A much longer name", "仕事", "Cafe\u0301"], stage: "deep", refresh: false, batch: true, uncheckedOnly: true });
  const refreshed = await run(["C"]);
  assert.equal(refreshed.result.action?.kind, "check");
  assert.ok("names" in refreshed.result.action! && refreshed.result.action.names?.length === 4);
  assert.ok("refresh" in refreshed.result.action! && refreshed.result.action.refresh);
  assert.doesNotMatch(refreshed.frames.flat().join("\n"), /Enter start|Check availability/);
  const filtered = await run(["/", "仕事", "\r", "a", "c"]);
  assert.deepEqual(filtered.result.action, { kind: "check", names: ["仕事"], stage: "deep", refresh: false, batch: true, uncheckedOnly: false });
});

test("mark all and clearing marks do not alter stages; assessed lists show a no-work message", async () => {
  const marked = await run(["a", esc, esc]);
  assert.deepEqual(marked.result.favoriteChanges, []);
  assert.equal(marked.result.action, undefined);
  const state = fixture();
  for (const entry of state.rounds[0]!.candidates) state.availability[entry.name.normalize("NFKC").toLocaleLowerCase()] = state.availability.taskhq!;
  const checked = await run(["c", esc], { state });
  assert.equal(checked.result.action, undefined);
  assert.match(checked.frames[1]!.join("\n"), /No unchecked or unknown names/);
  assert.match(checked.frames[1]!.join("\n"), /c Check pending \(0\)/);
});

test("inconclusive checks count as pending and are retried without rechecking conclusive names", async () => {
  const state = fixture();
  state.availability.other = { score: "unknown", reason: "inconclusive", stage: "deep", checkedAt: "2026-10-19T00:00:00Z" };
  state.availability["仕事".normalize("NFKC").toLocaleLowerCase()] = state.availability.other!;
  const { result, frames } = await run(["c"], { state });
  assert.deepEqual(result.action, { kind: "check", names: ["A much longer name", "仕事", "Cafe\u0301"], stage: "deep", refresh: false, batch: true, uncheckedOnly: true });
  assert.match(frames[0]!.join("\n"), /c Check pending \(3\)/);
  const marked = await run([" ", down, " ", "c"], { state });
  assert.deepEqual(marked.result.action, { kind: "check", names: ["TaskHQ", "A much longer name"], stage: "deep", refresh: false, batch: true, uncheckedOnly: false });
});

test("bulk favorite changes affect stage, not marks, and invalidate the pool preview", async () => {
  const state = fixture(); state.reserve = [{ name: "Reserve" }];
  const promoted = await run([" ", down, " ", "f", "g", "\r"], { state });
  assert.deepEqual(promoted.result.favoriteChanges, [{ name: "A much longer name", roundId: "round-1", liked: true }]);
  assert.match(promoted.frames[5]!.join("\n"), /New pool/);
  assert.doesNotMatch(promoted.frames[5]!.join("\n"), /No new model call/);
  const demoted = await run([" ", "f", esc, esc]);
  assert.deepEqual(demoted.result.favoriteChanges, [{ name: "TaskHQ", roundId: "round-1", liked: false }]);
  const shifted = await run(["\x1b[99;2u"]);
  assert.ok(shifted.result.action?.kind === "check" && shifted.result.action.refresh);
});

test("generation must be prepared and explicitly started", async () => {
  const cancelled = await run(["g", esc, esc]);
  assert.equal(cancelled.result.action, undefined);
  const started = await run(["g", "\r"]);
  assert.deepEqual(started.result.action, { kind: "more" });
  assert.match(started.frames[1]!.join("\n"), /New pool.*45 seconds/);
  const state = fixture(); state.reserve = [{ name: "Ready" }];
  const pool = await run(["g", "\r"], { state });
  assert.match(pool.frames[1]!.join("\n"), /No new model call/);
});

test("the brief is an explicit screen with separate edit and feedback actions", async () => {
  const brief = await run(["b", esc, esc]);
  assert.match(brief.frames[1]!.join("\n"), /Task center/);
  assert.deepEqual((await run(["b", "e"])).result.action, { kind: "edit-brief" });
  assert.deepEqual((await run(["b", "f"])).result.action, { kind: "feedback" });
});

test("favorite toggles do not dismiss names and carry changes on close", async () => {
  const { result } = await run(["f", down, "f", esc]);
  assert.equal(result.action, undefined);
  assert.deepEqual(result.favoriteChanges, [
    { name: "TaskHQ", roundId: "round-1", liked: false },
    { name: "A much longer name", roundId: "round-1", liked: true },
  ]);
  const favorites = await run([down, "f", "\t", esc]);
  assert.ok(favorites.frames[3]!.some(line => /A much longer name/.test(line)));
});

test("checks start directly while similar-name refinement still requires confirmation", async () => {
  assert.deepEqual((await run(["\r", "c"])).result.action, { kind: "check", names: ["TaskHQ"], stage: "deep", refresh: false });
  assert.deepEqual((await run(["\r", "r"])).result.action, { kind: "check", names: ["TaskHQ"], stage: "deep", refresh: true });
  assert.deepEqual((await run(["\r", "x"])).result.action, { kind: "check", names: ["TaskHQ"], stage: "screen", refresh: false });
  assert.equal((await run(["\r", "m", esc, esc])).result.action, undefined);
  assert.deepEqual((await run(["\r", "m", "\r"])).result.action, { kind: "similar", name: "TaskHQ" });
  const unsaved = await run([down, "\r", "c"]);
  assert.doesNotMatch(unsaved.frames.flat().join("\n"), /Enter start|Also saves this name/);
  assert.deepEqual(unsaved.result.favoriteChanges, []);
});

test("unchecked details show one status, a name-led title and only primary actions", async () => {
  const state = fixture();
  state.rounds[0]!.candidates[1] = { name: "TaskPatio", flavor: "A lighter, more personal place to get moving." };
  state.selected = state.rounds[0]!.candidates.map(entry => entry.name);
  const { frames } = await run([down, "\r", " ", "?", "?", esc, esc], { state, widths: [160] });
  const screen = frames[2]!.join("\n");
  assert.match(screen, /Names \/ TaskPatio.*Selected/);
  assert.match(screen, /A lighter, more personal place/);
  assert.match(screen, /Availability\s+Not checked/);
  assert.equal(screen.match(/Not checked/g)?.length, 1);
  assert.doesNotMatch(screen, /Brief r|70 favorites|No saved availability|legal clearance|Refresh check|Quick screen|Discard name|↑↓ scroll/);
  assert.match(screen, /Space\s+Save favorite/);
  assert.match(screen, /c\s+Check availability/);
  assert.ok(frames[2]!.every(line => visibleWidth(line) <= 88));
  assert.match(frames[3]!.join("\n"), /Favorite[\s\S]*Remove favorite/);
  assert.match(frames[4]!.join("\n"), /Refresh check[\s\S]*Quick screen[\s\S]*Discard name/);
  assert.doesNotMatch(frames[5]!.join("\n"), /Refresh check|Discard name/);
});

test("checked details retain labeled findings, warnings and scrollable evidence", async () => {
  const state = fixture();
  state.availability.taskhq!.warnings = ["Review the same-category result"];
  state.availability.taskhq!.evidence = Array.from({ length: 8 }, (_, index) => ({ source: "web" as const, detail: `Source ${index} findings`, url: `https://example.com/source-${index}` }));
  const { frames } = await run(["\r", ...Array(30).fill(down), esc, esc], { state });
  const first = frames[1]!.join("\n");
  assert.match(first, /Availability\s+good/);
  assert.match(first, /Checked\s+Deep check/);
  assert.match(first, /Finding\s+Some unrelated usage/);
  assert.match(first, /Warning\s+Review the same-category result/);
  assert.match(first, /Evidence\s+8 sources/);
  assert.match(first, /not trademark clearance/);
  const last = frames[31]!.join("\n");
  assert.match(last, /Names \/ TaskHQ.*Favorite/);
  assert.match(last, /https:\/\/example.com\/source-7/);
  assert.match(last, /Space\s+Remove favorite/);
});

test("detail titles and action labels survive narrow widths and advanced actions remain safe", async () => {
  const state = fixture();
  state.rounds[0]!.candidates[0]!.name = "A very long candidate name with wide 仕事 characters";
  state.selected = state.rounds[0]!.candidates.map(entry => entry.name);
  const { result } = await run(["\r", "?", "?", " ", esc, esc], { state, widths: [1, 12, 24, 42, 63, 64, 80, 160] });
  assert.equal(result.action, undefined);
  const narrow = await run(["\r", "?", esc, esc], { widths: [24] });
  assert.match(narrow.frames[2]!.join("\n"), /Space\s+Remove favorite/);
  assert.match(narrow.frames[2]!.join("\n"), /r\s+Refresh check/);
  assert.match(narrow.frames[2]!.join("\n"), /Esc\s+Back/);
});

test("n adds from Names or Favorites, but not History or search", async () => {
  assert.deepEqual((await run(["n"])).result.action, { kind: "add" });
  assert.deepEqual((await run(["N"])).result.action, { kind: "add" });
  assert.deepEqual((await run(["\x1b[110;2u"])).result.action, { kind: "add" });
  assert.deepEqual((await run(["\t", "n"])).result.action, { kind: "add" });
  assert.equal((await run(["n", esc], { position: { tab: "history", cursor: 0 } })).result.action, undefined);
  const position: WorkspacePosition = { tab: "names", cursor: 0, focusName: "仕事" };
  const focused = await run(["\r", esc, esc], { position });
  assert.match(focused.frames[1]!.join("\n"), /Names \/ 仕事/);
  assert.equal(position.focusName, undefined);
});

test("search owns typed action keys and clearing search never starts work", async () => {
  const { result, frames } = await run(["/", "g", "b", "n", "N", "1", "\r", esc, esc]);
  assert.equal(result.action, undefined);
  assert.ok(frames.some(lines => lines.some(line => /No matches/.test(line))));
  assert.deepEqual(result.favoriteChanges, []);
});

test("empty screens are safe and history opens a saved round without generating", async () => {
  const state = emptyBrandState();
  await run(["\r", " ", "\t", "c", "\t", "\r", esc], { state });
  const position: WorkspacePosition = { tab: "history", cursor: 0 };
  const history = await run(["\r", esc, esc], { position });
  assert.equal(position.tab, "names");
  assert.equal(position.roundId, undefined);
  assert.equal(history.result.action, undefined);
});
