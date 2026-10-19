import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import register from "../src/index.ts";
import { CHECK_RESEARCH_VERSION } from "../src/checker.ts";
import { loadBrandState, saveBrandState } from "../src/store.ts";

const candidates = ["Able", "Bold", "Calm", "Daring", "Eager", "Fresh", "Grand", "Happy", "Ideal", "Jolly", "Keen", "Lively", "Merry", "Noble", "Open", "Proud", "Quick", "Ready", "Sharp", "Tidy", "Upbeat", "Vivid", "Warm", "Zesty"];
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } };

type TestTool = { name: string; execute: (id: string, params: never, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionToolContext) => Promise<{ content: { type: string; text: string }[]; terminate?: boolean }> };

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-brand-extension-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
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
  const briefUpdates: Record<string, unknown>[] = [];
  const requests: { role: string; prompt: string }[] = [];
  const editors: { title: string; prefill: string }[] = [];
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
    cwd: project, mode: "rpc", hasUI: true, scopedModels: [],
    isProjectTrusted: () => true, waitForIdle: async () => {},
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (title: string, options: string[]) => { dialogs.push({ title, choices: options }); return choices.shift(); },
      input: async () => inputs.shift(),
      editor: async (title: string, prefill: string) => { editors.push({ title, prefill }); return inputs.shift(); },
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
        const briefRole = context.systemPrompt.includes("You edit a product naming brief");
        requests.push({ role: briefRole ? "brief" : worker ? "worker" : "creative", prompt: String(context.messages[0].content) });
        assert.equal(options.maxTokens, worker || briefRole ? 2000 : 3000);
        assert.match(options.sessionId, briefRole ? /pi-brand-v1-brief-/ : worker ? /pi-brand-v1-worker-/ : /pi-brand-v1-creative-/);
        assert.equal(options.cacheRetention, "short");
        assert.equal(options.maxRetries, 0);
        assert.doesNotMatch(JSON.stringify(context), /expensive main history/);
        const schema = context.tools[0] as { parameters: { properties: { results?: unknown } } };
        const items = schema.parameters.properties.results ? JSON.parse(String(context.messages[0].content).split("\n").at(-1)!) as { name: string; evidence: { url: string }[] }[] : undefined;
        const value = briefRole ? (briefUpdates.shift() ?? { style: "short and confident" }) : items ? { results: items.map((item) => ({ name: item.name, reason: "limited source findings", sourceUrls: item.evidence.map((source) => source.url), famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: null })) } : { candidates: candidates.map((name) => ({ name })) };
        return { result: async () => ({ stopReason: "toolUse", usage, content: [{ type: "toolCall", name: "submit_result", id: "call", arguments: value }] }) };
      },
    },
    sessionManager: { getBranch: () => { throw new Error("expensive main history must not be read"); } },
  } as unknown as ExtensionCommandContext;
  register(pi);
  return {
    ctx, events, tools, messages, notices, choices, inputs, dialogs, requestedModels, briefUpdates, requests, editors,
    command: (args: string) => commands.get("brand")!(args, ctx),
    settings: () => commands.get("brand-settings")!("", ctx),
    state: () => loadBrandState(project, true).state,
    modelCalls: () => modelCalls,
    cleanup: () => { if (previous === undefined) delete process.env.PI_BRAND_CONFIG; else process.env.PI_BRAND_CONFIG = previous; fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("commands generate in isolation, reuse reserves and never inject main context", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save and close");
    await app.command("a todo app");
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().liked[0].name, "Able");
    assert.equal(app.state().reserve.length, 12);
    app.choices.push("[ ] Merry", "Save and close");
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
    app.choices.push("[ ] Able", "[ ] Bold", "Save and close");
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
    app.choices.push("[ ] Able", "Save and close");
    await app.command("tasks");
    app.choices.push("Review favorites", "Able · not checked", "Details", "Refresh availability");
    await app.command("overview");
    assert.ok(app.dialogs.find((dialog) => dialog.title.startsWith("Review favorites"))?.choices.includes("Able · not checked"));
    assert.match(app.messages[0], /brand_check once/);
    assert.match(app.messages[0], /stage deep, refresh true, and names \["Able"\]/);
  } finally { app.cleanup(); }
});

test("Check all is in the favorites list and checks every favorite in batches of three", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "[ ] Bold", "[ ] Calm", "[ ] Daring", "Save and close");
    await app.command("tasks");
    app.choices.push("Review favorites", "Check all favorites");
    await app.command("overview");
    const list = app.dialogs.find((dialog) => dialog.title.startsWith("Review favorites"))!;
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
    assert.equal(result.terminate, undefined);
  } finally { app.cleanup(); }
});

test("brand_check can update one saved favorite without changing finalists", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "[ ] Bold", "Save and close");
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

test("deep check upgrades an old unknown automatically and retries an empty search response", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save and close");
    await app.command("app for learning or retaining information");
    const saved = loadBrandState(app.ctx.cwd, true);
    saved.state.availability.able = { score: "unknown", reason: "incomplete collision evidence", checkedAt: "2025-01-01", stage: "deep" };
    saveBrandState(saved.path, saved.state);

    let searches = 0;
    const toolCtx = {
      ...app.ctx,
      tools: [{ name: "web_search" }],
      executeTool: async (_name: string, args: { queries: string[]; numResults: number }) => {
        searches++;
        assert.equal(args.queries.length, 2);
        assert.equal(args.numResults, 3);
        if (searches === 1) return { isError: false, result: { content: [{ type: "text", text: "Search provider rate limited this request." }] } };
        return { isError: false, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://ablelearning.example/", title: "Able learning app", snippet: "A memory and flashcard app for learning new material." }] }) }] } };
      },
    } as unknown as ExtensionToolContext;
    await app.tools.get("brand_check")!.execute("check", { stage: "deep", names: ["Able"] } as never, undefined, undefined, toolCtx);
    assert.equal(searches, 2);
    assert.equal(app.state().availability.able.score, "terrible");
    assert.equal(app.state().availability.able.researchVersion, CHECK_RESEARCH_VERSION);
    assert.equal(app.state().liked[0].score, "terrible");
  } finally { app.cleanup(); }
});

test("owned cached checks need no web tool or model call and allow automatic completion", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save and close");
    await app.command("tasks");
    await app.command("finalists Able");
    await app.tools.get("brand_score")!.execute("record", { name: "Able", famousCollision: false } as never, undefined, undefined, app.ctx as unknown as ExtensionToolContext);
    const checkedAt = app.state().availability.able.checkedAt;
    const toolCtx = { ...app.ctx, tools: [], executeTool: () => { throw new Error("must not search"); } } as unknown as ExtensionToolContext;
    const result = await app.tools.get("brand_check")!.execute("check", {} as never, undefined, undefined, toolCtx);
    assert.equal(result.terminate, undefined);
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
    app.choices.push("[ ] Able", "Save and close");
    const result = await app.tools.get("brand_generate")!.execute("screened", { product: "tasks", screened: true } as never, undefined, undefined, toolCtx);
    assert.equal(result.terminate, true);
    assert.equal(searches, 3);
    assert.equal(app.modelCalls(), 3);
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

test("closing saves explicit picks and never rewrites the viewed round", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save and close");
    await app.command("tasks");
    assert.deepEqual(app.state().liked.map(entry => entry.name), ["Able"]);
    assert.equal(app.state().rounds[0].candidates.length, 12);
    assert.deepEqual(app.state().dismissed, []);
    assert.equal(app.state().reserve.length, 12);
    app.choices.push("More names", "Save and close");
    await app.command("");
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().rounds[1].origin, "reserve");
    assert.equal(app.state().rounds[0].candidates.length, 12);
    assert.ok(app.dialogs.some(dialog => dialog.title.includes("no new generation")));
  } finally { app.cleanup(); }
});

test("favorites can be checked without a finalist promotion", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "[ ] Bold", "Review favorites", "Check selected favorites", "[ ] Able", "Save and close");
    await app.command("tasks");
    assert.deepEqual(app.state().finalists, []);
    assert.match(app.messages[0], /names \["Able"\]/);
    assert.doesNotMatch(app.messages[0], /Bold/);
  } finally { app.cleanup(); }
});

test("chat feedback retains the raw comment and only changes explicitly interpreted fields", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close");
    await app.command("tasks");
    const tool = app.tools.get("brand_feedback")!;
    const ctx = app.ctx as unknown as ExtensionToolContext;
    await tool.execute("first", { feedback: "task center, all clients", changes: { direction: "Task/control center across clients", avoid: "Invented syllables" } } as never, undefined, undefined, ctx);
    await tool.execute("second", { feedback: "hq could work too e.g. taskhq", changes: { examples: ["TaskHQ"] } } as never, undefined, undefined, ctx);
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().brief.direction, "Task/control center across clients");
    assert.equal(app.state().brief.avoid, "Invented syllables");
    assert.deepEqual(app.state().brief.examples, ["TaskHQ"]);
    assert.equal(app.state().feedback.at(-1)?.text, "hq could work too e.g. taskhq");
    assert.equal(app.state().feedback.at(-1)?.source, "chat");
    assert.deepEqual(app.state().reserve, []);
    assert.ok(app.notices.at(-1)?.includes("Other sections kept"));
  } finally { app.cleanup(); }
});

test("picker and command feedback use the same isolated brief editor", async () => {
  for (const source of ["picker", "command"]) {
    const app = harness();
    try {
      app.briefUpdates.push({ direction: "Control center plus HQ", examples: ["TaskHQ"] });
      if (source === "picker") {
        app.choices.push("Give feedback", "Save and close");
        app.inputs.push("HQ too");
        await app.command("tasks");
      } else {
        app.choices.push("Save and close");
        await app.command("tasks");
        await app.command("note HQ too");
      }
      assert.equal(app.state().feedback.at(-1)?.source, source);
      assert.equal(app.state().feedback.at(-1)?.text, "HQ too");
      assert.equal(app.requests.filter(request => request.role === "brief").length, 1);
      assert.deepEqual(app.state().brief.examples, ["TaskHQ"]);
      assert.equal(app.state().brief.direction, "Control center plus HQ");
    } finally { app.cleanup(); }
  }
});

test("more-like uses a reference without silently saving it as a favorite", async () => {
  const app = harness();
  try {
    app.briefUpdates.push({ examples: ["Able"] });
    app.choices.push("Batch details", "More like a name", "Able", "Save and close");
    await app.command("tasks");
    assert.deepEqual(app.state().liked, []);
    assert.deepEqual(app.state().brief.examples, ["Able"]);
    assert.equal(app.state().feedback.at(-1)?.source, "similar");
  } finally { app.cleanup(); }
});

test("brief editor is one document; invalid edits recover without overwriting it", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close");
    await app.command("tasks");
    app.inputs.push("invalid document");
    app.choices.push("Brief / Details", "Edit naming brief", "Close");
    await app.command("");
    assert.ok(app.notices.some(notice => notice.includes("must contain")));
    assert.equal(app.state().product, "tasks");
    const text = app.editors.find(editor => editor.title.startsWith("Naming brief"))!.prefill;
    app.inputs.push(text.replace("## Explore\n", "## Explore\nControl center\n"));
    await app.command("brief edit");
    assert.equal(app.state().brief.direction, "Control center");
    assert.equal(app.state().feedback.at(-1)?.source, "brief-editor");
  } finally { app.cleanup(); }
});

test("context and round inspection expose saved inputs, unaffected by later edits", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close");
    await app.command("tasks");
    const round = app.state().rounds[0];
    const original = app.state().pools[0].prompts[0];
    assert.equal(round.origin, "generated");
    await app.tools.get("brand_feedback")!.execute("f", { feedback: "HQ please", changes: { examples: ["TaskHQ"] } } as never, undefined, undefined, app.ctx as unknown as ExtensionToolContext);
    const result = await app.tools.get("brand_context")!.execute("context", { section: "round", roundId: round.id } as never, undefined, undefined, app.ctx as unknown as ExtensionToolContext);
    const snapshot = JSON.parse(result.content[0].text);
    assert.equal(snapshot.pool.prompts[0], original);
    assert.deepEqual(snapshot.pool.brief.examples, []);
    assert.ok(snapshot.pool.systemPrompt.includes("product naming"));
    const brief = await app.tools.get("brand_context")!.execute("context", {} as never, undefined, undefined, app.ctx as unknown as ExtensionToolContext);
    assert.match(brief.content[0].text, /TaskHQ/);
    assert.match(brief.content[0].text, /\.brief\.md/);
  } finally { app.cleanup(); }
});

test("failed interpretation retains the original feedback without changing the brief", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close");
    await app.command("tasks");
    const revision = app.state().briefRevision;
    app.briefUpdates.push({ maxLength: 99 });
    await app.command("note HQ please");
    assert.equal(app.state().briefRevision, revision);
    assert.equal(app.state().feedback.at(-1)?.text, "HQ please");
    assert.ok(app.state().feedback.at(-1)?.error);
    assert.equal(app.state().reserve.length, 12);
  } finally { app.cleanup(); }
});

test("models remain in settings; worker routing does not change creative input or main model", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save and close");
    await app.command("tasks");
    app.choices.push("Worker (evidence assessment): same as creative", "openai/cheap-worker", "Save settings");
    await app.settings();
    assert.equal(app.state().workerModel, "openai/cheap-worker");
    assert.equal(app.state().reserve.length, 12);
    app.choices.push("Creative (name generation): openai/gpt-6-luna", "openai/other-creative", "Cancel");
    await app.settings();
    assert.equal(app.state().model, "openai/gpt-6-luna");
    await app.command("model openai/other-creative");
    assert.deepEqual(app.state().reserve, []);
    assert.equal(app.ctx.model!.id, "gpt-6.1-sol");
  } finally { app.cleanup(); }
});
