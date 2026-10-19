import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generatePool } from "../src/generation.ts";
import { takeBatch } from "../src/engine.ts";
import { brandDocumentPaths, getBrandStatePath, loadBrandState, recordRound } from "../src/store.ts";
import { emptyBrandState } from "../src/types.ts";

const names = ["Able", "Bold", "Calm", "Daring", "Eager", "Fresh", "Grand", "Happy", "Ideal", "Jolly", "Keen", "Lively", "Merry", "Noble", "Open", "Proud", "Quick", "Ready", "Sharp", "Tidy", "Upbeat", "Vivid", "Warm", "Zesty"];

test("the exact prompt retains long directions, all explicit examples, and permits HQ constructions", async () => {
  const product = "Task hub. ".repeat(70) + "Capture from all clients.";
  const direction = "Control center. ".repeat(50) + "HQ constructions are welcome.";
  const examples = Array.from({ length: 12 }, (_, i) => `Example${i}`);
  let actual = "";
  const result = await generatePool({ product, direction, examples, avoid: "Invented syllable blends", style: "Grounded", constraints: { singleWord: true, maxLength: 12 }, excluded: [] }, async prompt => {
    actual = prompt;
    return { candidates: ["TaskHQ", ...names.slice(0, 7)].map(name => ({ name })) };
  });
  assert.ok(actual.includes(product));
  assert.ok(actual.includes(direction));
  assert.ok(actual.includes("Example11"));
  assert.ok(actual.includes("Invented syllable blends"));
  assert.doesNotMatch(actual, /Use familiar, recognizable English/);
  assert.ok(result.candidates.some(entry => entry.name === "TaskHQ"));
  assert.deepEqual(result.prompts, [actual]);
});

test("pools retain exact inputs and reserve provenance; changed examples invalidate older pools", async () => {
  const state = emptyBrandState("tasks");
  let calls = 0;
  const request = async () => { calls++; return { candidates: names.map(name => ({ name })) }; };
  const first = await takeBatch(state, request);
  const pool = structuredClone(state.pools[0]);
  recordRound(state, { product: state.product, candidates: first, ...state.lastBatch });
  assert.equal(state.lastBatch?.origin, "generated");
  state.selected.push("Able");
  await takeBatch(state, request);
  assert.equal(calls, 1);
  assert.equal(state.lastBatch?.origin, "reserve");
  state.reserve = [{ name: "OldUnshown" }];
  state.brief.examples = ["TaskHQ"];
  const next = await takeBatch(state, request);
  assert.equal(calls, 2);
  assert.ok(!next.some(entry => entry.name === "OldUnshown"));
  assert.deepEqual(state.pools[0], pool);
  assert.deepEqual(state.pools[1].brief.examples, ["TaskHQ"]);
});

test("v2 migration backs up the original, preserves history/evidence and labels unknown provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brand-v2-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const env = { DATA: path.join(root, "data") };
  const target = getBrandStatePath(cwd, true, env);
  const original = JSON.stringify({ ...emptyBrandState("tasks"), version: 2, brief: { direction: "HQ could work", singleWord: true, maxLength: 12, domains: ["com"], checkPackages: false }, directionNotes: ["control center", "HQ could work"], rounds: [{ id: "old", createdAt: "2026-01-01", product: "tasks", candidates: [{ name: "Junction" }] }], liked: [{ name: "Junction", likedAt: "2026-01-01" }], reserve: [{ name: "Untraced" }], availability: { junction: { score: "good", checkedAt: "2026-01-01", reason: "original evidence", evidence: [{ source: "web", url: "https://example.com", detail: "retained passage" }] } } });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, original);
  const loaded = loadBrandState(cwd, true, env);
  assert.equal(fs.readFileSync(`${target}.v2-backup`, "utf8"), original);
  assert.equal(loaded.state.rounds[0].candidates[0].name, "Junction");
  assert.equal(loaded.state.liked[0].name, "Junction");
  assert.equal(loaded.state.availability.junction.evidence?.[0].detail, "retained passage");
  assert.deepEqual(loaded.state.reserve, []);
  assert.deepEqual(loaded.state.feedback.map(entry => entry.author), ["unknown", "unknown"]);
  assert.equal(loaded.state.rounds[0].origin, "legacy");
  assert.equal(loaded.state.pools.length, 0);
  assert.ok(fs.readFileSync(brandDocumentPaths(target).feedback, "utf8").includes("Original author and date are unknown"));
  assert.equal(loadBrandState(cwd, true, env).warnings.length, 0);
  assert.deepEqual(fs.readdirSync(cwd), []);
});
