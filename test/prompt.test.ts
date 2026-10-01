import assert from "node:assert/strict";
import test from "node:test";
import { buildAvailabilityPrompt, buildMorePrompt, buildNamingBrief } from "../src/prompt.ts";
import { emptyBrandState } from "../src/types.ts";

test("naming brief uses one current direction and at most eight taste examples", () => {
  const state = emptyBrandState("a keyboard todo app");
  state.brief.direction = "familiar confident words";
  state.directionNotes = ["obsolete constraint", "accidental conversation fragment"];
  state.liked = Array.from({ length: 30 }, (_, index) => ({ name: `Taste${index}`, likedAt: "2026-01-01" }));
  const brief = buildNamingBrief(state);
  assert.equal(brief.direction, "familiar confident words");
  assert.equal(brief.examples.length, 8);
  assert.equal(brief.excluded.length, 30);
  assert.doesNotMatch(JSON.stringify(brief), /obsolete|accidental/);
});

test("check prompt names only finalists and delegates all bookkeeping", () => {
  const state = emptyBrandState("tasks");
  state.liked = [{ name: "Favorite", likedAt: "x" }, { name: "Finalist", likedAt: "x" }];
  state.finalists = ["Finalist"];
  const prompt = buildAvailabilityPrompt(state);
  assert.match(prompt, /brand_check once/);
  assert.match(prompt, /Finalist/);
  assert.match(prompt, /names \["Finalist"\]/);
  assert.doesNotMatch(prompt, /Favorite|brand_score|npm/);
  assert.match(buildAvailabilityPrompt(state, "screen", true), /stage screen, refresh true/);
  assert.match(buildAvailabilityPrompt(state, "deep", true, ["Favorite"]), /names \["Favorite"\].*saved favorite/);
  assert.match(buildAvailabilityPrompt(state, "deep", false, undefined, true), /allFavorites true.*batches of up to three/);
});

test("empty finalist list never asks for broad research", () => {
  assert.match(buildAvailabilityPrompt(emptyBrandState()), /Choose up to three/);
});

test("fallback generation prompt stays constant as history grows", () => {
  const state = emptyBrandState("tasks");
  const small = buildMorePrompt(state);
  state.directionNotes = Array(100).fill("a long redundant note");
  state.liked = Array.from({ length: 500 }, (_, index) => ({ name: `Name${index}`, likedAt: "x" }));
  assert.equal(buildMorePrompt(state), small);
  assert.ok(small.length < 250);
});
