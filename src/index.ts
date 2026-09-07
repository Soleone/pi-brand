import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { pickNames } from "./picker.ts";
import { buildBrandContext, buildRoundPrompt } from "./prompt.ts";
import { addLikes, loadBrandState, recordRound, saveBrandState } from "./store.ts";
import type { Candidate } from "./types.ts";

const CANDIDATE_SCHEMA = Type.Object({
  name: Type.String({ description: "Candidate name" }),
  flavor: Type.Optional(Type.String({ description: "One-line flavor note" })),
  style: Type.Optional(Type.String({ description: "Style bucket, e.g. playful, plain, invented" })),
});

const BRAND_PICK_PARAMS = Type.Object({
  candidates: Type.Array(CANDIDATE_SCHEMA, {
    description: "12-15 shortlisted names with one-line flavor notes",
  }),
  product: Type.Optional(Type.String({ description: "What the product does" })),
  directionHint: Type.Optional(Type.String({ description: "Direction note for this round" })),
});

export default function registerPiBrand(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "brand_pick",
    label: "Brand pick",
    description:
      "Let the user multi-select favorite names from a shortlist. Call this after generating name candidates instead of asking the user to type numbers. Picks accumulate across rounds; the picker shows what is already kept.",
    promptSnippet: "After generating name candidates, call brand_pick so the user can select favorites in a picker UI.",
    promptGuidelines: [
      "Call brand_pick with 12-15 shortlisted candidates once per naming round.",
      "After brand_pick returns, summarize the picks and WAIT for the user to confirm before any next round. Never call brand_pick twice in a row without user confirmation.",
      "Do not run npm, GitHub, DNS, or trademark checks before the user picks. Deep checks happen only on picks, in a later step.",
    ],
    parameters: BRAND_PICK_PARAMS,
    async execute(
      _toolCallId,
      params: {
        candidates: Array<{ name: string; flavor?: string; style?: string }>;
        product?: string;
        directionHint?: string;
      },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const loaded = loadBrandState(ctx.cwd, ctx.isProjectTrusted());
      for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");

      const candidates: Candidate[] = params.candidates
        .map((item) => ({
          name: item.name.trim(),
          flavor: item.flavor?.trim() || undefined,
          style: item.style?.trim() || undefined,
        }))
        .filter((item) => item.name.length > 0)
        .slice(0, 30);

      const product = params.product?.trim() || loaded.state.product;

      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: "brand_pick: no candidates provided." }],
          details: { roundId: undefined, picked: [] as string[] },
        };
      }

      const roundNumber = loaded.state.rounds.length + 1;
      const keptBefore = loaded.state.liked.map((entry) => entry.name);
      const round = recordRound(loaded.state, {
        product,
        candidates,
        directionHint: params.directionHint,
      });

      if (!ctx.hasUI) {
        saveBrandState(loaded.path, loaded.state);
        return {
          content: [
            {
              type: "text",
              text: [
                "brand_pick: no interactive UI in this mode, so nothing was picked yet.",
                "Present the candidates as a numbered list and ask the user to reply with their 3-4 favorites plus direction notes.",
                `Round saved (${candidates.length} candidates, id ${round.id}).`,
              ].join("\n"),
            },
          ],
          details: { roundId: round.id, picked: [] as string[] },
        };
      }

      const picks = await pickNames(ctx, candidates, {
        title: `Brand  ·  round ${roundNumber}  ·  pick favorites`,
        product: product || undefined,
        likedSoFar: keptBefore,
      });

      if (!picks) {
        saveBrandState(loaded.path, loaded.state);
        return {
          content: [
            {
              type: "text",
              text: `brand_pick: user cancelled the picker. Round saved (${round.id}), no likes recorded. Ask how to adjust direction and generate a fresh round.`,
            },
          ],
          details: { roundId: round.id, picked: [] as string[] },
        };
      }

      const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
      const added = addLikes(
        loaded.state,
        round,
        picks.map((name) => byName.get(name) ?? { name }),
      );
      saveBrandState(loaded.path, loaded.state);

      const allLiked = loaded.state.liked.map((entry) => entry.name);
      ctx.ui.notify(
        added.length > 0
          ? `Round ${roundNumber}: kept ${added.join(", ")}. Total kept (${allLiked.length}): ${allLiked.join(", ")}.`
          : `Round ${roundNumber}: nothing new kept. Total kept (${allLiked.length}): ${allLiked.join(", ") || "(none)"}.`,
        "info",
      );

      return {
        content: [
          {
            type: "text",
            text: [
              `brand_pick round ${roundNumber}: user picked ${added.length > 0 ? added.join(", ") : "(nothing new this round)"}.`,
              `Kept across all rounds (accumulates, never resets): ${allLiked.join(", ") || "(none)"}.`,
              "STOP after this message: tell the user what was kept this round and the full kept list, then ask which direction to push next (e.g. more like X, less Y) and whether to run another round.",
              "Do NOT call brand_pick again until the user explicitly confirms another round. One picker at a time. Do not repeat seen names.",
            ].join("\n"),
          },
        ],
        details: { roundId: round.id, picked: added },
      };
    },
  });

  pi.registerCommand("brand", {
    description: "Name an app: fast shortlist first, pick favorites in a UI, deep check only on picks",
    handler: async (args, ctx) => {
      await runBrandCommand(pi, args, ctx);
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    const loaded = loadBrandState(ctx.cwd, ctx.isProjectTrusted());
    const reminder = buildBrandContext(loaded.state);
    if (!reminder) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${reminder}` };
  });
}

async function runBrandCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const loaded = loadBrandState(ctx.cwd, ctx.isProjectTrusted());
  for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");

  const [head, ...rest] = args.trim().split(/\s+/);
  const tail = rest.join(" ").trim();
  const sub = (head ?? "").toLocaleLowerCase();

  if (sub === "likes" || sub === "liked" || sub === "status") {
    showLikes(ctx, loaded.state.liked.map((entry) => entry.name));
    return;
  }

  if (sub === "clear") {
    if (loaded.state.liked.length === 0 && loaded.state.rounds.length === 0) {
      ctx.ui.notify("Nothing to clear.", "info");
      return;
    }
    const yes = ctx.hasUI
      ? await ctx.ui.confirm("Clear brand state?", `${loaded.state.liked.length} likes, ${loaded.state.rounds.length} rounds`)
      : false;
    if (!yes) return;
    saveBrandState(loaded.path, {
      ...loaded.state,
      rounds: [],
      liked: [],
      dismissed: [],
      directionNotes: [],
    });
    ctx.ui.notify("Brand state cleared.", "info");
    return;
  }

  if (sub === "note") {
    if (!tail) {
      ctx.ui.notify("Usage: /brand note <direction, e.g. more like X, less cute>", "warning");
      return;
    }
    loaded.state.directionNotes.push(tail);
    saveBrandState(loaded.path, loaded.state);
    ctx.ui.notify(`Noted: ${tail}`, "info");
    return;
  }

  if (sub === "dismiss" || sub === "drop") {
    if (!tail) {
      ctx.ui.notify("Usage: /brand dismiss <name>", "warning");
      return;
    }
    loaded.state.dismissed.push(tail);
    saveBrandState(loaded.path, loaded.state);
    ctx.ui.notify(`Dismissed: ${tail}`, "info");
    return;
  }

  // Default: start a new naming round.
  let product = args.trim();
  if (!product) {
    product = loaded.state.product;
  }
  if (!product) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Usage: /brand <what the app does>", "warning");
      return;
    }
    const entered = await ctx.ui.input("What does the app do?", "e.g. a fast CLI journal for devs");
    if (!entered?.trim()) return;
    product = entered.trim();
  }

  saveBrandState(loaded.path, { ...loaded.state, product });
  pi.sendUserMessage(buildRoundPrompt(product, loaded.state));
}

function showLikes(ctx: ExtensionCommandContext, liked: string[]): void {
  if (liked.length === 0) {
    ctx.ui.notify("No liked names yet. Run /brand to start a round.", "info");
    return;
  }
  ctx.ui.notify(`Liked (${liked.length}): ${liked.join(", ")}`, "info");
}
