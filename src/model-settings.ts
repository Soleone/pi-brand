import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrandReasoning, BrandState } from "./types.ts";
import { BRAND_REASONING_LEVELS } from "./types.ts";
import { piReasoningDefault } from "./model.ts";
import { selectBrandOption } from "./selection.ts";

export function validateBrandModel(ctx: ExtensionContext, reference: string): void {
  const slash = reference.indexOf("/");
  const model = slash > 0 ? ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1)) : undefined;
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Brand model ${reference} is unavailable or unauthenticated. Choose an available model in /brand-settings.`);
  }
}

/** Draft settings until Save; neither role changes the main session model. */
export async function selectBrandModels(ctx: ExtensionContext, state: BrandState): Promise<Pick<BrandState, "model" | "workerModel" | "reasoning" | "workerReasoning"> | undefined> {
  const defaultReasoning = (reference: string) => {
    const slash = reference.indexOf("/");
    const model = slash > 0 ? ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1)) : undefined;
    return model?.reasoning ? piReasoningDefault(model) ?? "medium" : "off (model does not reason)";
  };
  const label = (override: BrandReasoning | undefined, reference: string) =>
    override ?? `default (pi: ${defaultReasoning(reference)})`;
  if (!ctx.hasUI) {
    ctx.ui.notify(`Creative: ${state.model}\nWorker: ${state.workerModel ?? "same as creative"}\nCreative reasoning: ${label(state.reasoning, state.model)}\nWorker reasoning: ${label(state.workerReasoning, state.workerModel ?? state.model)}\nUse /brand model <provider/id>, /brand worker <provider/id|same>, /brand reasoning <default|off|level> or /brand worker-reasoning <default|off|level>. Settings apply to this project run.`, "info");
    return;
  }
  const scoped = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
  const models = [...new Set(scoped.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model)).map((model) => `${model.provider}/${model.id}`))].sort();
  const draft: Pick<BrandState, "model" | "workerModel" | "reasoning" | "workerReasoning"> = {
    model: state.model, workerModel: state.workerModel, reasoning: state.reasoning, workerReasoning: state.workerReasoning,
  };
  while (true) {
    const creative = `Creative (name generation): ${draft.model}`;
    const worker = `Worker (evidence assessment): ${draft.workerModel ?? "same as creative"}`;
    const creativeReasoning = `Reasoning (creative): ${label(draft.reasoning, draft.model)}`;
    const workerReasoning = `Reasoning (worker): ${label(draft.workerReasoning, draft.workerModel ?? draft.model)}`;
    const choice = await selectBrandOption(ctx, "Brand settings · this project run · main model unchanged", [creative, worker, creativeReasoning, workerReasoning, "Save settings", "Cancel"]);
    if (!choice || choice === "Cancel") return;
    if (choice === "Save settings") return draft;
    if (choice === creativeReasoning || choice === workerReasoning) {
      const reference = choice === creativeReasoning ? draft.model : draft.workerModel ?? draft.model;
      const value = await selectBrandOption(ctx, `Reasoning level for the ${choice === creativeReasoning ? "creative" : "worker"} model`, [
        `Default (pi: ${defaultReasoning(reference)})`, "off", ...BRAND_REASONING_LEVELS,
      ]);
      if (!value) continue;
      const level = value.startsWith("Default") ? undefined : value as BrandReasoning;
      if (choice === creativeReasoning) draft.reasoning = level;
      else draft.workerReasoning = level;
      continue;
    }
    if (choice !== creative && choice !== worker) continue;
    const reference = await selectBrandOption(ctx, choice === creative ? "Choose creative model" : "Choose worker model", choice === creative ? models : ["Same as creative", ...models]);
    if (!reference) continue;
    if (reference !== "Same as creative") validateBrandModel(ctx, reference);
    if (choice === creative) draft.model = reference;
    else draft.workerModel = reference === "Same as creative" ? undefined : reference;
  }
}
