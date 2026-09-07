import assert from "node:assert/strict";
import test from "node:test";

import { dismissNames, excludedNames, seenNames } from "../src/store.ts";
import { buildBrandContext, buildMorePrompt } from "../src/prompt.ts";
import { emptyBrandState, type BrandState } from "../src/types.ts";

function pool(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Name${i}`);
}

function stateWithRound(count: number): BrandState {
  const state = emptyBrandState("x");
  state.rounds.push({
    id: "r1",
    createdAt: new Date().toISOString(),
    product: "x",
    candidates: pool(count).map((name) => ({ name })),
  });
  return state;
}

test("dismissNames dedupes case-insensitively and reports what was new", () => {
  const state = emptyBrandState("x");
  assert.deepEqual(dismissNames(state, ["Dossier", " Docket ", "Minutes"]), [
    "Dossier",
    "Docket",
    "Minutes",
  ]);
  // Re-rejecting the same names adds nothing.
  assert.deepEqual(dismissNames(state, ["dossier", "DOCKET", "", "  "]), []);
  assert.equal(state.dismissed.length, 3);
});

test("excludedNames covers every shown, kept, and rejected name", () => {
  const state = stateWithRound(3);
  state.liked.push({ name: "Name1", likedAt: new Date().toISOString() });
  dismissNames(state, ["Rejected"]);

  const { seen, kept } = excludedNames(state);
  assert.ok(seen.has("name0") && seen.has("name1") && seen.has("name2"));
  assert.ok(seen.has("rejected"));
  assert.ok(kept.has("name1"));
  assert.equal(seen.size, 4);
  assert.equal(seen.size, seenNames(state).size);
});

test("prompts scale to hundreds of names with a count instead of a fake-complete list", () => {
  const state = stateWithRound(200);
  dismissNames(state, pool(50));

  const prompt = buildMorePrompt(state);
  assert.match(prompt, /Excluded, never propose again \(200 total\)/);
  assert.match(prompt, /\+160 earlier/);
  assert.match(prompt, /drops these in code/);

  const context = buildBrandContext(state);
  assert.ok(context, "exclusions alone must be enough to inject context");
  assert.match(context, /Rejected for good, never propose again \(50 total\)/);
  assert.match(context, /200 names are excluded in this project/);
});

test("first round says nothing is excluded yet", () => {
  const state = emptyBrandState("x");
  assert.match(buildMorePrompt(state), /No names are excluded yet/);
});
