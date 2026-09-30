import assert from "node:assert/strict";
import test from "node:test";

import { compareScores, SCORE_INFO, scoreFromSignals } from "../src/scoring.ts";

test("score scale keeps historical levels and adds an honest unknown", () => {
  assert.deepEqual(Object.keys(SCORE_INFO).sort(), ["bad", "decent", "good", "perfect", "terrible", "unknown"]);
  assert.ok(compareScores("perfect", "terrible") < 0);
});

test("missing signals never become a clean result", () => {
  assert.equal(scoreFromSignals({}).score, "unknown");
  assert.equal(scoreFromSignals({ famousCollision: false }).score, "unknown");
  assert.equal(scoreFromSignals({ sameSpaceCollision: true }).score, "terrible");
  assert.equal(scoreFromSignals({ giantAssociation: true }).score, "bad");
  assert.match(scoreFromSignals({ sameSpaceCollision: true }).reason, /not a legal determination/);
});

test("complete signals map to collision severity rather than legal clearance", () => {
  assert.equal(scoreFromSignals({ famousCollision: true, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: false }).score, "terrible");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: true, giantAssociation: false, unrelatedCount: 0, comParked: false }).score, "terrible");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: false }).score, "perfect");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 1, comParked: false }).score, "good");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 3, comParked: false }).score, "decent");
  assert.equal(scoreFromSignals({ famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 9, comParked: false }).score, "bad");
});
