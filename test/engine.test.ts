import assert from "node:assert/strict";
import test from "node:test";
import { takeBatch } from "../src/engine.ts";
import { recordRound, setDirection } from "../src/store.ts";
import { emptyBrandState } from "../src/types.ts";

const names = ["Able", "Bold", "Calm", "Daring", "Eager", "Fresh", "Grand", "Happy", "Ideal", "Jolly", "Keen", "Lively", "Merry", "Noble", "Open", "Proud", "Quick", "Ready", "Sharp", "Tidy", "Upbeat", "Vivid", "Warm", "Zesty"];

test("more consumes the reserve without another model request", async () => {
  const state = emptyBrandState("tasks");
  let calls = 0;
  const request = async () => { calls++; return { candidates: names.map((name) => ({ name })) }; };
  const first = await takeBatch(state, request);
  assert.equal(first.length, 12);
  assert.equal(state.reserve.length, 12);
  recordRound(state, { product: state.product, candidates: first });
  const second = await takeBatch(state, request);
  assert.equal(second.length, 12);
  assert.equal(calls, 1);
  assert.equal(state.generationMetrics.length, 1);
  assert.equal(state.reserve.length, 0);
});

test("direction changes invalidate the reserve; already-shown names never return", async () => {
  const state = emptyBrandState("tasks");
  state.reserve = [{ name: "Shown" }, { name: "Available" }];
  recordRound(state, { product: state.product, candidates: [{ name: "Shown" }] });
  const request = async () => { throw new Error("must not request"); };
  assert.deepEqual((await takeBatch(state, request)).map((candidate) => candidate.name), ["Available"]);
  state.reserve = [{ name: "Unshown" }];
  setDirection(state, "a new direction");
  assert.deepEqual(state.reserve, []);
});
