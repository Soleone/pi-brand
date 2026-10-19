import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyBriefChanges, formatBrief, namingContent } from "../src/brief.ts";
import { brandDocumentPaths, getBrandStatePath, loadBrandState, saveBrandState, saveFeedbackDocument } from "../src/store.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brand-documents-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const env = { DATA: path.join(root, "data") };
  return { root, cwd, env, home: path.join(root, "home") };
}

test("all documents use external DATA/apps storage with private permissions", () => {
  const { cwd, env, home } = fixture();
  const run = loadBrandState(cwd, true, env, home);
  applyBriefChanges(run.state, { product: "task hub" }, { text: "task hub", author: "user", source: "command" });
  saveBrandState(run.path, run.state);
  for (const target of [run.path, ...Object.values(brandDocumentPaths(run.path))]) {
    assert.ok(target.startsWith(path.join(env.DATA, "apps", "pi-brand")));
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test("XDG and home fallbacks are external; local overrides and symlink escapes are rejected", () => {
  const { cwd, root, home } = fixture();
  assert.ok(getBrandStatePath(cwd, true, {}, home).startsWith(path.join(home, ".local", "share", "pi-brand")));
  assert.ok(getBrandStatePath(cwd, true, { XDG_DATA_HOME: path.join(root, "xdg") }, home).startsWith(path.join(root, "xdg", "pi-brand")));
  assert.throws(() => getBrandStatePath(cwd, true, { PI_BRAND_CONFIG: ".pi/run.json" }, home), /outside the project/);
  assert.throws(() => getBrandStatePath(cwd, true, { DATA: cwd }, home), /outside the project/);
  const link = path.join(root, "escape");
  fs.symlinkSync(cwd, link);
  assert.throws(() => getBrandStatePath(cwd, true, { DATA: link }, home), /outside the project/);
});

test("repository subdirectories and document symlinks cannot redirect data into a project", () => {
  const { cwd, root, home } = fixture();
  fs.mkdirSync(path.join(cwd, ".git"));
  const nested = path.join(cwd, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });
  assert.throws(() => getBrandStatePath(nested, true, { PI_BRAND_CONFIG: path.join(cwd, "run.json") }, home), /outside the project/);
  const target = path.join(root, "external", "run.json");
  fs.mkdirSync(path.dirname(target));
  fs.symlinkSync(path.join(cwd, "brief.md"), brandDocumentPaths(target).brief);
  assert.throws(() => loadBrandState(nested, true, { PI_BRAND_CONFIG: target }, home), /outside the project/);
  assert.equal(fs.existsSync(path.join(cwd, "brief.md")), false);
});

test("direct brief edits are authoritative, attributed and invalidate old reserves", () => {
  const { cwd, env, home } = fixture();
  const run = loadBrandState(cwd, true, env, home);
  run.state.product = "task hub";
  run.state.reserve = [{ name: "Old" }];
  saveBrandState(run.path, run.state);
  const docs = brandDocumentPaths(run.path);
  const content = { ...namingContent(run.state), direction: "Control center", examples: ["TaskHQ"] };
  fs.writeFileSync(docs.brief, formatBrief(content));
  const loaded = loadBrandState(cwd, true, env, home);
  assert.equal(loaded.state.brief.direction, "Control center");
  assert.equal(loaded.state.feedback.at(-1)?.source, "file");
  assert.equal(loaded.state.feedback.at(-1)?.author, "unknown");
  assert.deepEqual(loaded.state.reserve, []);
  saveBrandState(loaded.path, loaded.state);
  assert.equal(loadBrandState(cwd, true, env, home).state.briefRevision, 2);
  assert.ok(fs.readFileSync(docs.feedback, "utf8").includes("Control center"));
});

test("concurrent and invalid document edits cannot be overwritten", () => {
  const { cwd, env, home } = fixture();
  const run = loadBrandState(cwd, true, env, home);
  saveBrandState(run.path, run.state);
  const docs = brandDocumentPaths(run.path);
  fs.writeFileSync(docs.brief, "broken document");
  assert.throws(() => saveBrandState(run.path, run.state), /changed on disk/);
  assert.throws(() => loadBrandState(cwd, true, env, home), /must contain/);
  assert.equal(fs.readFileSync(docs.brief, "utf8"), "broken document");
});

test("feedback annotations survive later updates; originals remain in structured history", () => {
  const { cwd, env, home } = fixture();
  const run = loadBrandState(cwd, true, env, home);
  applyBriefChanges(run.state, { direction: "HQ" }, { text: "original wording", source: "chat", author: "user" });
  saveBrandState(run.path, run.state);
  const docs = brandDocumentPaths(run.path);
  const original = fs.readFileSync(docs.feedback, "utf8");
  saveFeedbackDocument(run.path, original + "\nMy correction: headquarters, not a literal HQ suffix.\n", original);
  applyBriefChanges(run.state, { style: "Plain" }, { text: "plain please", source: "picker", author: "user" });
  saveBrandState(run.path, run.state);
  const history = fs.readFileSync(docs.feedback, "utf8");
  assert.ok(history.includes("My correction"));
  assert.equal(history.match(/> original wording/g)?.length, 1);
  assert.equal(loadBrandState(cwd, true, env, home).state.feedback[0].text, "original wording");
});
