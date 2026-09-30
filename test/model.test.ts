import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { brandCacheSessionId, requestStructured } from "../src/model.ts";

function context(response: unknown, available = true): ExtensionContext {
  return {
    cwd: "/tmp/pi-brand-model-tests", isProjectTrusted: () => true,
    modelRegistry: {
      find: () => available ? { provider: "openai", id: "gpt-6-luna" } : undefined,
      hasConfiguredAuth: () => available,
      streamSimple: () => ({ result: async () => response }),
    },
  } as unknown as ExtensionContext;
}

const schema = Type.Object({ names: Type.Array(Type.String()) });

test("unavailable naming model fails explicitly instead of using the main model", async () => {
  await assert.rejects(requestStructured(context({}, false), "openai/gpt-6-luna", "brief", schema, new AbortController().signal), /unavailable.*brand-settings/);
});

test("missing, malformed and truncated output cannot become candidates", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(requestStructured(context({ stopReason: "stop", content: [] }), "openai/gpt-6-luna", "brief", schema, signal), /structured result/);
  await assert.rejects(requestStructured(context({ stopReason: "toolUse", content: [{ type: "toolCall", id: "call", name: "submit_result", arguments: { names: 1 } }] }), "openai/gpt-6-luna", "brief", schema, signal), /invalid structured/i);
  await assert.rejects(requestStructured(context({ stopReason: "length", content: [] }), "openai/gpt-6-luna", "brief", schema, signal), /length/);
});

test("creative and worker have separate stable cache identities even on the same model", async () => {
  const seen: { model: string; system: string; prompt: string; options: { sessionId: string; cacheRetention: string; maxTokens: number } }[] = [];
  const ctx = {
    cwd: "/tmp/pi-brand-model-tests", isProjectTrusted: () => true,
    modelRegistry: {
      find: (_provider: string, id: string) => ({ provider: "openai", id, maxTokens: 4096, contextWindow: 8192 }),
      hasConfiguredAuth: () => true,
      streamSimple: (model: { id: string }, request: { systemPrompt: string; messages: { content: string }[] }, options: { sessionId: string; cacheRetention: string; maxTokens: number }) => {
        seen.push({ model: model.id, system: request.systemPrompt, prompt: request.messages[0].content, options });
        return { result: async () => ({ stopReason: "toolUse", content: [{ type: "toolCall", id: "result", name: "submit_result", arguments: { names: ["Able"] } }], usage: { input: 1 } }) };
      },
    },
    sessionManager: { getBranch: () => { throw new Error("must not read main history"); } },
  } as unknown as ExtensionContext;
  const signal = new AbortController().signal;
  await requestStructured(ctx, "openai/one-model", "a product brief", schema, signal);
  await requestStructured(ctx, "openai/one-model", "web evidence", schema, signal, "worker");
  await requestStructured(ctx, "openai/one-model", "a second brief", schema, signal);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].options.sessionId, seen[2].options.sessionId);
  assert.notEqual(seen[0].options.sessionId, seen[1].options.sessionId);
  assert.equal(seen[0].options.sessionId, brandCacheSessionId(ctx, "openai/one-model", "creative"));
  assert.equal(seen[0].options.cacheRetention, "short");
  assert.ok(seen[0].system.includes("product naming"));
  assert.ok(!seen[0].system.includes("supplied sources"));
  assert.ok(seen[1].system.includes("supplied sources"));
  assert.equal(seen[0].prompt, "a product brief");
  assert.equal(seen[1].prompt, "web evidence");
  assert.equal(seen[0].options.maxTokens, 3000);
  assert.equal(seen[1].options.maxTokens, 2000);
});

test("model requests reserve room for output and reject oversized input before dispatch", async () => {
  let dispatched = 0;
  const ctx = {
    cwd: "/tmp/pi-brand-model-tests", isProjectTrusted: () => true,
    modelRegistry: {
      find: () => ({ provider: "test", id: "small", contextWindow: 1600, maxTokens: 4000 }),
      hasConfiguredAuth: () => true,
      streamSimple: (_model: unknown, _context: unknown, options: { maxTokens: number }) => {
        dispatched++;
        assert.ok(options.maxTokens >= 800 && options.maxTokens < 1600);
        return { result: async () => ({ stopReason: "toolUse", content: [{ type: "toolCall", id: "one", name: "submit_result", arguments: { names: [] } }] }) };
      },
    },
  } as unknown as ExtensionContext;
  await requestStructured(ctx, "test/small", "brief", schema, new AbortController().signal);
  await assert.rejects(requestStructured(ctx, "test/small", "x".repeat(5001), schema, new AbortController().signal), /5000-character budget/);
  await assert.rejects(requestStructured(ctx, "test/small", "x".repeat(2200), schema, new AbortController().signal), /too large for/);
  assert.equal(dispatched, 1);
});

test("multiple tool calls cannot masquerade as one result", async () => {
  const response = { stopReason: "toolUse", content: [
    { type: "toolCall", id: "one", name: "submit_result", arguments: { names: [] } },
    { type: "toolCall", id: "two", name: "submit_result", arguments: { names: [] } },
  ] };
  await assert.rejects(requestStructured(context(response), "openai/gpt-6-luna", "brief", schema, new AbortController().signal), /exactly one/);
});
