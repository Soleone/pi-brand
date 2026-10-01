import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import register from "../src/index.ts";
import { loadBrandState } from "../src/store.ts";

const candidates = ["Able", "Bold", "Calm", "Daring", "Eager", "Fresh", "Grand", "Happy", "Ideal", "Jolly", "Keen", "Lively", "Merry", "Noble", "Open", "Proud", "Quick", "Ready", "Sharp", "Tidy", "Upbeat", "Vivid", "Warm", "Zesty"];
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } };

type TestTool = { name: string; execute: (id: string, params: never, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionToolContext) => Promise<{ content: { type: string; text: string }[]; terminate?: boolean }> };

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-brand-extension-"));
  const previous = process.env.PI_BRAND_CONFIG;
  process.env.PI_BRAND_CONFIG = path.join(root, "run.json");
  const tools = new Map<string, TestTool>();
  const events: string[] = [];
  const messages: string[] = [];
  const notices: string[] = [];
  const choices: string[] = [];
  const inputs: (string | undefined)[] = [];
  const dialogs: { title: string; choices: string[] }[] = [];
  const requestedModels: string[] = [];
  let modelCalls = 0;
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const pi = {
    registerTool: (tool: TestTool) => tools.set(tool.name, tool),
    registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => { commands.set(name, definition.handler); },
    sendUserMessage: (message: string) => messages.push(message),
    appendEntry: () => {},
    on: (event: string) => events.push(event),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, mode: "rpc", hasUI: true, scopedModels: [],
    isProjectTrusted: () => true, waitForIdle: async () => {},
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (title: string, options: string[]) => { dialogs.push({ title, choices: options }); return choices.shift(); },
      input: async () => inputs.shift(),
      custom: () => { throw new Error("RPC must not open a terminal component"); },
      confirm: async () => false,
    },
    model: { id: "gpt-6.1-sol" },
    modelRegistry: {
      find: (provider: string, id: string) => provider === "openai" && ["gpt-6-luna", "cheap-worker", "other-creative"].includes(id) ? { provider, id } : undefined,
      getAvailable: () => ["gpt-6-luna", "cheap-worker", "other-creative"].map((id) => ({ provider: "openai", id })),
      hasConfiguredAuth: () => true,
      streamSimple: (_model: { provider: string; id: string }, context: { systemPrompt: string; messages: { role: string; content: unknown }[]; tools: unknown[] }, options: { maxTokens: number; maxRetries: number; sessionId: string; cacheRetention: string }) => {
        modelCalls++;
        requestedModels.push(`${_model.provider}/${_model.id}`);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0].role, "user");
        assert.equal(context.tools.length, 1);
        const worker = context.systemPrompt.includes("preliminary brand collisions");
        assert.equal(options.maxTokens, worker ? 2000 : 3000);
        assert.match(options.sessionId, worker ? /pi-brand-v1-worker-/ : /pi-brand-v1-creative-/);
        assert.equal(options.cacheRetention, "short");
        assert.equal(options.maxRetries, 0);
        assert.doesNotMatch(JSON.stringify(context), /expensive main history/);
        const schema = context.tools[0] as { parameters: { properties: { results?: unknown } } };
        const items = schema.parameters.properties.results ? JSON.parse(String(context.messages[0].content).split("\n").at(-1)!) as { name: string; evidence: { url: string }[] }[] : undefined;
        const value = items ? { results: items.map((item) => ({ name: item.name, reason: "limited source findings", sourceUrls: item.evidence.map((source) => source.url), famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: null })) } : { candidates: candidates.map((name) => ({ name })) };
        return { result: async () => ({ stopReason: "toolUse", usage, content: [{ type: "toolCall", name: "submit_result", id: "call", arguments: value }] }) };
      },
    },
    sessionManager: { getBranch: () => { throw new Error("expensive main history must not be read"); } },
  } as unknown as ExtensionCommandContext;
  register(pi);
  return {
    ctx, events, tools, messages, notices, choices, inputs, dialogs, requestedModels,
    command: (args: string) => commands.get("brand")!(args, ctx),
    settings: () => commands.get("brand-settings")!("", ctx),
    state: () => loadBrandState(root, true).state,
    modelCalls: () => modelCalls,
    cleanup: () => { if (previous === undefined) delete process.env.PI_BRAND_CONFIG; else process.env.PI_BRAND_CONFIG = previous; fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("commands generate in isolation, reuse reserves and never inject main context", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save selection");
    await app.command("a todo app");
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().liked[0].name, "Able");
    assert.equal(app.state().reserve.length, 12);
    app.choices.push("[ ] Merry", "Save selection");
    await app.command("more");
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().liked.length, 2);
    assert.equal(app.state().generationMetrics.length, 1);
    assert.deepEqual(app.messages, []);
    assert.ok(!app.events.includes("before_agent_start"));
    assert.equal(app.ctx.model!.id, "gpt-6.1-sol");
  } finally { app.cleanup(); }
});

test("finalist selection is distinct from favorites and check dispatches just one owned operation", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "[ ] Bold", "Save selection");
    await app.command("tasks");
    await app.command("finalists Able");
    assert.deepEqual(app.state().finalists, ["Able"]);
    assert.equal(app.state().liked.length, 2);
    await app.command("check");
    assert.equal(app.messages.length, 1);
    assert.match(app.messages[0], /brand_check once/);
    assert.doesNotMatch(app.messages[0], /Bold/);
    await app.command("note short and confident");
    assert.deepEqual(app.state().reserve, []);
  } finally { app.cleanup(); }
});

test("favorite menu shows per-name status and dispatches selected-name checks", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save selection");
    await app.command("tasks");
    app.choices.push("Browse favorites", "Able · not checked", "Refresh status (deep)");
    await app.command("overview");
    assert.ok(app.dialogs.find((dialog) => dialog.title.startsWith("Favorites"))?.choices.includes("Able · not checked"));
    assert.match(app.messages[0], /brand_check once/);
    assert.match(app.messages[0], /stage deep, refresh true, and names \["Able"\]/);
  } finally { app.cleanup(); }
});

test("Check all is in the favorites list and checks every favorite in batches of three", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "[ ] Bold", "[ ] Calm", "[ ] Daring", "Save selection");
    await app.command("tasks");
    app.choices.push("Browse favorites", "Check all favorites (deep, cache first · 4)");
    await app.command("overview");
    const list = app.dialogs.find((dialog) => dialog.title.startsWith("Favorites"))!;
    assert.ok(list.choices.includes("Able · not checked"));
    assert.ok(list.choices.includes("Daring · not checked"));
    assert.match(app.messages[0], /allFavorites true/);

    let searches = 0;
    const toolCtx = {
      ...app.ctx,
      tools: [{ name: "web_search" }],
      executeTool: async (_name: string, args: { queries: string[] }) => {
        searches++;
        const name = args.queries[0].match(/^\"([^\"]+)\"/)![1];
        return { isError: false, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: `https://example.com/${name}`, snippet: "source-linked finding" }] }) }] } };
      },
    } as unknown as ExtensionToolContext;
    const result = await app.tools.get("brand_check")!.execute("check", { stage: "screen", allFavorites: true } as never, undefined, undefined, toolCtx);
    assert.equal(searches, 4);
    assert.equal(app.modelCalls(), 3);
    assert.deepEqual(app.state().finalists, []);
    for (const name of ["able", "bold", "calm", "daring"]) assert.equal(app.state().availability[name].stage, "screen");
    assert.match(result.content[0].text, /4 favorites checked/);
  } finally { app.cleanup(); }
});

test("brand_check can update one saved favorite without changing finalists", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "[ ] Bold", "Save selection");
    await app.command("tasks");
    let searches = 0;
    const toolCtx = {
      ...app.ctx,
      tools: [{ name: "web_search" }],
      executeTool: async (_name: string, args: { queries: string[] }) => {
        searches++;
        const name = args.queries[0].match(/^\"([^\"]+)\"/)![1];
        return { isError: false, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: `https://example.com/${name}`, snippet: "source-linked finding" }] }) }] } };
      },
    } as unknown as ExtensionToolContext;
    const result = await app.tools.get("brand_check")!.execute("check", { stage: "screen", names: ["Able"] } as never, undefined, undefined, toolCtx);
    assert.equal(searches, 1);
    assert.deepEqual(app.state().finalists, []);
    assert.equal(app.state().availability.able.stage, "screen");
    assert.equal(app.state().availability.bold, undefined);
    assert.match(result.content[0].text, /Able:/);
  } finally { app.cleanup(); }
});

test("owned cached checks need no web tool or model call and terminate without main follow-up", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save selection");
    await app.command("tasks");
    await app.command("finalists Able");
    await app.tools.get("brand_score")!.execute("record", { name: "Able", famousCollision: false } as never, undefined, undefined, app.ctx as unknown as ExtensionToolContext);
    const checkedAt = app.state().availability.able.checkedAt;
    const toolCtx = { ...app.ctx, tools: [], executeTool: () => { throw new Error("must not search"); } } as unknown as ExtensionToolContext;
    const result = await app.tools.get("brand_check")!.execute("check", {} as never, undefined, undefined, toolCtx);
    assert.equal(result.terminate, true);
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().availability.able.checkedAt, checkedAt);
    assert.match(result.content[0].text, /cached/);
  } finally { app.cleanup(); }
});

test("explicit screened mode checks only three names with one assessment and retains the reserve", async () => {
  const app = harness();
  try {
    await app.command("note familiar words");
    let searches = 0;
    const toolCtx = {
      ...app.ctx, tools: [{ name: "web_search" }],
      executeTool: async (_name: string, args: { queries: string[]; includeContent: boolean }) => {
        searches++;
        assert.equal(args.queries.length, 2);
        assert.equal(args.includeContent, false);
        const name = args.queries[0].match(/^"([^"]+)"/)![1];
        return { isError: false, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: `https://example.com/${name}`, snippet: "source-linked findings" }] }) }] } };
      },
    } as unknown as ExtensionToolContext;
    app.choices.push("[ ] Able", "Save selection");
    const result = await app.tools.get("brand_generate")!.execute("screened", { product: "tasks", screened: true } as never, undefined, undefined, toolCtx);
    assert.equal(result.terminate, true);
    assert.equal(searches, 3);
    assert.equal(app.modelCalls(), 2);
    assert.equal(app.state().rounds[0].candidates.length, 3);
    assert.equal(app.state().reserve.length, 21);
    assert.equal(app.state().availability.able.stage, "screen");
    assert.deepEqual(app.messages, []);
  } finally { app.cleanup(); }
});

test("compatibility cache lookup is batched and cannot invent a clean partial score", async () => {
  const app = harness();
  try {
    const tool = app.tools.get("brand_score")!;
    await tool.execute("one", { name: "Able", famousCollision: false } as never, undefined, undefined, app.ctx as unknown as ExtensionToolContext);
    assert.equal(app.state().availability.able.score, "unknown");
    const result = await tool.execute("two", { names: ["Able", "Bold"] } as never, undefined, undefined, app.ctx as unknown as ExtensionToolContext);
    assert.match(result.content[0].text, /"fresh":\["bold"\]/);
    assert.equal(result.terminate, undefined);
  } finally { app.cleanup(); }
});

test("overview pauses without rejecting candidates and resumes the same reserve for free", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Overview: save picks, reserve the rest", "Close overview");
    await app.command("tasks");
    assert.deepEqual(app.state().liked.map((entry) => entry.name), ["Able"]);
    assert.equal(app.state().reserve.length, 23);
    assert.deepEqual(app.state().rounds[0].candidates.map((entry) => entry.name), ["Able"]);
    assert.deepEqual(app.state().dismissed, []);
    assert.match(app.dialogs.at(-1)!.title, /1 favorites.*23 reserved/);
    app.choices.push("More names", "Overview: save picks, reserve the rest", "Close overview");
    await app.command("");
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().reserve.length, 23);
    const picker = [...app.dialogs].reverse().find((entry) => entry.title === "Pick favorites")!;
    assert.ok(picker.choices.includes("[ ] Bold"));
    assert.ok(!picker.choices.includes("[ ] Able"));
    assert.deepEqual(app.messages, []);
  } finally { app.cleanup(); }
});

test("empty pause and cancellation keep the entire batch available", async () => {
  const app = harness();
  try {
    app.choices.push("Overview: save picks, reserve the rest", "Close overview");
    await app.command("tasks");
    assert.equal(app.state().reserve.length, 24);
    assert.equal(app.state().rounds.length, 0);
    await app.command("more"); // no choice: cancel, then close overview
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().reserve.length, 24);
    assert.equal(app.state().rounds.length, 0);
    await app.command("status");
    assert.equal(app.modelCalls(), 1);
  } finally { app.cleanup(); }
});

test("model settings save atomically, isolate creative and worker routing, and retain cached evidence", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save selection", "Close overview");
    await app.command("tasks");
    app.choices.push("Worker (evidence assessment): same as creative", "openai/cheap-worker", "Save settings");
    await app.settings();
    assert.equal(app.state().workerModel, "openai/cheap-worker");
    assert.equal(app.state().reserve.length, 12);
    assert.equal(app.modelCalls(), 1);
    app.choices.push("Creative (name generation): openai/gpt-6-luna", "openai/other-creative", "Cancel");
    await app.settings();
    assert.equal(app.state().model, "openai/gpt-6-luna");
    assert.equal(app.state().reserve.length, 12);
    await app.command("finalists Able");
    const toolCtx = {
      ...app.ctx, tools: [{ name: "web_search" }],
      executeTool: async () => ({ isError: false, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://example.com/Able", snippet: "source findings" }] }) }] } }),
    } as unknown as ExtensionToolContext;
    await app.tools.get("brand_check")!.execute("check", { stage: "screen" } as never, undefined, undefined, toolCtx);
    assert.deepEqual(app.requestedModels, ["openai/gpt-6-luna", "openai/cheap-worker"]);
    const checkedAt = app.state().availability.able.checkedAt;
    await app.command("model openai/other-creative");
    assert.equal(app.state().reserve.length, 0);
    assert.equal(app.state().availability.able.checkedAt, checkedAt);
    assert.equal(app.state().workerModel, "openai/cheap-worker");
    await app.command("worker same");
    assert.equal(app.state().workerModel, undefined);
    await app.command("model unknown/missing");
    assert.equal(app.state().model, "openai/other-creative");
    assert.match(app.notices.at(-1)!, /unavailable/);
    assert.equal(app.ctx.model!.id, "gpt-6.1-sol");
  } finally { app.cleanup(); }
});

test("overview subviews return without model calls and a dismissed favorite leaves finalists", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save selection", "Close overview");
    await app.command("tasks");
    await app.command("finalists Able");
    app.choices.push("History and exclusions", "Reserved names", "Back", "Edit brief", "direction", "Browse favorites", "Able · not checked", "Read evidence", "Choose finalists", "Save selection", "Close overview");
    app.inputs.push("energetic verbs");
    await app.command("overview");
    assert.equal(app.state().brief.direction, "energetic verbs");
    assert.equal(app.modelCalls(), 1);
    assert.deepEqual(app.state().finalists, ["Able"]);
    await app.command("dismiss Able");
    assert.deepEqual(app.state().liked, []);
    assert.deepEqual(app.state().finalists, []);
    assert.ok(app.state().dismissed.includes("Able"));
    assert.equal(app.state().rounds[0].candidates[0].name, "Able");
  } finally { app.cleanup(); }
});

test("default worker reuses the creative model ID but not its request profile", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save selection", "Close overview");
    await app.command("tasks");
    await app.command("finalists Able");
    const toolCtx = {
      ...app.ctx, tools: [{ name: "web_search" }],
      executeTool: async () => ({ isError: false, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://example.com/Able", snippet: "source findings" }] }) }] } }),
    } as unknown as ExtensionToolContext;
    await app.tools.get("brand_check")!.execute("check", { stage: "screen" } as never, undefined, undefined, toolCtx);
    assert.deepEqual(app.requestedModels, ["openai/gpt-6-luna", "openai/gpt-6-luna"]);
  } finally { app.cleanup(); }
});

test("invalid overview edits show a recoverable error without closing the workspace", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save selection", "Close overview");
    await app.command("tasks");
    app.choices.push("Edit brief", "length", "Generation stats", "Close overview");
    app.inputs.push("99");
    await app.command("overview");
    assert.equal(app.state().brief.maxLength, 12);
    assert.ok(app.dialogs.some((dialog) => dialog.choices.includes("Generation stats")));
    assert.match(app.notices.find((notice) => notice.includes("Length must")) ?? "", /3-30/);
    assert.equal(app.modelCalls(), 1);
  } finally { app.cleanup(); }
});

test("compatibility pause retains all 30 supplied candidates across reload, not just 24", async () => {
  const app = harness();
  try {
    const supplied = Array.from({ length: 30 }, (_, index) => ({ name: `Name${index}` }));
    app.choices.push("Overview: save picks, reserve the rest", "Close overview");
    await app.tools.get("brand_pick")!.execute("pick", { product: "tasks", candidates: supplied } as never, undefined, undefined, app.ctx as unknown as ExtensionToolContext);
    assert.equal(app.state().reserve.length, 30);
    assert.equal(app.state().rounds.length, 0);
    assert.equal(app.modelCalls(), 0);
    app.choices.push("Overview: save picks, reserve the rest", "Close overview");
    await app.command("more");
    assert.equal(app.state().reserve.length, 30);
    assert.equal(app.modelCalls(), 0);
  } finally { app.cleanup(); }
});

test("overview explicitly controls check stage and refresh without changing the saved brief", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save selection", "Close overview");
    await app.command("tasks");
    await app.command("finalists Able");
    app.choices.push("Check finalists", "Refresh quick screen");
    await app.command("overview");
    assert.equal(app.messages.length, 1);
    assert.match(app.messages[0], /screen/);
    assert.match(app.messages[0], /refresh true/);
    assert.equal(app.state().product, "tasks");
    assert.equal(app.modelCalls(), 1);
  } finally { app.cleanup(); }
});
