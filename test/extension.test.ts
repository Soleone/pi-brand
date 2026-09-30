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
  let modelCalls = 0;
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    registerTool: (tool: TestTool) => tools.set(tool.name, tool),
    registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
    sendUserMessage: (message: string) => messages.push(message),
    appendEntry: () => {},
    on: (event: string) => events.push(event),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, mode: "rpc", hasUI: true,
    isProjectTrusted: () => true, waitForIdle: async () => {},
    ui: {
      notify: (message: string) => notices.push(message),
      select: async () => choices.shift(),
      custom: () => { throw new Error("RPC must not open a terminal component"); },
      confirm: async () => false,
    },
    model: { id: "gpt-6.1-sol" },
    modelRegistry: {
      find: (provider: string, id: string) => provider === "openai" && id === "gpt-6-luna" ? { provider, id } : undefined,
      hasConfiguredAuth: () => true,
      streamSimple: (_model: unknown, context: { messages: { role: string; content: unknown }[]; tools: unknown[] }, options: { maxTokens: number; maxRetries: number }) => {
        modelCalls++;
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0].role, "user");
        assert.equal(context.tools.length, 1);
        assert.equal(options.maxTokens, 3000);
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
    ctx, events, tools, messages, notices, choices,
    command: (args: string) => command!(args, ctx),
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
