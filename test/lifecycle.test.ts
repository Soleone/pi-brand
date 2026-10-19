import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generationInputKey, takeBatch } from "../src/engine.ts";
import { activeNames, addLikes, brandDocumentPaths, dismissNames, excludedNames, loadBrandState, recordRound, removeLikes, saveBrandState, selectNames } from "../src/store.ts";
import { buildNamingBrief } from "../src/prompt.ts";
import { emptyBrandState } from "../src/types.ts";

test("generated names become selected; favorites and bulk-independent discards preserve history", () => {
  const state = emptyBrandState("tasks");
  const round = recordRound(state, { product: state.product, candidates: [{ name: "TaskHQ" }, { name: "TaskPatio" }] });
  assert.deepEqual(state.selected, ["TaskHQ", "TaskPatio"]);
  assert.deepEqual(state.liked, []);
  addLikes(state, round, [round.candidates[0]]);
  removeLikes(state, ["taskhq"]);
  assert.deepEqual(state.selected, ["TaskHQ", "TaskPatio"]);
  assert.deepEqual(state.liked, []);
  addLikes(state, round, [round.candidates[0]]);
  dismissNames(state, ["TASKHQ", "TaskPatio"]);
  assert.deepEqual(activeNames(state), []);
  assert.deepEqual(state.liked, []);
  assert.equal(state.rounds[0].candidates.length, 2);
  assert.ok(excludedNames(state).seen.has("taskhq"));
  selectNames(state, ["TaskPatio"]);
  assert.deepEqual(activeNames(state).map(entry => entry.name), ["TaskPatio"]);
  assert.ok(!state.dismissed.includes("TaskPatio"));
});

test("legacy favorites without a saved round can be demoted without losing active membership", () => {
  const state = emptyBrandState("tasks");
  addLikes(state, undefined, [{ name: "LegacyName" }]);
  removeLikes(state, ["LegacyName"]);
  assert.deepEqual(activeNames(state), [{ name: "LegacyName" }]);
  assert.ok(excludedNames(state).seen.has("legacyname"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brand-orphan-"));
  try {
    const cwd = path.join(root, "project"); fs.mkdirSync(cwd);
    const target = path.join(root, "run.json"); saveBrandState(target, state);
    const reopened = loadBrandState(cwd, true, { PI_BRAND_CONFIG: target }).state;
    assert.deepEqual(reopened.selected, ["LegacyName"]);
    addLikes(reopened, undefined, activeNames(reopened));
    assert.equal(reopened.liked[0].name, "LegacyName");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("only favorites affect taste and favorite changes invalidate reserves and input keys", async () => {
  const state = emptyBrandState("tasks");
  const round = recordRound(state, { product: state.product, candidates: [{ name: "TaskHQ" }, { name: "TaskPatio" }] });
  state.brief.examples = ["ControlRoom"];
  const original = generationInputKey(state);
  state.reserve = [{ name: "OldReserve" }];
  addLikes(state, round, [round.candidates[0]]);
  assert.deepEqual(state.reserve, []);
  assert.notEqual(generationInputKey(state), original);
  assert.deepEqual(buildNamingBrief(state).favorites, ["TaskHQ"]);
  assert.deepEqual(buildNamingBrief(state).examples, ["ControlRoom"]);
  const favoriteKey = generationInputKey(state);
  dismissNames(state, ["TaskPatio"]);
  assert.equal(generationInputKey(state), favoriteKey);
  let prompt = "";
  await takeBatch(state, async value => { prompt = value; return { candidates: ["Able", "Bold", "Calm", "Daring", "Eager", "Fresh", "Grand", "Happy"].map(name => ({ name })) }; });
  assert.match(prompt, /Favorite names are positive taste references.*TaskHQ/);
  assert.doesNotMatch(prompt.split("Do not use excluded names")[0], /TaskPatio/);
  removeLikes(state, ["TaskHQ"]);
  assert.equal(generationInputKey(state), original);
  assert.deepEqual(state.reserve, []);
});

test("v3 migration seeds latest round plus favorites, retains an immutable backup and round data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brand-lifecycle-"));
  try {
    const cwd = path.join(root, "project"); fs.mkdirSync(cwd);
    const target = path.join(root, "run.json");
    const env = { PI_BRAND_CONFIG: target };
    const state = emptyBrandState("tasks");
    const old = recordRound(state, { product: state.product, candidates: [{ name: "OldFavorite" }, { name: "Historical" }] });
    addLikes(state, old, [old.candidates[0]]);
    recordRound(state, { product: state.product, candidates: [{ name: "Current" }, { name: "Discarded" }] });
    dismissNames(state, ["Discarded"]);
    saveBrandState(target, state);
    const raw = JSON.parse(fs.readFileSync(target, "utf8")); raw.version = 3; delete raw.selected;
    const original = JSON.stringify(raw);
    fs.writeFileSync(target, original);
    const document = brandDocumentPaths(target).brief;
    fs.writeFileSync(document, fs.readFileSync(document, "utf8").replace("## Explore\n", "## Explore\nHQ constructions\n"));
    const loaded = loadBrandState(cwd, true, env);
    assert.equal(loaded.state.version, 4);
    assert.equal(loaded.state.brief.direction, "HQ constructions");
    assert.deepEqual(loaded.state.selected, ["Current", "OldFavorite"]);
    assert.equal(loaded.state.rounds.length, 2);
    assert.equal(fs.readFileSync(`${target}.v3-backup`, "utf8"), original);
    dismissNames(loaded.state, ["Current"]); saveBrandState(target, loaded.state);
    const reopened = loadBrandState(cwd, true, env);
    assert.deepEqual(reopened.state.selected, ["OldFavorite"]);
    assert.equal(fs.readFileSync(`${target}.v3-backup`, "utf8"), original);
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
