import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addLikes,
  getAvailability,
  loadBrandState,
  recordAvailability,
  recordRound,
  saveBrandState,
  seenNames,
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

test("recordAvailability caches forever and backfills likes and candidates", () => {
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

test("untrusted projects use the global fallback path", () => {
  const { home, cwd } = tempRoot();
  const loaded = loadBrandState(cwd, false, {}, home);
  assert.equal(loaded.path, path.join(home, ".pi", "agent", "pi-brand.json"));
});
