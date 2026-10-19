import { Type, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contentKey, formatBrief, namingContent } from "./brief.ts";
import { requestStructured } from "./model.ts";
import type { BrandState, NamingContent } from "./types.ts";

export const BRIEF_CHANGES = Type.Object({
  product: Type.Optional(Type.String({ maxLength: 6000 })),
  direction: Type.Optional(Type.String({ maxLength: 6000 })),
  avoid: Type.Optional(Type.String({ maxLength: 6000 })),
  style: Type.Optional(Type.String({ maxLength: 6000 })),
  examples: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 30 })),
  singleWord: Type.Optional(Type.Boolean()),
  maxLength: Type.Optional(Type.Integer({ minimum: 3, maximum: 30 })),
});

export async function prepareFeedback(
  ctx: ExtensionContext, state: BrandState, text: string, changes?: Partial<NamingContent>,
): Promise<{ changes: Partial<NamingContent>; beforeKey: string; usage?: Usage }> {
  if (!text.trim() || text.length > 6000) throw new Error("Feedback must be 1-6000 characters. Nothing was truncated.");
  const beforeKey = contentKey(namingContent(state));
  if (changes) return { changes, beforeKey };
  ctx.ui.setStatus?.("brand", "Updating the naming brief from your feedback…");
  try {
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const response = await requestStructured<Partial<NamingContent>>(
      ctx, state.model,
      `Current brief:\n${formatBrief(namingContent(state))}\nUser feedback (interpret in context, not as a replacement brief):\n${text}`,
      BRIEF_CHANGES, signal, "brief",
    );
    return { changes: response.value, usage: response.usage, beforeKey };
  } finally { ctx.ui.setStatus?.("brand", undefined); }
}
