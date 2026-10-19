import assert from "node:assert/strict";
import test from "node:test";
import { applyBriefChanges, formatBrief, namingContent, parseBrief } from "../src/brief.ts";
import { emptyBrandState } from "../src/types.ts";

test("the editable brief round-trips empty and multiline sections without truncation", () => {
  const content = namingContent(emptyBrandState("tasks\nfrom every client"));
  content.direction = "x".repeat(1400);
  content.avoid = "No coined syllables.\nNo obscure words.";
  content.examples = ["TaskHQ", "Control room"];
  assert.deepEqual(parseBrief(formatBrief(content)), content);
});

test("invalid or ambiguous documents fail instead of discarding instructions", () => {
  const text = formatBrief(namingContent(emptyBrandState()));
  assert.throws(() => parseBrief(text.replace("## Avoid", "## Unknown")), /Unknown/);
  assert.throws(() => parseBrief(text.replace("Maximum length: 12", "Maximum length: 99")), /3-30/);
  assert.throws(() => parseBrief(text + "\n## Product\nother"), /duplicate/);
  assert.throws(() => parseBrief(text.replace("## Examples\n", "## Examples\nTaskHQ\n")), /one.*per line/);
});

test("targeted feedback preserves unrelated instructions and invalidates reserve", () => {
  const state = emptyBrandState("task hub");
  state.brief.direction = "Task/control center, all clients";
  state.brief.avoid = "Invented syllables";
  state.reserve = [{ name: "Stale" }];
  const entry = applyBriefChanges(state, { examples: ["TaskHQ"] }, { text: "hq could work too e.g. taskhq", author: "user", source: "chat" });
  assert.equal(state.brief.direction, "Task/control center, all clients");
  assert.equal(state.brief.avoid, "Invented syllables");
  assert.deepEqual(state.brief.examples, ["TaskHQ"]);
  assert.equal(state.briefRevision, 2);
  assert.deepEqual(state.reserve, []);
  assert.equal(entry.text, "hq could work too e.g. taskhq");
  assert.equal(entry.before?.examples.length, 0);
  assert.deepEqual(entry.after?.examples, ["TaskHQ"]);
});
