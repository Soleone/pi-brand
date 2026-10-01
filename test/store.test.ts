import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addLikes,
  getAvailability,
  getBrandStatePath,
  getAvailabilityBatch,
  loadBrandState,
  recordAvailability,
  recordRound,
  saveBrandState,
  seenNames,
  setDirection,
  setFinalists,
} from "../src/store.ts";

function tempRoot(): { root: string; home: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-brand-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  return { root, home, cwd };
}

test("round trip: record round, add likes, reload", () => {
  const { home, cwd } = tempRoot();
  const first = loadBrandState(cwd, true, {}, home);
  assert.equal(first.isNew, true);

  const round = recordRound(first.state, {
    product: "a fast CLI journal",
    candidates: [{ name: "Jot", flavor: "short verb" }],
    directionHint: "short verbs",
  });
  const added = addLikes(first.state, round, [{ name: "Jot", flavor: "short verb" }]);
  assert.deepEqual(added, ["Jot"]);
  // Duplicates by case are ignored.
  assert.deepEqual(addLikes(first.state, round, [{ name: "jot" }]), []);
  saveBrandState(first.path, first.state);

  const second = loadBrandState(cwd, true, {}, home);
  assert.equal(second.isNew, false);
  assert.equal(second.state.product, "a fast CLI journal");
  assert.equal(second.state.rounds.length, 1);
  assert.deepEqual(
    second.state.liked.map((entry) => entry.name),
    ["Jot"],
  );
  assert.deepEqual(second.state.directionNotes, ["short verbs"]);
  assert.ok(seenNames(second.state).has("jot"));
});

test("availability scores survive a save/reload round trip", () => {
  const { home, cwd } = tempRoot();
  const first = loadBrandState(cwd, true, {}, home);
  const round = recordRound(first.state, {
    product: "x",
    candidates: [{ name: "Soon" }],
  });
  addLikes(first.state, round, [{ name: "Soon" }]);
  first.state.liked[0].score = "decent";
  first.state.liked[0].scoreReason = "no notable collision";
  saveBrandState(first.path, first.state);

  const second = loadBrandState(cwd, true, {}, home);
  assert.equal(second.state.liked[0].score, "decent");
  assert.equal(second.state.liked[0].scoreReason, "no notable collision");
});

test("recordAvailability caches and backfills likes and candidates", () => {
  const { home, cwd } = tempRoot();
  const first = loadBrandState(cwd, true, {}, home);
  const round = recordRound(first.state, {
    product: "x",
    candidates: [{ name: "Tally" }, { name: "Untouched" }],
  });
  addLikes(first.state, round, [{ name: "Tally" }]);

  const saved = recordAvailability(first.state, "TALLY", {
    score: "terrible",
    reason: "accounting giant",
    signals: {
      famousCollision: false,
      sameSpaceCollision: false,
      giantAssociation: true,
      unrelatedCount: 0,
      comParked: false,
    },
  });
  assert.equal(saved.score, "terrible");
  assert.ok(saved.checkedAt);

  // Case-insensitive lookup, backfilled everywhere the name appears.
  assert.equal(getAvailability(first.state, "tally")?.score, "terrible");
  assert.equal(getAvailability(first.state, "  Tally  ")?.reason, "accounting giant");
  assert.equal(first.state.liked[0].score, "terrible");
  assert.equal(first.state.rounds[0].candidates[0].score, "terrible");
  assert.equal(first.state.rounds[0].candidates[1].score, undefined);
  assert.equal(getAvailability(first.state, "never-checked"), undefined);

  // Survives save/reload, keyed lowercase.
  saveBrandState(first.path, first.state);
  const second = loadBrandState(cwd, true, {}, home);
  const reloaded = getAvailability(second.state, "Tally");
  assert.equal(reloaded?.score, "terrible");
  assert.equal(reloaded?.signals?.giantAssociation, true);
  assert.deepEqual(Object.keys(second.state.availability), ["tally"]);
  assert.equal(second.state.liked[0].score, "terrible");
});

test("cache keys cannot inherit or change an object prototype", () => {
  const { home, cwd } = tempRoot();
  const run = loadBrandState(cwd, true, {}, home);
  assert.equal(getAvailability(run.state, "Constructor"), undefined);
  assert.equal(getAvailability(run.state, "toString"), undefined);
  recordAvailability(run.state, "constructor", { score: "unknown", reason: "manual" });
  recordAvailability(run.state, "__proto__", { score: "unknown", reason: "manual" });
  assert.equal(Object.getPrototypeOf(run.state.availability), Object.prototype);
  const batch = getAvailabilityBatch(run.state, ["constructor", "__proto__"]);
  assert.equal(Object.getPrototypeOf(batch.cached), Object.prototype);
  assert.deepEqual(Object.keys(batch.cached).sort(), ["__proto__", "constructor"]);
  saveBrandState(run.path, run.state);
  const reloaded = loadBrandState(cwd, true, {}, home);
  assert.equal(getAvailability(reloaded.state, "__proto__")?.score, "unknown");
  assert.equal(Object.getPrototypeOf(reloaded.state.availability), Object.prototype);
});

test("availability normalize drops invalid entries and keeps old files working", () => {
  const { home, cwd } = tempRoot();
  const fresh = loadBrandState(cwd, true, {}, home);
  assert.deepEqual(fresh.state.availability, {});
  const payload = {
    version: 1,
    product: "x",
    rounds: [],
    liked: [],
    dismissed: [],
    directionNotes: [],
    availability: {
      good: { score: "perfect", reason: "clean", checkedAt: "2026-01-01T00:00:00.000Z" },
      badScore: { score: "bogus", reason: "x" },
      badShape: "nope",
      "": { score: "good", reason: "empty key" },
    },
  };
  fs.mkdirSync(path.dirname(fresh.path), { recursive: true });
  fs.writeFileSync(fresh.path, JSON.stringify(payload));
  const loaded = loadBrandState(cwd, true, {}, home);
  assert.deepEqual(Object.keys(loaded.state.availability), ["good"]);
  assert.equal(loaded.state.availability.good.checkedAt, "2026-01-01T00:00:00.000Z");
});

test("trusted and untrusted projects use isolated external app paths", () => {
  const { home, cwd, root } = tempRoot();
  const env = { DATA: path.join(root, "data") };
  const loaded = loadBrandState(cwd, false, env, home);
  assert.equal(loaded.path, getBrandStatePath(cwd, true, env, home));
  assert.ok(loaded.path.startsWith(path.join(root, "data", "apps", "pi-brand", "runs")));
  assert.notEqual(loaded.path, getBrandStatePath(path.join(root, "other"), false, env, home));
  assert.equal(fs.existsSync(loaded.path), false);
});

test("legacy import keeps historical data and a byte-for-byte external backup", () => {
  const { home, cwd, root } = tempRoot();
  const env = { DATA: path.join(root, "data") };
  const original = JSON.stringify({ version: 1, product: "tasks", rounds: [], liked: [{ name: "Ready", likedAt: "2026-01-01" }], dismissed: ["Gone"], directionNotes: ["short words", "short words"], availability: { ready: { score: "decent", reason: "old check", checkedAt: "2026-01-01" } } });
  const legacy = path.join(cwd, ".pi", "brand.json");
  fs.writeFileSync(legacy, original);
  const imported = loadBrandState(cwd, true, env, home);
  assert.equal(imported.state.version, 2);
  assert.deepEqual(imported.state.directionNotes, ["short words"]);
  assert.equal(imported.state.brief.direction, "short words");
  assert.equal(imported.state.availability.ready.stage, "legacy");
  assert.deepEqual(imported.state.finalists, []);
  assert.equal(fs.readFileSync(`${imported.path}.v1-backup`, "utf8"), original);
  assert.equal(fs.readFileSync(legacy, "utf8"), original);
  assert.equal(loadBrandState(cwd, true, env, home).warnings.length, 0);
  assert.equal(fs.statSync(imported.path).mode & 0o777, 0o600);
});

test("untrusted legacy state is never imported and explicit overrides are respected", () => {
  const { home, cwd, root } = tempRoot();
  fs.writeFileSync(path.join(cwd, ".pi", "brand.json"), "not json");
  assert.equal(loadBrandState(cwd, false, {}, home).isNew, true);
  const target = path.join(root, "custom.json");
  assert.equal(loadBrandState(cwd, true, { PI_BRAND_CONFIG: target }, home).path, target);
  assert.equal(fs.existsSync(target), false);
});

test("corrupt and future-version runs fail closed without replacing data", () => {
  const { home, cwd } = tempRoot();
  const target = getBrandStatePath(cwd, true, {}, home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "broken json");
  assert.throws(() => loadBrandState(cwd, true, {}, home), /Could not read/);
  assert.equal(fs.readFileSync(target, "utf8"), "broken json");
  fs.writeFileSync(target, JSON.stringify({ version: 99, rounds: [], liked: [] }));
  assert.throws(() => loadBrandState(cwd, true, {}, home), /refusing to overwrite/);
});

test("finalists, direction, reserves, batch cache and evidence survive reload", () => {
  const { home, cwd } = tempRoot();
  const run = loadBrandState(cwd, true, {}, home);
  addLikes(run.state, undefined, [{ name: "Ready" }, { name: "Focus" }, { name: "Done" }, { name: "Set" }]);
  assert.throws(() => setFinalists(run.state, ["Ready", "Focus", "Done", "Set"]), /at most three/);
  assert.throws(() => setFinalists(run.state, ["Unknown"]), /favorites/);
  setFinalists(run.state, ["ready", "READY", "Focus"]);
  run.state.reserve = [{ name: "Unused" }];
  setDirection(run.state, "short and confident");
  assert.deepEqual(run.state.reserve, []);
  setDirection(run.state, "short and confident");
  assert.deepEqual(run.state.directionNotes, ["short and confident"]);
  recordAvailability(run.state, "Ready", { score: "unknown", reason: "partial", stage: "screen", researchVersion: 2, signals: { famousCollision: false }, evidence: [{ source: "web", url: "https://example.com", detail: "citation" }], warnings: ["Missing domain check"], requirementsKey: "requirements" });
  saveBrandState(run.path, run.state);
  const reloaded = loadBrandState(cwd, true, {}, home).state;
  assert.deepEqual(reloaded.finalists, ["Ready", "Focus"]);
  assert.equal(reloaded.availability.ready.evidence?.[0].detail, "citation");
  assert.equal(reloaded.availability.ready.researchVersion, 2);
  assert.equal(reloaded.availability.ready.signals?.sameSpaceCollision, undefined);
  const batch = getAvailabilityBatch(reloaded, ["Ready", "READY", "Focus"]);
  assert.deepEqual(Object.keys(batch.cached), ["ready"]);
  assert.deepEqual(batch.fresh, ["focus"]);
});
