import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestStructured } from "../src/model.ts";

function context(response: unknown, available = true): ExtensionContext {
  return {
    modelRegistry: {
      find: () => available ? { provider: "openai", id: "gpt-6-luna" } : undefined,
      hasConfiguredAuth: () => available,
      streamSimple: () => ({ result: async () => response }),
    },
  } as unknown as ExtensionContext;
}

const schema = Type.Object({ names: Type.Array(Type.String()) });

test("unavailable naming model fails explicitly instead of using the main model", async () => {
  await assert.rejects(requestStructured(context({}, false), "openai/gpt-6-luna", "brief", schema, new AbortController().signal), /unavailable.*brand model/);
});

test("missing, malformed and truncated output cannot become candidates", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(requestStructured(context({ stopReason: "stop", content: [] }), "openai/gpt-6-luna", "brief", schema, signal), /structured result/);
  await assert.rejects(requestStructured(context({ stopReason: "toolUse", content: [{ type: "toolCall", id: "call", name: "submit_result", arguments: { names: 1 } }] }), "openai/gpt-6-luna", "brief", schema, signal), /invalid structured/i);
  await assert.rejects(requestStructured(context({ stopReason: "length", content: [] }), "openai/gpt-6-luna", "brief", schema, signal), /length/);
});
