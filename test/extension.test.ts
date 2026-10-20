import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import register from "../src/index.ts";
import { formatScore } from "../src/scoring.ts";
import { CHECK_RESEARCH_VERSION } from "../src/checker.ts";
import { loadBrandState, saveBrandState } from "../src/store.ts";

const candidates = ["Able", "Bold", "Calm", "Daring", "Eager", "Fresh", "Grand", "Happy", "Ideal", "Jolly", "Keen", "Lively", "Merry", "Noble", "Open", "Proud", "Quick", "Ready", "Sharp", "Tidy", "Upbeat", "Vivid", "Warm", "Zesty"];
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } };

type TestTool = { name: string; execute: (id: string, params: never, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionToolContext) => Promise<{ content: { type: string; text: string }[]; terminate?: boolean; isError?: boolean }> };

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-brand-extension-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const previous = process.env.PI_BRAND_CONFIG;
  process.env.PI_BRAND_CONFIG = path.join(root, "run.json");
  const tools = new Map<string, TestTool>();
  const events: string[] = [];
  const eventHandlers = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
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
    on: (event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => { events.push(event); eventHandlers.set(event, handler); },
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
        const value = briefRole ? (briefUpdates.shift() ?? { style: "short and confident" }) : items ? { results: items.map((item) => ({ name: item.name, reason: "limited source findings", sourceUrls: item.evidence.map((source) => source.url), famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: null, needsReview: false })) } : { candidates: candidates.map((name) => ({ name })) };
        return { result: async () => ({ stopReason: "toolUse", usage, content: [{ type: "toolCall", name: "submit_result", id: "call", arguments: value }] }) };
      },
    },
    sessionManager: { getSessionId: () => "test-session", getBranch: () => { throw new Error("expensive main history must not be read"); } },
  } as unknown as ExtensionCommandContext;
  register(pi);
  return {
    ctx, events, tools, messages, notices, choices, inputs, dialogs, requestedModels, briefUpdates, requests, editors,
    emit: async (event: string) => {
      await eventHandlers.get(event)?.({ type: event }, ctx);
      await new Promise<void>(resolve => setImmediate(resolve));
      await withFileMutationQueue(loadBrandState(project, true).path, async () => {});
    },
    command: (args: string) => commands.get("brand")!(args, ctx),
    settings: () => commands.get("brand-settings")!("", ctx),
    state: () => loadBrandState(project, true).state,
    modelCalls: () => modelCalls,
    cleanup: () => { if (previous === undefined) delete process.env.PI_BRAND_CONFIG; else process.env.PI_BRAND_CONFIG = previous; fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function terminalScripts(ctx: ExtensionCommandContext, scripts: string[][]): string[][] {
  const frames: string[][] = [];
  Object.assign(ctx, { mode: "tui" });
  Object.assign(ctx.ui, { custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => {
    let result: unknown;
    const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, value => { result = value; });
    const keys = scripts.shift();
    assert.ok(keys, "unexpected extra screen");
    frames.push(component.render(80));
    for (const key of keys) { component.handleInput(key); frames.push(component.render(80)); }
    assert.ok(result, "script did not finish the screen");
    return result;
  } });
  return frames;
}

test("terminal bulk marks do not alter taste or block reserve reuse", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close");
    await app.command("a todo app");
    const scripts = [[" ", "g", "\r"], ["f", "\x1b"]];
    terminalScripts(app.ctx, scripts);
    await app.command("");
    assert.equal(scripts.length, 0);
    assert.equal(app.modelCalls(), 1);
    assert.deepEqual(app.state().liked.map(entry => entry.name), ["Merry"]);
    assert.deepEqual(app.state().dismissed, []);
    assert.equal(app.state().rounds.length, 2);
    assert.equal(app.state().rounds.at(-1)?.origin, "reserve");
  } finally { app.cleanup(); }
});

test("manually added names persist, receive focus and can be checked and favorited without a saved round", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const rounds = app.state().rounds;
    app.inputs.push("  Handpicked  ");
    terminalScripts(app.ctx, [["\t", "n"], ["\r", "c"]]);
    await app.command("");
    assert.ok(app.state().selected.includes("Handpicked"));
    assert.deepEqual(app.state().liked, []);
    assert.deepEqual(app.state().rounds, rounds);
    assert.equal(app.state().availability.handpicked, undefined);
    assert.equal(app.modelCalls(), 1);
    assert.match(app.messages[0], /names \["Handpicked"\]/);
    await app.tools.get("brand_check")!.execute("check", { names: ["Handpicked"], stage: "screen" } as never, undefined, undefined, researchContext(app.ctx, []));
    assert.ok(app.state().availability.handpicked);
    terminalScripts(app.ctx, [[" ", "f", "\x1b", "\x1b"]]);
    await app.emit("agent_end");
    assert.deepEqual(app.state().liked.map(entry => entry.name), ["Handpicked"]);
    assert.deepEqual(app.state().rounds, rounds);
  } finally { app.cleanup(); }
});

test("manual duplicates reuse saved names and evidence; discarded names can be restored", async () => {
  for (const restore of [false, true]) {
    const app = harness();
    try {
      app.choices.push("[ ] Able", "Save and close"); await app.command("tasks");
      if (restore) await app.command("dismiss Able");
      const saved = loadBrandState(app.ctx.cwd, true);
      saved.state.availability.able = { score: "good", reason: "Retained evidence", checkedAt: "2026-01-01", stage: "deep" };
      saveBrandState(saved.path, saved.state);
      app.inputs.push("  aBlE  ");
      terminalScripts(app.ctx, [["N"], ["\r", "c"]]);
      await app.command("");
      assert.equal(app.state().selected.length, 12);
      assert.deepEqual(app.state().dismissed, []);
      assert.equal(app.state().rounds.length, 1);
      assert.equal(app.state().liked.length, restore ? 0 : 1);
      assert.equal(app.state().availability.able.reason, "Retained evidence");
      assert.match(app.messages[0], /names \["Able"\]/);
      assert.equal(app.modelCalls(), 1);
    } finally { app.cleanup(); }
  }
});

test("cancelled, empty and invalid manual names leave the list unchanged", async () => {
  for (const input of [undefined, "   ", "x".repeat(61), "bad\u001b[31mname"]) {
    const app = harness();
    try {
      app.choices.push("Save and close"); await app.command("tasks");
      const before = app.state();
      app.inputs.push(input);
      const frames = terminalScripts(app.ctx, [["/", "a", "\r", "n"], ["\x1b", "\x1b"]]);
      await app.command("");
      assert.deepEqual(app.state(), before);
      assert.deepEqual(app.messages, []);
      assert.equal(app.modelCalls(), 1);
      assert.ok(frames.some(frame => frame.some(line => line.startsWith("/ ") && line.includes("a"))));
      if (input?.trim()) assert.ok(app.notices.some(notice => notice.includes("single-line name")));
    } finally { app.cleanup(); }
  }
});

test("terminal check shortcut dispatches immediately without a confirmation screen", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const scripts = [[" ", "\x1b[B", " ", "c"]];
    terminalScripts(app.ctx, scripts);
    await app.command("");
    assert.equal(scripts.length, 0);
    assert.equal(app.messages.length, 1);
    assert.match(app.messages[0], /brand_check once.*\["Able","Bold"\].*batch true/);
    assert.deepEqual(app.state().liked, []);
  } finally { app.cleanup(); }
});

test("command-owned checks reopen the updated list with its filter, cursor and marks", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    terminalScripts(app.ctx, [["/", "a", "\r", "\x1b[B", " ", "c"]]);
    await app.command("");
    assert.match(app.messages[0], /names \["Calm"\]/);
    const searches: string[] = [];
    await app.tools.get("brand_check")!.execute("check", { names: ["Calm"], batch: true } as never, undefined, undefined, researchContext(app.ctx, searches));
    const scripts = [[" ", "f", "\x1b", "\x1b"]];
    const frames = terminalScripts(app.ctx, scripts);
    await app.emit("agent_end");
    assert.equal(scripts.length, 0);
    assert.ok(frames[0]!.some(line => line.startsWith("/ ") && line.includes("a")));
    assert.match(frames[0]!.find(line => line.includes("Calm"))!, new RegExp(`^ Calm\\s+[] ${formatScore(app.state().availability.calm.score)}`));
    assert.ok(!frames[0]!.some(line => line.includes("Bold")));
    assert.deepEqual(app.state().liked.map(entry => entry.name), ["Calm"]);
    assert.deepEqual(searches, ["Calm"]);
    assert.equal(app.messages.length, 1);
    await app.emit("agent_end"); // Closing the restored list must not reopen it again.
  } finally { app.cleanup(); }
});

test("restoring an open menu never blocks agent_end and leaves check status cleared", async () => {
  const app = harness();
  let close: ((value: unknown) => void) | undefined;
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    terminalScripts(app.ctx, [["c"]]); await app.command("");
    const statuses: (string | undefined)[] = [];
    Object.assign(app.ctx.ui, { setStatus: (_key: string, text: string | undefined) => statuses.push(text) });
    await app.tools.get("brand_check")!.execute("check", { names: ["Able"], stage: "screen" } as never, undefined, undefined, researchContext(app.ctx, []));
    assert.match(statuses[0]!, /Checking names 1-1 of 1/);
    assert.equal(statuses.at(-1), undefined);
    let frame = "";
    Object.assign(app.ctx.ui, { custom: (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => new Promise(resolve => {
      close = resolve;
      const component = factory({ requestRender() {} } as never, { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never, {} as never, resolve);
      frame = (component as { render(width: number): string[] }).render(100).join("\n");
    }) });
    const ended = await Promise.race([
      app.emit("agent_end").then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(ended, true, "agent_end must return while the restored menu is still open");
    assert.match(frame, /Check finished: 1 name; 1 assessed, 0 need review, 0 failed/);
    assert.doesNotMatch(frame, /Checking names|unknown|inconclusive/);
  } finally {
    close?.({ favoriteChanges: [] });
    await new Promise<void>(resolve => setImmediate(resolve));
    app.cleanup();
  }
});

test("multi-batch check progress clears only after all batches finish", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const statuses: (string | undefined)[] = [];
    Object.assign(app.ctx.ui, { setStatus: (_key: string, text: string | undefined) => statuses.push(text) });
    const result = await app.tools.get("brand_check")!.execute("check", { names: candidates.slice(0, 6), batch: true, stage: "screen" } as never, undefined, undefined, researchContext(app.ctx, []));
    assert.equal(statuses.length, 3);
    assert.match(statuses[0]!, /Checking names 1-3 of 6/);
    assert.match(statuses[1]!, /Checking names 4-6 of 6/);
    assert.equal(statuses[2], undefined);
    assert.match(result.content[0].text, /Check finished: 6 names; 6 assessed, 0 need review, 0 failed/);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    await assert.rejects(app.tools.get("brand_check")!.execute("cancel", { names: ["Able"], stage: "screen" } as never, controller.signal, undefined, researchContext(app.ctx, [])), /cancelled by caller/);
    assert.equal(statuses.at(-1), undefined);
  } finally { app.cleanup(); }
});

test("pending checks refresh stale saved findings and replace the old requirements fingerprint", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const searches: string[] = [];
    const ctx = researchContext(app.ctx, searches);
    const params = { names: ["Able"], batch: true, uncheckedOnly: true, stage: "deep" };
    await app.tools.get("brand_check")!.execute("before", params as never, undefined, undefined, ctx);
    const saved = loadBrandState(app.ctx.cwd, true);
    saved.state.product = "a new category";
    saveBrandState(saved.path, saved.state);
    await app.tools.get("brand_check")!.execute("after", params as never, undefined, undefined, ctx);
    assert.deepEqual(searches, ["Able", "Able"]);
    assert.match(app.state().availability.able.requirementsKey!, /a new category/);
  } finally { app.cleanup(); }
});

test("successful empty web searches complete positively without a worker request", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const ctx = { ...researchContext(app.ctx, []), executeTool: async () => ({ isError: false, result: { structuredContent: { queries: [{ results: [] }, { results: [] }, { results: [] }] }, content: [] } }) } as unknown as ExtensionToolContext;
    const result = await app.tools.get("brand_check")!.execute("check", { names: ["Able"], stage: "screen" } as never, undefined, undefined, ctx);
    assert.notEqual(result.isError, true);
    assert.equal(app.state().availability.able.score, "perfect");
    assert.equal(app.state().availability.able.searchQueries?.length, 3);
    assert.equal(app.modelCalls(), 1);
  } finally { app.cleanup(); }
});

test("failed searches report a tool error while saving successful peers and retry only failures", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const searches: string[] = [];
    const working = researchContext(app.ctx, searches);
    const ctx = { ...working, executeTool: async (name: string, args: { queries: string[] }) => {
      if (args.queries[0] === '\"Bold\"') return { isError: false, result: { structuredContent: { queries: [{ results: [] }, { error: "provider offline", results: [] }, { results: [] }] }, content: [] } };
      return working.executeTool(name, args);
    } } as unknown as ExtensionToolContext;
    const result = await app.tools.get("brand_check")!.execute("partial", { names: ["Able", "Bold", "Calm"], batch: true, stage: "screen" } as never, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(app.state().availability.able.score, "perfect");
    assert.equal(app.state().availability.bold.score, "error");
    assert.equal(app.state().availability.calm.score, "perfect");
    assert.match(result.content[0].text, /2 assessed, 0 need review, 1 failed/);
    searches.length = 0;
    const retried = await app.tools.get("brand_check")!.execute("retry", { names: ["Able", "Bold", "Calm"], batch: true, uncheckedOnly: true, stage: "screen" } as never, undefined, undefined, working);
    assert.deepEqual(searches, ["Bold"]);
    assert.notEqual(retried.isError, true);
  } finally { app.cleanup(); }
});

test("tool checks survive pi's non-enumerable tools and executeTool context", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const searches: string[] = [];
    const source = researchContext(app.ctx, searches);
    const ctx = { ...source } as Record<string, unknown>;
    delete ctx.tools;
    delete ctx.executeTool;
    Object.defineProperties(ctx, { tools: { get: () => source.tools }, executeTool: { value: source.executeTool } });
    Object.defineProperty(ctx, "signal", { get: () => new AbortController().signal, enumerable: true });
    const result = await app.tools.get("brand_check")!.execute("check", { names: ["Able"], stage: "screen" } as never, undefined, undefined, ctx as unknown as ExtensionToolContext);
    assert.notEqual(result.isError, true);
    assert.deepEqual(searches, ["Able"]);
    assert.equal(app.state().availability.able.score, "perfect");
  } finally { app.cleanup(); }
});

test("shortlist export includes favorite changes from the current screen and performs no research", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save and close"); await app.command("tasks");
    const before = app.modelCalls();
    terminalScripts(app.ctx, [["\x1b[B", "f", "\t", "e"], ["\x1b"]]);
    await app.command("");
    const exported = loadBrandState(app.ctx.cwd, true).path.replace(/\.json$/, "") + ".shortlist.md";
    const markdown = fs.readFileSync(exported, "utf8");
    assert.match(markdown, /## Able/);
    assert.match(markdown, /## Bold/);
    assert.equal(app.modelCalls(), before);
    await app.command("shortlist");
    assert.equal(app.modelCalls(), before);
  } finally { app.cleanup(); }
});

test("favorites checks return to Favorites rather than Names", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "[ ] Bold", "Save and close"); await app.command("tasks");
    terminalScripts(app.ctx, [["\t", "\x1b[B", "c"]]); await app.command("");
    await app.tools.get("brand_check")!.execute("check", { names: ["Able", "Bold"], batch: true } as never, undefined, undefined, researchContext(app.ctx, []));
    const frames = terminalScripts(app.ctx, [["f", "\x1b"]]);
    await app.emit("agent_end");
    assert.match(frames[0]!.join("\n"), /\[ Favorites\]/);
    assert.deepEqual(app.state().liked.map(entry => entry.name), ["Able"]);
  } finally { app.cleanup(); }
});

test("interrupted checks return without retrying; session changes and shutdown cancel restoration", async () => {
  for (const outcome of ["interrupted", "session-changed", "shutdown"] as const) {
    const app = harness();
    try {
      app.choices.push("Save and close"); await app.command("tasks");
      terminalScripts(app.ctx, [["c"]]); await app.command("");
      if (outcome === "interrupted") {
        const ctx = { ...researchContext(app.ctx, []), signal: AbortSignal.abort(new Error("Check cancelled")) };
        await assert.rejects(app.tools.get("brand_check")!.execute("check", { names: ["Able"] } as never, undefined, undefined, ctx), /Check cancelled/);
      }
      if (outcome === "session-changed") Object.assign(app.ctx.sessionManager, { getSessionId: () => "other-session" });
      if (outcome === "shutdown") await app.emit("session_shutdown");
      const scripts = outcome === "interrupted" ? [["\x1b"]] : [];
      terminalScripts(app.ctx, scripts);
      await app.emit("agent_end");
      assert.equal(scripts.length, 0);
      assert.equal(app.messages.length, 1);
      assert.equal(app.modelCalls(), 1);
      await app.emit("agent_end");
    } finally { app.cleanup(); }
  }
});

test("a standalone check command does not open a workspace on completion", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    terminalScripts(app.ctx, []);
    await app.command("check Able");
    await app.tools.get("brand_check")!.execute("check", { names: ["Able"], stage: "screen" } as never, undefined, undefined, researchContext(app.ctx, []));
    await app.emit("agent_end");
    assert.equal(app.messages.length, 1);
  } finally { app.cleanup(); }
});

test("tool-driven checks stay in the workspace loop without dispatching another request", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const scripts = [["/", "Extra", "\r", "c"], ["\x1b", "\x1b"]];
    const frames = terminalScripts(app.ctx, scripts);
    const searches: string[] = [];
    await app.tools.get("brand_pick")!.execute("pick", { candidates: [{ name: "Extra" }] } as never, undefined, undefined, researchContext(app.ctx, searches));
    assert.equal(scripts.length, 0);
    assert.deepEqual(app.messages, []);
    assert.deepEqual(searches, ["Extra"]);
    assert.match(frames.flat().join("\n"), /Extra\s+[]/);
    await app.emit("agent_end");
  } finally { app.cleanup(); }
});

test("terminal bulk discard removes selected and favorite names but preserves round history", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save and close");
    await app.command("tasks");
    Object.assign(app.ctx.ui, { confirm: async () => true });
    const scripts = [[" ", "\x1b[B", " ", "d"], ["\x1b"]];
    terminalScripts(app.ctx, scripts);
    await app.command("");
    assert.equal(scripts.length, 0);
    assert.equal(app.state().selected.length, 10);
    assert.deepEqual(app.state().liked, []);
    assert.deepEqual(app.state().dismissed, ["Able", "Bold"]);
    assert.equal(app.state().rounds[0].candidates.length, 12);
  } finally { app.cleanup(); }
});

function researchContext(ctx: ExtensionCommandContext, searches: string[]): ExtensionToolContext {
  return { ...ctx, tools: [{ name: "web_search" }], executeTool: async (_name: string, args: { queries: string[] }) => {
    const name = args.queries[0].match(/^\"([^\"]+)\"/)![1];
    searches.push(name);
    return { isError: false, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: `https://example.com/${name}`, snippet: "source-linked finding" }] }) }] } };
  } } as unknown as ExtensionToolContext;
}

test("selected names can be batch checked without favoriting; unchecked-only skips existing assessments", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const saved = loadBrandState(app.ctx.cwd, true);
    saved.state.availability.able = { score: "good", reason: "previous", stage: "deep", checkedAt: "2026-01-01" };
    saveBrandState(saved.path, saved.state);
    const searches: string[] = [];
    const ctx = researchContext(app.ctx, searches);
    const names = ["Able", "Bold", "Calm", "Daring", "Eager"];
    const params = { names, batch: true, uncheckedOnly: true, stage: "screen" };
    const tool = app.tools.get("brand_check")!;
    await tool.execute("batch", params as never, undefined, undefined, ctx);
    assert.deepEqual([...searches].sort(), names.slice(1).sort());
    assert.deepEqual(app.state().liked, []);
    assert.equal(app.state().selected.length, 12);
    const resolved = app.state();
    for (const name of names.slice(1)) {
      resolved.availability[name.toLowerCase()] = { score: "good", reason: "resolved later", stage: "deep", checkedAt: "2026-01-02" };
    }
    saveBrandState(saved.path, resolved);
    searches.length = 0;
    const calls = app.modelCalls();
    const done = await tool.execute("again", params as never, undefined, undefined, ctx);
    assert.match(done.content[0].text, /No pending checks/);
    assert.deepEqual(searches, []);
    assert.equal(app.modelCalls(), calls);
    await app.command("worker openai/cheap-worker");
    searches.length = 0;
    await tool.execute("refresh", { ...params, refresh: true } as never, undefined, undefined, ctx);
    assert.equal(searches.length, 5);
    assert.ok(app.requestedModels.slice(-2).every(model => model === "openai/cheap-worker"));
    for (const name of names) assert.equal(app.state().availability[name.toLowerCase()].model, "openai/cheap-worker");
  } finally { app.cleanup(); }
});

test("unchecked-only retries inconclusive names without touching conclusive ones", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const saved = loadBrandState(app.ctx.cwd, true);
    saved.state.availability.able = { score: "good", reason: "conclusive", stage: "deep", checkedAt: "2026-01-01" };
    saved.state.availability.bold = { score: "unknown", reason: "search unavailable", stage: "deep", checkedAt: "2026-01-01", researchVersion: CHECK_RESEARCH_VERSION };
    saveBrandState(saved.path, saved.state);
    const searches: string[] = [];
    const result = await app.tools.get("brand_check")!.execute("retry", { names: ["Able", "Bold"], batch: true, uncheckedOnly: true, stage: "deep" } as never, undefined, undefined, researchContext(app.ctx, searches));
    assert.deepEqual(searches, ["Bold"]);
    assert.match(result.content[0].text, /Bold/);
    assert.doesNotMatch(result.content[0].text, /Able/);
    assert.equal(app.state().availability.able.reason, "conclusive");
    assert.notEqual(app.state().availability.bold.reason, "search unavailable");
  } finally { app.cleanup(); }
});

test("failed forced reassessment retains the previous evidence and timestamp", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close"); await app.command("tasks");
    const saved = loadBrandState(app.ctx.cwd, true);
    saved.state.availability.able = { score: "good", reason: "previous", stage: "deep", checkedAt: "2026-01-01", model: "openai/old-worker" };
    saveBrandState(saved.path, saved.state);
    Object.assign(app.ctx.modelRegistry, { streamSimple: () => { throw new Error("Provider unavailable"); } });
    const result = await app.tools.get("brand_check")!.execute("refresh", { names: ["Able"], refresh: true, stage: "screen" } as never, undefined, undefined, researchContext(app.ctx, []));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Refresh failed:.*Previous assessment retained/);
    assert.equal(app.state().availability.able.score, "good");
    assert.equal(app.state().availability.able.checkedAt, "2026-01-01");
    assert.equal(app.state().availability.able.model, "openai/old-worker");
  } finally { app.cleanup(); }
});

test("terminal feedback returns to browsing instead of automatically generating", async () => {
  const app = harness();
  try {
    app.choices.push("Save and close");
    await app.command("a todo app");
    const rounds = app.state().rounds.length;
    app.inputs.push("Make it short and confident");
    const scripts = [["b", "f"], ["\x1b"]];
    terminalScripts(app.ctx, scripts);
    await app.command("");
    assert.equal(scripts.length, 0);
    assert.equal(app.state().rounds.length, rounds);
    assert.equal(app.requests.filter(request => request.role === "creative").length, 1);
    assert.equal(app.requests.filter(request => request.role === "brief").length, 1);
    assert.equal(app.state().brief.style, "short and confident");
  } finally { app.cleanup(); }
});

test("commands generate in isolation, refresh favorite-led inputs and never inject main context", async () => {
  const app = harness();
  try {
    app.choices.push("[ ] Able", "Save and close");
    await app.command("a todo app");
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().liked[0].name, "Able");
    assert.equal(app.state().reserve.length, 0);
    app.choices.push("[ ] Merry", "Save and close");
    await app.command("more");
    assert.equal(app.modelCalls(), 2);
    assert.equal(app.state().liked.length, 2);
    assert.equal(app.state().generationMetrics.length, 2);
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
    assert.match(result.content[0].text, /Check finished: 4 favorites; 4 assessed, 0 need review, 0 failed/);
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
        assert.equal(args.queries.length, 3);
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
    await app.tools.get("brand_score")!.execute("record", { name: "Able", famousCollision: false, sameSpaceCollision: false, giantAssociation: false, unrelatedCount: 0, comParked: false } as never, undefined, undefined, app.ctx as unknown as ExtensionToolContext);
    const checkedAt = app.state().availability.able.checkedAt;
    const toolCtx = { ...app.ctx, tools: [], executeTool: () => { throw new Error("must not search"); } } as unknown as ExtensionToolContext;
    const result = await app.tools.get("brand_check")!.execute("check", {} as never, undefined, undefined, toolCtx);
    assert.equal(result.terminate, undefined);
    assert.equal(app.modelCalls(), 1);
    assert.equal(app.state().availability.able.checkedAt, checkedAt);
    assert.match(result.content[0].text, /cached/);
  } finally { app.cleanup(); }
});

test("explicit screened mode checks only three names; a new favorite invalidates the reserve", async () => {
  const app = harness();
  try {
    await app.command("note familiar words");
    let searches = 0;
    const toolCtx = {
      ...app.ctx, tools: [{ name: "web_search" }],
      executeTool: async (_name: string, args: { queries: string[]; includeContent: boolean }) => {
        searches++;
        assert.equal(args.queries.length, 3);
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
    assert.equal(app.state().reserve.length, 0);
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
    assert.equal(app.state().reserve.length, 0);
    app.choices.push("More names", "Save and close");
    await app.command("");
    assert.equal(app.modelCalls(), 2);
    assert.equal(app.state().rounds[1].origin, "generated");
    assert.equal(app.state().rounds[0].candidates.length, 12);
    assert.ok(app.requests.at(-1)?.prompt.includes("positive taste references"));
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
    app.choices.push("Save and close");
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
