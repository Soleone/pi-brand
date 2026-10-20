import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatShortlist } from "../src/shortlist.ts";
import { saveShortlistDocument } from "../src/store.ts";
import { emptyBrandState } from "../src/types.ts";

test("shortlists are saved-evidence snapshots ordered by finding, not new research", () => {
  const state = emptyBrandState("A todo app");
  state.liked = ["Colliding", "Unchecked", "Promising", "Review", "Failed"].map(name => ({ name, likedAt: "2026-01-01" }));
  state.availability.promising = { score: "perfect", reason: "No observed collision", checkedAt: "2026-01-01", stage: "screen", searchQueries: ['"Promising"'] };
  state.availability.colliding = { score: "terrible", reason: "Same-category use", checkedAt: "2026-01-02", evidence: [{ source: "web", url: "https://example.com/brand", detail: "A named competing app" }] };
  state.availability.review = { score: "review", reason: "Audience unclear", checkedAt: "2026-01-02" };
  state.availability.failed = { score: "error", reason: "Search offline", checkedAt: "2026-01-02" };
  const before = JSON.stringify(state);
  const output = formatShortlist(state);
  assert.ok(output.indexOf("## Promising") < output.indexOf("## Colliding"));
  for (const finding of ["clear", "needs review", "check failed", "Not checked", "Search offline", 'Search: "Promising"', "https://example.com/brand", "not trademark clearance"]) assert.ok(output.includes(finding), finding);
  assert.equal(JSON.stringify(state), before);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brand-shortlist-"));
  try {
    const saved = saveShortlistDocument(path.join(root, "run.json"), output);
    assert.equal(fs.readFileSync(saved, "utf8"), output);
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    saveShortlistDocument(path.join(root, "run.json"), output);
    assert.deepEqual(fs.readdirSync(root), ["run.shortlist.md"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("empty favorites fail usefully and names cannot inject markdown or HTML", () => {
  const state = emptyBrandState();
  assert.throws(() => formatShortlist(state), /Favorite a few names first/);
  state.liked = [{ name: "<script>\n# injected", likedAt: "2026-01-01" }];
  const output = formatShortlist(state);
  assert.doesNotMatch(output, /<script>|\n# injected/);
});
