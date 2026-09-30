import assert from "node:assert/strict";
import test from "node:test";
import { generatePool, type NamingBrief, type GenerationRequest } from "../src/generation.ts";
import type { Candidate } from "../src/types.ts";

const brief: NamingBrief = { product: "tasks", direction: "focused and energetic", examples: ["Jazzed"], constraints: { singleWord: true, maxLength: 12 }, excluded: ["Taken"] };
const names = (...values: string[]): Candidate[] => values.map((name) => ({ name, flavor: "  concise note  " }));
const fake = (responses: Candidate[][]): GenerationRequest => async () => ({ candidates: responses.shift() ?? [] });

test("filters invalid and duplicate names, preserves rank, and caps notes and proposals", async () => {
  const candidates = names("Taken", "Élan", "e\u0301lan", "two words", "getFocus", "has2", ...Array.from({ length: 30 }, (_, i) => `Word${i}`));
  candidates.push(...names("Focus", "Ready"));
  const result = await generatePool(brief, async () => ({ candidates }));
  assert.deepEqual(result.candidates.map((c) => c.name), ["Élan"]);
  assert.equal(result.candidates[0].flavor, "concise note");
  assert.equal(result.metrics.modelCalls, 2);
});

test("does not refill when at least eight survive and refills only once otherwise", async () => {
  let calls = 0;
  const enough = await generatePool(brief, async () => ({ candidates: (calls++, names("Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Gamma", "Hotel")) }));
  assert.equal(calls, 1);
  assert.equal(enough.metrics.modelCalls, 1);
  calls = 0;
  const refill = await generatePool(brief, async () => ({ candidates: (calls++, calls === 1 ? names("Alpha") : names("Bravo")) }));
  assert.equal(calls, 2);
  assert.deepEqual(refill.candidates.map((c) => c.name), ["Alpha", "Bravo"]);
});

test("caps processed proposals and pool at 24", async () => {
  const result = await generatePool(brief, async () => ({ candidates: Array.from({ length: 30 }, (_, i) => ({ name: `Word${String.fromCharCode(65 + i)}` })) }));
  assert.equal(result.candidates.length, 24);
  assert.equal(result.metrics.modelCalls, 1);
});

test("times out and propagates caller abort to the request", async () => {
  let received: AbortSignal | undefined;
  await assert.rejects(generatePool(brief, (_prompt, signal) => { received = signal; return new Promise(() => {}); }, { timeoutMs: 30 }), /time limit|timed out/);
  assert.equal(received?.aborted, true);
  const controller = new AbortController();
  let externalSignal: AbortSignal | undefined;
  const pending = generatePool(brief, (_prompt, signal) => { externalSignal = signal; return new Promise(() => {}); }, { signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
  assert.equal(externalSignal?.aborted, true);
});

test("bounded prompts do not replay hundreds of excluded names or reject real prefix words", async () => {
  const large = { ...brief, excluded: Array.from({ length: 500 }, (_, index) => `Excluded${index}`), examples: Array(500).fill("Taste") };
  const result = await generatePool(large, async (prompt) => {
    assert.ok(prompt.length < 2000);
    assert.match(prompt, /50[02] total/);
    assert.doesNotMatch(prompt, /excluded0,/);
    return { candidates: names("Getaway", "Tryout", "GetFocus", "TryFocus") };
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.name), ["Getaway", "Tryout"]);
});

test("aggregates usage", async () => {
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 3, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
  let calls = 0;
  const result = await generatePool(brief, async () => ({ candidates: ++calls === 1 ? names("One") : names("Two"), usage }));
  assert.equal(result.metrics.usage?.totalTokens, 6);
  assert.equal(result.metrics.usage?.cost.total, 20);
});
