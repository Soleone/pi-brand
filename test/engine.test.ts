import assert from "node:assert/strict";
import test from "node:test";
import { recordExternalPool, takeBatch } from "../src/engine.ts";
import { recordRound, setDirection } from "../src/store.ts";
import { emptyBrandState } from "../src/types.ts";

const names = ["Able", "Bold", "Calm", "Daring", "Eager", "Fresh", "Grand", "Happy", "Ideal", "Jolly", "Keen", "Lively", "Merry", "Noble", "Open", "Proud", "Quick", "Ready", "Sharp", "Tidy", "Upbeat", "Vivid", "Warm", "Zesty"];

test("generation returns the entire pool in rank order without holding names in reserve", async () => {
  const state = emptyBrandState("tasks");
  let calls = 0;
  const request = async () => { calls++; return { candidates: names.map((name) => ({ name })) }; };
  const first = await takeBatch(state, request);
  assert.deepEqual(first.map(candidate => candidate.name), names);
  assert.equal(calls, 1);
  assert.equal(state.generationMetrics.length, 1);
  assert.equal(state.reserve.length, 0);
});

test("legacy reserves are drained in full, excluding already-shown names and duplicates", async () => {
  const state = emptyBrandState("tasks");
  const available = names.map(name => ({ name }));
  recordExternalPool(state, available);
  state.reservePoolId = state.lastBatch!.poolId;
  state.reserve = [...available, { name: "Bold" }];
  recordRound(state, { product: state.product, candidates: [{ name: "Able" }] });
  const result = await takeBatch(state, async () => { throw new Error("must not request"); });
  assert.deepEqual(result.map(candidate => candidate.name), names.slice(1));
  assert.deepEqual(state.reserve, []);
  assert.equal(state.lastBatch?.poolId, state.pools[0].id);
});

test("direction changes invalidate the reserve; already-shown names never return", async () => {
  const state = emptyBrandState("tasks");
  recordExternalPool(state, [{ name: "Shown" }, { name: "Available" }]);
  state.reservePoolId = state.lastBatch!.poolId;
  state.reserve = [{ name: "Shown" }, { name: "Available" }];
  recordRound(state, { product: state.product, candidates: [{ name: "Shown" }] });
  const request = async () => { throw new Error("must not request"); };
  assert.deepEqual((await takeBatch(state, request)).map((candidate) => candidate.name), ["Available"]);
  state.reserve = [{ name: "Unshown" }];
  setDirection(state, "a new direction");
  assert.deepEqual(state.reserve, []);
});
