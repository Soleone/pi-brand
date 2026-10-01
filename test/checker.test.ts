import assert from "node:assert/strict";
import test from "node:test";
import { buildCollisionSearchQueries, CHECK_RESEARCH_VERSION, checkFinalists, extractWebEvidence, shouldRefreshUnknown, type CheckDependencies } from "../src/checker.ts";
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

test("learning collision searches use several category-specific query angles", () => {
  const queries = buildCollisionSearchQueries("Mindpop", "an app for learning or retaining information");
  assert.equal(queries.length, 2);
  assert.match(queries[0], /Mindpop.*learning or retaining information/);
  assert.match(queries[1], /learning education study flashcards vocabulary memory retention quiz knowledge/);
  assert.match(queries[1], /Mindpop.*facts trivia game puzzle app software company/);
  assert.doesNotMatch(buildCollisionSearchQueries("Ledger", "an accounting app")[1], /flashcards|vocabulary/);
});

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

test("old deep unknowns are automatically rechecked once under new research rules", async () => {
  const { state, calls, dependencies } = fixture();
  state.finalists = ["Able"];
  state.availability.able = { score: "unknown", reason: "old incomplete result", checkedAt: "2025-01-01", stage: "deep", researchVersion: 1 };
  assert.equal(shouldRefreshUnknown(state.availability.able, "deep"), true);
  const refreshed = await checkFinalists(state, "deep", dependencies);
  assert.equal(calls.search, 1);
  assert.equal(refreshed.records.able.researchVersion, CHECK_RESEARCH_VERSION);
  state.availability = refreshed.records;
  const cached = await checkFinalists(state, "deep", dependencies);
  assert.deepEqual(cached.cached, ["Able"]);
  assert.equal(calls.search, 1);
  assert.equal(shouldRefreshUnknown(state.availability.able, "deep"), false);
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

test("clear learning and knowledge products override unsupported worker judgments", async () => {
  const { state, calls, dependencies } = fixture();
  state.product = "an app for learning or retaining information";
  state.finalists = ["Nugget", "Mindpop", "FactStack"];
  const relevant: Record<string, { url: string; detail: string }> = {
    nugget: { url: "https://nugget.coach/", detail: "Nugget teaches ideas from books with games and spaced repetition so learners remember them." },
    mindpop: { url: "https://mindpopapp.com/", detail: "Mindpop ist ein Lernsystem für Vokabeln mit Merkbildern, Quizfragen und Mini-Spielen." },
    factstack: { url: "https://factstackgame.com/", detail: "FactStack is a daily fact sorting game. Sort facts by date, size, and popularity." },
  };
  dependencies.search = async (name) => {
    const specific = relevant[name.toLowerCase()];
    return [
      ...Array.from({ length: 4 }, (_, index) => ({ source: "web" as const, url: `https://unrelated.example/${name}/${index}`, detail: `${name} family restaurant and dining guide` })),
      { source: "web", ...specific },
    ];
  };
  dependencies.assess = async (prompt) => {
    const items = JSON.parse(prompt.split("\n").at(-1)!) as { name: string; evidence: { url: string }[] }[];
    for (const item of items) assert.ok(item.evidence.some((source) => source.url === relevant[item.name.toLowerCase()].url));
    return { results: items.map((item) => ({ name: item.name, reason: "no overlap", sourceUrls: item.evidence.map((source) => source.url), famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: false })) };
  };
  const result = await checkFinalists(state, "deep", dependencies);
  assert.deepEqual(Object.keys(result.records), ["nugget", "mindpop", "factstack"]);
  for (const name of state.finalists) {
    const record = result.records[name.toLowerCase()];
    assert.equal(record.score, "terrible", name);
    assert.equal(record.signals?.sameSpaceCollision, true, name);
    assert.match(record.reason, /Web evidence describes a learning or knowledge product/);
    assert.equal(record.researchVersion, CHECK_RESEARCH_VERSION);
  }
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

test("worker batch follows finalist order rather than concurrent search completion", async () => {
  const { state, dependencies } = fixture();
  const release: (() => void)[] = [];
  dependencies.search = async (name) => {
    if (name === "Able") await new Promise<void>((resolve) => { release.push(resolve); });
    return [{ source: "web", url: `https://example.com/${name}`, detail: "One source" }];
  };
  dependencies.assess = async (prompt) => {
    const items = JSON.parse(prompt.split("\n").at(-1)!) as { name: string }[];
    assert.deepEqual(items.map((item) => item.name), ["Able", "Bold", "Calm"]);
    return { results: [] };
  };
  const pending = checkFinalists(state, "screen", dependencies);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release[0]();
  await pending;
});

test("worker sees bounded cited excerpts only, never creative taste or full search results", async () => {
  const { state, dependencies } = fixture();
  state.product = "p".repeat(1000);
  state.brief.direction = "PRIVATE_CREATIVE_DIRECTION";
  state.liked = [{ name: "PRIVATE_TASTE", likedAt: "2026-01-01" }];
  state.finalists = ["Able", "Bold", "Calm"];
  dependencies.search = async (name) => Array.from({ length: 6 }, (_, index) => ({
    source: "web", url: `https://example.com/${name}/${index}`, detail: `Large snippet ${"x".repeat(4000)}\u0001`,
  }));
  let assessmentPrompt = "";
  dependencies.assess = async (prompt) => {
    assessmentPrompt = prompt;
    const items = JSON.parse(prompt.split("\n").at(-1)!) as { name: string; evidence: { url: string; detail: string }[] }[];
    assert.equal(items.length, 3);
    for (const item of items) {
      assert.equal(item.evidence.length, 4);
      assert.ok(item.evidence.every((source) => source.detail.length <= 400));
      assert.ok(item.evidence.every((source) => !source.url.endsWith("/5")));
    }
    // A citation to a fetched but undisclosed source must not support a judgment.
    return { results: items.map((item) => ({ name: item.name, reason: "unsubstantiated", sourceUrls: [`https://example.com/${item.name}/5`], famousCollision: true, sameSpaceCollision: true, giantAssociation: true, unrelatedCount: 0, comParked: false })) };
  };
  const result = await checkFinalists(state, "screen", dependencies);
  assert.ok(assessmentPrompt.length < 14000);
  assert.ok(!assessmentPrompt.includes("PRIVATE_CREATIVE_DIRECTION"));
  assert.ok(!assessmentPrompt.includes("PRIVATE_TASTE"));
  assert.equal(result.records.able.score, "unknown");
  assert.equal(result.records.able.evidence?.length, 6);
});
