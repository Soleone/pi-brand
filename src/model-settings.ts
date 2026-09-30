import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrandState } from "./types.ts";
import { selectBrandOption } from "./selection.ts";

export function validateBrandModel(ctx: ExtensionContext, reference: string): void {
  const slash = reference.indexOf("/");
  const model = slash > 0 ? ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1)) : undefined;
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Brand model ${reference} is unavailable or unauthenticated. Choose an available model in /brand-settings.`);
  }
}

/** Draft settings until Save; neither role changes the main session model. */
export async function selectBrandModels(ctx: ExtensionContext, state: BrandState): Promise<Pick<BrandState, "model" | "workerModel"> | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`Creative: ${state.model}\nWorker: ${state.workerModel ?? "same as creative"}\nUse /brand model <provider/id> or /brand worker <provider/id|same>. Settings apply to this project run.`, "info");
    return;
  }
  const scoped = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
  const models = [...new Set(scoped.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model)).map((model) => `${model.provider}/${model.id}`))].sort();
  const draft = { model: state.model, workerModel: state.workerModel };
  while (true) {
    const creative = `Creative (name generation): ${draft.model}`;
    const worker = `Worker (evidence assessment): ${draft.workerModel ?? "same as creative"}`;
    const choice = await selectBrandOption(ctx, "Brand settings · this project run · main model unchanged", [creative, worker, "Save settings", "Cancel"]);
    if (!choice || choice === "Cancel") return;
    if (choice === "Save settings") return draft;
    if (choice !== creative && choice !== worker) continue;
    const reference = await selectBrandOption(ctx, choice === creative ? "Choose creative model" : "Choose worker model", choice === creative ? models : ["Same as creative", ...models]);
    if (!reference) continue;
    if (reference !== "Same as creative") validateBrandModel(ctx, reference);
    if (choice === creative) draft.model = reference;
    else draft.workerModel = reference === "Same as creative" ? undefined : reference;
  }
}
