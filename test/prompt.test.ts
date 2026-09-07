import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAvailabilityPrompt,
  buildBrandContext,
  buildMorePrompt,
  buildPivotPrompt,
} from "../src/prompt.ts";
import { emptyBrandState, type BrandState } from "../src/types.ts";

function stateWith(): BrandState {
  const state = emptyBrandState("a todo list for the agentic age");
  state.rounds.push({
    id: "r1",
    createdAt: new Date().toISOString(),
    product: state.product,
    candidates: [{ name: "Docket" }, { name: "Tidy" }],
  });
  state.liked.push({ name: "Docket", likedAt: new Date().toISOString() });
  state.dismissed.push("Tidy");
  state.directionNotes.push("dry wit, not hippie");
  return state;
}

test("more prompt keeps direction and excludes every seen name", () => {
  const prompt = buildMorePrompt(stateWith());
  assert.match(prompt, /a todo list for the agentic age/);
  assert.match(prompt, /dry wit, not hippie/);
  assert.match(prompt, /brand_pick/);
  assert.match(prompt, /Docket/);
  assert.match(prompt, /Tidy/);
});

test("pivot prompt surfaces the new note as highest priority", () => {
  const prompt = buildPivotPrompt(stateWith(), "momentum, not grinning");
  assert.match(prompt, /Highest priority for this round.*momentum, not grinning/);
});

test("availability prompt splits cached from fresh and stays cache-first", () => {
  const state = stateWith();
  state.liked.push({ name: "Soon", likedAt: new Date().toISOString() });
  state.availability.soon = {
    score: "decent",
    reason: "clashes elsewhere",
    checkedAt: new Date().toISOString(),
  };

  const prompt = buildAvailabilityPrompt(state);
  assert.match(prompt, /brand_score/);
  assert.match(prompt, /Already checked, report as-is: Soon/);
  assert.match(prompt, /Research these uncached names now: Docket/);
  assert.doesNotMatch(prompt, /Research these uncached names now: .*Soon/);
});

test("availability prompt refuses to run on an empty shortlist", () => {
  const state = emptyBrandState("x");
  assert.match(buildAvailabilityPrompt(state), /No kept names/);
});

test("brand context advertises the exits and the availability cache", () => {
  const state = stateWith();
  state.availability.docket = {
    score: "bad",
    reason: "court filings app",
    checkedAt: new Date().toISOString(),
  };
  const context = buildBrandContext(state) ?? "";
  assert.match(context, /Availability-checked.*docket \(bad\)/);
  assert.match(context, /\/brand more/);
  assert.match(context, /\/brand check/);
});
