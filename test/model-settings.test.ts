import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectBrandModels, validateBrandModel } from "../src/model-settings.ts";
import { emptyBrandState } from "../src/types.ts";

const available = [{ provider: "test", id: "creative" }, { provider: "test", id: "worker" }, { provider: "test", id: "no-auth" }];

test("settings honor scoped models and exclude unauthenticated entries without making requests", async () => {
  const responses = ["Worker (evidence assessment): same as creative", "test/worker", "Save settings"];
  const ctx = {
    hasUI: true, scopedModels: [{ model: available[1] }, { model: available[2] }],
    modelRegistry: {
      find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => { throw new Error("scoped list should win"); },
      hasConfiguredAuth: (model: { id: string }) => model.id !== "no-auth",
      streamSimple: () => { throw new Error("settings must not call a model"); },
    },
    ui: { select: async (title: string, choices: string[]) => {
      if (title === "Choose worker model") assert.deepEqual(choices, ["Same as creative", "test/worker"]);
      return responses.shift();
    } },
  } as unknown as ExtensionContext;
  const state = emptyBrandState();
  const result = await selectBrandModels(ctx, state);
  assert.equal(result?.workerModel, "test/worker");
  assert.equal(state.workerModel, undefined);
  assert.throws(() => validateBrandModel(ctx, "test/no-auth"), /unauthenticated/);
  assert.throws(() => validateBrandModel(ctx, "missing"), /unavailable/);
});

test("non-UI settings report command alternatives without opening a dialog", async () => {
  const notices: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (text: string) => notices.push(text), select: () => { throw new Error("no UI"); } } } as unknown as ExtensionContext;
  assert.equal(await selectBrandModels(ctx, emptyBrandState()), undefined);
  assert.match(notices[0], /brand worker.*same/);
});
