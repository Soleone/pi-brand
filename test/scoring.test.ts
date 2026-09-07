import assert from "node:assert/strict";
import test from "node:test";

import { buildBrandContext, buildRoundPrompt } from "../src/prompt.ts";
import { compareScores, SCORE_INFO, scoreFromSignals, stubScoreFor } from "../src/scoring.ts";
import { emptyBrandState } from "../src/types.ts";

test("score scale covers the five agreed levels", () => {
  assert.deepEqual(Object.keys(SCORE_INFO).sort(), ["bad", "decent", "good", "perfect", "terrible"]);
  assert.ok(compareScores("perfect", "terrible") < 0);
});

test("stub returns unscored until the deep check lands", () => {
  const stub = stubScoreFor("Jot");
  assert.equal(stub.score, undefined);
  assert.match(stub.reason, /deep check/);
});

test("signal mapping reserves terrible for high legal risk", () => {
  assert.equal(scoreFromSignals({ famousCollision: true, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: false }).score, "terrible");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: true, giantAssociation: false, unrelatedCount: 0, comParked: false }).score, "terrible");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: false }).score, "perfect");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 1, comParked: false }).score, "good");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 3, comParked: false }).score, "decent");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 9, comParked: false }).score, "bad");
});

test("context reminder surfaces likes so later rounds stay on track", () => {
  const state = emptyBrandState("a fast CLI journal");
  assert.equal(buildBrandContext(state), undefined);
  state.liked.push({ name: "Jot", likedAt: new Date().toISOString() });
  state.directionNotes.push("short verbs");
  const reminder = buildBrandContext(state);
  assert.match(reminder ?? "", /Jot/);
  assert.match(reminder ?? "", /short verbs/);
});

test("round prompt tells the agent to use the picker and skip deep checks", () => {
  const prompt = buildRoundPrompt("a fast CLI journal", emptyBrandState());
  assert.match(prompt, /brand_pick/);
  assert.match(prompt, /Do NOT run npm/);
});
