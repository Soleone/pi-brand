import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addLikes, loadBrandState, recordRound, saveBrandState, seenNames } from "../src/store.ts";

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

test("untrusted projects use the global fallback path", () => {
  const { home, cwd } = tempRoot();
  const loaded = loadBrandState(cwd, false, {}, home);
  assert.equal(loaded.path, path.join(home, ".pi", "agent", "pi-brand.json"));
});
