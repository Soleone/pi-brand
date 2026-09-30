import assert from "node:assert/strict";
import test from "node:test";
import { checkFinalists, extractWebEvidence, type CheckDependencies } from "../src/checker.ts";
import { emptyBrandState } from "../src/types.ts";

function fixture() {
  const state = emptyBrandState("tasks");
  state.finalists = ["Able", "Bold", "Calm"];
  const calls = { search: 0, assess: 0, fetch: 0 };
  const dependencies: CheckDependencies = {
    search: async (name) => { calls.search++; return [{ source: "web", url: `https://example.com/${name}`, detail: "Unrelated usage from a source" }]; },
    assess: async (prompt) => {
      calls.assess++;
      const items = JSON.parse(prompt.split("\n").at(-1)!) as { name: string; evidence: { url: string }[] }[];
      return { results: items.map((item) => ({ name: item.name, reason: "No notable collision in these sources", sourceUrls: item.evidence.map((source) => source.url), famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: false })) };
    },
    fetch: (async () => { calls.fetch++; return new Response(null, { status: 404 }); }) as typeof fetch,
  };
  return { state, calls, dependencies };
}

test("one operation batches assessment, caches findings and never mutates caller state", async () => {
  const { state, calls, dependencies } = fixture();
  const result = await checkFinalists(state, "deep", dependencies);
  assert.deepEqual(calls, { search: 3, assess: 1, fetch: 6 });
  assert.equal(result.records.able.score, "perfect");
  assert.equal(result.records.able.evidence?.length, 3);
  assert.match(result.records.able.evidence![1].detail, /Confirm registrability/);
  assert.deepEqual(state.availability, {});
  state.availability = result.records;
  const cached = await checkFinalists(state, "deep", dependencies);
  assert.deepEqual(calls, { search: 3, assess: 1, fetch: 6 });
  assert.equal(cached.cached.length, 3);
  assert.equal(cached.records.able.checkedAt, result.records.able.checkedAt);
});

test("legacy scores remain authoritative until explicit refresh", async () => {
  const { state, calls, dependencies } = fixture();
  state.finalists = ["Able"];
  state.availability.able = { score: "decent", reason: "historical result", stage: "legacy", checkedAt: "2026-01-01" };
  const old = await checkFinalists(state, "deep", dependencies);
  assert.equal(old.records.able.score, "decent");
  assert.deepEqual(calls, { search: 0, assess: 0, fetch: 0 });
  const fresh = await checkFinalists(state, "deep", dependencies, { refresh: true });
  assert.equal(fresh.records.able.stage, "deep");
  assert.deepEqual(calls, { search: 1, assess: 1, fetch: 2 });
});

test("screen upgrade reuses web evidence and avoids repeated search or classification", async () => {
  const { state, calls, dependencies } = fixture();
  state.finalists = ["Able"];
  state.availability = (await checkFinalists(state, "screen", dependencies)).records;
  assert.equal(state.availability.able.score, "unknown");
  assert.equal(calls.fetch, 0);
  const deep = await checkFinalists(state, "deep", dependencies);
  assert.deepEqual(calls, { search: 1, assess: 1, fetch: 2 });
  assert.equal(deep.records.able.stage, "deep");
  assert.equal(deep.records.able.score, "perfect");
});

test("decisive collisions skip domain and package lookups", async () => {
  const { state, calls, dependencies } = fixture();
  const assess = dependencies.assess;
  dependencies.assess = async (prompt, signal) => {
    const response = await assess(prompt, signal);
    response.results.forEach((item) => { item.sameSpaceCollision = true; });
    return response;
  };
  state.brief.checkPackages = true;
  const result = await checkFinalists(state, "deep", dependencies);
  assert.equal(result.records.able.score, "terrible");
  assert.equal(calls.fetch, 0);
});

test("search failures, unsupported judgments and HTTP failures stay unknown", async () => {
  const { state, dependencies } = fixture();
  dependencies.search = async () => { throw new Error("network unavailable"); };
  assert.equal((await checkFinalists(state, "screen", dependencies)).records.able.score, "unknown");
  const fixture2 = fixture();
  const original = fixture2.dependencies.assess;
  fixture2.dependencies.assess = async (prompt, signal) => {
    const response = await original(prompt, signal);
    response.results.forEach((item) => { item.sourceUrls = ["https://invented.invalid/"]; item.sameSpaceCollision = true; });
    return response;
  };
  assert.equal((await checkFinalists(fixture2.state, "screen", fixture2.dependencies)).records.able.score, "unknown");
  const fixture3 = fixture();
  fixture3.dependencies.fetch = (async () => new Response(null, { status: 429 })) as typeof fetch;
  assert.equal((await checkFinalists(fixture3.state, "deep", fixture3.dependencies)).records.able.score, "unknown");
});

test("finalist cap, deadline and cancellation bound hung dependencies", async () => {
  const { state, dependencies } = fixture();
  state.finalists.push("Daring");
  await assert.rejects(checkFinalists(state, "deep", dependencies), /one to three/);
  state.finalists = ["Able"];
  let signal: AbortSignal | undefined;
  dependencies.search = (_name, current) => { signal = current; return new Promise(() => {}); };
  await assert.rejects(checkFinalists(state, "deep", dependencies, { timeoutMs: 20 }), /budget/);
  assert.equal(signal?.aborted, true);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(checkFinalists(state, "deep", dependencies, { signal: controller.signal }), /cancelled/);
});

test("evidence extraction preserves actual URLs and bounds search payloads", () => {
  const structured = extractWebEvidence([{ type: "text", text: JSON.stringify({ results: [{ url: "https://example.com/a", title: "Actual source", snippet: "Actual snippet" }] }) }]);
  assert.deepEqual(structured, [{ source: "web", url: "https://example.com/a", detail: "Actual source\nActual snippet" }]);
  assert.equal(extractWebEvidence("[source](https://example.com/b)\nAdjacent passage")[0].url, "https://example.com/b");
  assert.equal(extractWebEvidence({ url: "javascript:alert(1)", snippet: "not a source" }).length, 0);
  const many = extractWebEvidence(Array.from({ length: 30 }, (_, index) => ({ url: `https://example.com/${index}`, snippet: "x".repeat(5000) })));
  assert.equal(many.length, 6);
  assert.equal(many[0].detail.length, 1500);
});
