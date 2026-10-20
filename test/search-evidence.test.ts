import assert from "node:assert/strict";
import test from "node:test";
import { readSearchEvidence } from "../src/checker.ts";

const source = { url: "https://example.com/name", title: "A named product", snippet: "Product details" };
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

test("structured sources take priority over presentation and guidance URLs", () => {
  const result = readSearchEvidence({
    structuredContent: { queries: [{ results: [source] }, { results: [] }, { results: [] }] },
    content: [{ type: "text", text: "Guidance: https://unrelated.example/ Search failed in old presentation" }],
  }, 3);
  assert.deepEqual(result.map(entry => entry.url), [source.url]);
});

test("successful empty searches are distinct from unparseable or failed searches", () => {
  assert.deepEqual(readSearchEvidence({ structuredContent: { queries: [{ results: [] }, { results: [] }, { results: [] }] } }, 3), []);
  assert.deepEqual(readSearchEvidence(text({ results: [] }), 3), []);
  assert.deepEqual(readSearchEvidence({ content: [{ type: "text", text: "No results found." }] }, 3), []);
  assert.deepEqual(readSearchEvidence({ details: { successfulQueries: 3, totalResults: 0 } }, 3), []);
  for (const result of [text({ error: "rate limited", results: [] }), { content: [] }, text({ message: "rate limited" }), text({ results: [{ title: "missing URL" }] })]) {
    assert.throws(() => readSearchEvidence(result, 3));
  }
});

test("partial query failures are errors even when another query returns sources", () => {
  for (const result of [
    { structuredContent: { queries: [{ results: [source] }, { error: "offline", results: [] }, { results: [] }] } },
    { structuredContent: { queries: [{ results: [source] }] } },
    { ...text({ results: [source] }), details: { successfulQueries: 2, queryCount: 3 } },
    { content: [{ type: "text", text: `Error: rate limited\n[source](${source.url})` }] },
  ]) assert.throws(() => readSearchEvidence(result, 3));
});
