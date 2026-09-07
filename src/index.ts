import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { pickNames } from "./picker.ts";
import {
  buildAvailabilityPrompt,
  buildBrandContext,
  buildMorePrompt,
  buildPivotPrompt,
  buildRoundPrompt,
} from "./prompt.ts";
import { scoreFromSignals, type CollisionSignals } from "./scoring.ts";
import {
  addLikes,
  getAvailability,
  loadBrandState,
  recordAvailability,
  recordRound,
  saveBrandState,
} from "./store.ts";
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

const BRAND_SCORE_PARAMS = Type.Object({
  name: Type.String({ description: "Name to look up or record availability for" }),
  famousCollision: Type.Optional(
    Type.Boolean({ description: "Famous product or brand in any space" }),
  ),
  sameSpaceCollision: Type.Optional(
    Type.Boolean({ description: "Active business in the same or adjacent space on .com" }),
  ),
  giantAssociation: Type.Optional(
    Type.Boolean({ description: "Strong association with an unrelated giant" }),
  ),
  unrelatedCount: Type.Optional(Type.Number({ description: "Count of unrelated collisions" })),
  comParked: Type.Optional(
    Type.Boolean({ description: ".com parked or for sale with no product" }),
  ),
  force: Type.Optional(Type.Boolean({ description: "Overwrite an existing cached result" })),
});

interface BrandScoreParams {
  name: string;
  famousCollision?: boolean;
  sameSpaceCollision?: boolean;
  giantAssociation?: boolean;
  unrelatedCount?: number;
  comParked?: boolean;
  force?: boolean;
}

export default function registerPiBrand(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "brand_pick",
    label: "Brand pick",
    description:
      "Let the user multi-select favorite names from a shortlist. Call this after generating name candidates instead of asking the user to type numbers. Picks accumulate across rounds, and the picker's action row queues the next step directly: 1 more names, 2 new direction, 3 availability check.",
    promptSnippet: "After generating name candidates, call brand_pick so the user can select favorites in a picker UI.",
    promptGuidelines: [
      "Call brand_pick with 12-15 shortlisted candidates once per naming round.",
      "After brand_pick returns with kind picked or rejected, summarize and WAIT for the user to confirm before any next round. Never call brand_pick twice in a row without user confirmation.",
      "After brand_pick returns an action (more-same, more-new, check), the matching prompt is already queued as a follow-up turn: carry it out without asking again.",
      "Offer the two exits explicitly rather than asking an open question: in the picker the user can press 1 (more names, same direction), 2 (new direction) or 3 (availability); from chat the same steps are /brand more, /brand pivot <note> and /brand check.",
      "If brand_pick reports a whole-round rejection, confirm it, steer by the attached note, and never suggest dismissed names again.",
      "When deep-checking picks, call brand_score with just the name first: a cached result was already researched in this project, trust it and never search twice. Research only uncached names, then record each via brand_score with the collision signals.",
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

      // Attach cached availability so re-seen names show their score with no re-check.
      for (const candidate of candidates) {
        const hit = getAvailability(loaded.state, candidate.name);
        if (hit) {
          candidate.score = hit.score;
          candidate.scoreReason = hit.reason;
        }
      }

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

      const outcome = await pickNames(ctx, candidates, {
        title: `Brand  ·  round ${roundNumber}  ·  pick favorites`,
        product: product || undefined,
        likedSoFar: keptBefore,
        checkedNames: Object.keys(loaded.state.availability),
      });

      if (!outcome) {
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

      if (outcome.kind === "rejected") {
        const names = outcome.names.map((name) => name.trim()).filter(Boolean);
        const known = new Set(loaded.state.dismissed.map((name) => name.toLocaleLowerCase()));
        let fresh = 0;
        for (const name of names) {
          if (known.has(name.toLocaleLowerCase())) continue;
          known.add(name.toLocaleLowerCase());
          loaded.state.dismissed.push(name);
          fresh += 1;
        }
        const comment = outcome.comment.trim();
        if (comment) loaded.state.directionNotes.push(comment);
        saveBrandState(loaded.path, loaded.state);

        ctx.ui.notify(
          `Round ${roundNumber}: rejected all ${names.length} (${fresh} new)${comment ? ` with note: ${comment}` : ""}. They won't be suggested again.`,
          "info",
        );
        ctx.ui.notify("Next: /brand more applies the note as-is · /brand pivot <note> to refine it.", "info");

        return {
          content: [
            {
              type: "text",
              text: [
                `brand_pick round ${roundNumber}: user rejected ALL ${names.length} candidates${comment ? ` with note: ${comment}` : " (no note given)"}.`,
                `Dismissed (never suggest again): ${loaded.state.dismissed.slice(-30).join(", ")}.`,
                "Tell the user the round was rejected and confirm the note, then stop and wait.",
                "Do NOT call brand_pick again until the user explicitly confirms. Do not repeat seen names.",
                `The note is already saved, so /brand more applies it directly; /brand pivot <note> refines it further. Mention both, plus /brand check for availability of anything kept.`,
              ].join("\n"),
            },
          ],
          details: { roundId: round.id, picked: [] as string[], rejected: names, rejectComment: comment },
        };
      }

      const picks = outcome.names;
      const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
      const added = addLikes(
        loaded.state,
        round,
        picks.map((name) => byName.get(name) ?? { name }),
      );

      // A digit-key exit is itself the confirmation for that next step.
      if (outcome.kind === "action" && outcome.note) {
        loaded.state.directionNotes.push(outcome.note);
      }
      saveBrandState(loaded.path, loaded.state);

      if (outcome.kind === "action") {
        const labels = {
          "more-same": "more names, same direction",
          "more-new": `more names, new direction: ${outcome.note}`,
          check: "availability deep-check of the shortlist",
        } as const;
        const nextPrompt =
          outcome.action === "check"
            ? buildAvailabilityPrompt(loaded.state)
            : outcome.action === "more-new"
              ? buildPivotPrompt(loaded.state, outcome.note ?? "")
              : buildMorePrompt(loaded.state);

        ctx.ui.notify(
          `${added.length > 0 ? `Kept ${added.join(", ")}. ` : ""}${labels[outcome.action]} — queued.`,
          "info",
        );
        pi.sendUserMessage(nextPrompt, { deliverAs: "followUp" });

        return {
          content: [
            {
              type: "text",
              text: [
                `brand_pick round ${roundNumber}: user kept ${added.length > 0 ? added.join(", ") : "(nothing new)"} and chose: ${labels[outcome.action]}.`,
                `Kept across all rounds (accumulates, never resets): ${loaded.state.liked.map((entry) => entry.name).join(", ") || "(none)"}.`,
                outcome.action === "check"
                  ? "The availability prompt is already queued as the next turn. Do not ask for permission again; run it, consulting brand_score cache first."
                  : "The next-round prompt is already queued. Do not ask for permission again; generate and call brand_pick.",
              ].join("\n"),
            },
          ],
          details: { roundId: round.id, picked: added, action: outcome.action },
        };
      }

      const allLiked = loaded.state.liked.map((entry) => entry.name);
      ctx.ui.notify(
        added.length > 0
          ? `Round ${roundNumber}: kept ${added.join(", ")}. Total kept (${allLiked.length}): ${allLiked.join(", ")}.`
          : `Round ${roundNumber}: nothing new kept. Total kept (${allLiked.length}): ${allLiked.join(", ") || "(none)"}.`,
        "info",
      );
      ctx.ui.notify("Next round: press 1 for more names, 2 for a new direction, 3 for availability.", "info");
      return {
        content: [
          {
            type: "text",
            text: [
              `brand_pick round ${roundNumber}: user picked ${added.length > 0 ? added.join(", ") : "(nothing new this round)"}.`,
              `Kept across all rounds (accumulates, never resets): ${allLiked.join(", ") || "(none)"}.`,
              "STOP after this message: report what was kept this round and the full kept list, then wait. Do not generate another round or run availability checks on your own.",
              "The user can also press 1 (more names, same direction), 2 (new direction), or 3 (availability) inside the next picker, which queues that step directly. /brand more, /brand pivot <note> and /brand check do the same from here.",
              "Do NOT call brand_pick again until the user explicitly confirms another round. One picker at a time. Do not repeat seen names.",
            ].join("\n"),
          },
        ],
        details: { roundId: round.id, picked: added },
      };
    },
  });

  pi.registerTool({
    name: "brand_score",
    label: "Brand score",
    description:
      "Look up or record a name availability deep-check. Call with just a name first: a cached result means it was already researched, trust it and do not search again. Call with collision signals after fresh research to save the result forever.",
    promptSnippet:
      "Before availability deep-checking any name, call brand_score with just its name to consult the cache.",
    promptGuidelines: [
      "Always call brand_score with just the name before researching availability. Cached results are final, never re-search them.",
      "After fresh research, call brand_score again with the collision signals so the result is saved and never researched twice.",
    ],
    parameters: BRAND_SCORE_PARAMS,
    async execute(_toolCallId, params: BrandScoreParams, _signal, _onUpdate, ctx) {
      const loaded = loadBrandState(ctx.cwd, ctx.isProjectTrusted());
      for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");

      const name = params.name?.trim() ?? "";
      if (!name) {
        return {
          content: [{ type: "text", text: "brand_score: pass a name to look up or record." }],
          details: { name: "", cached: false },
        };
      }

      const hasSignals =
        params.famousCollision !== undefined ||
        params.sameSpaceCollision !== undefined ||
        params.giantAssociation !== undefined ||
        params.unrelatedCount !== undefined ||
        params.comParked !== undefined;
      const cached = getAvailability(loaded.state, name);

      // Lookup: name only, no signals.
      if (!hasSignals) {
        if (cached) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `brand_score: ${name} is already checked in this project: ${cached.score} (${cached.reason}; checked ${cached.checkedAt}).`,
                  "Trust this result. Do NOT research this name again.",
                ].join("\n"),
              },
            ],
            details: { name, cached: true, score: cached.score, reason: cached.reason },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: [
                `brand_score: ${name} is not checked yet in this project.`,
                "Research it now (npm, GitHub, DNS, web), then call brand_score again with the collision signals to save the result.",
              ].join("\n"),
            },
          ],
          details: { name, cached: false },
        };
      }

      // Record: signals provided.
      if (cached && !params.force) {
        return {
          content: [
            {
              type: "text",
              text: [
                `brand_score: ${name} is already recorded as ${cached.score} (${cached.reason}; checked ${cached.checkedAt}).`,
                "Your fresh signals were NOT saved. Trust the cached result, or repeat with force true to overwrite it.",
              ].join("\n"),
            },
          ],
          details: { name, cached: true, score: cached.score, reason: cached.reason },
        };
      }

      const rawCount = params.unrelatedCount ?? 0;
      const signals: CollisionSignals = {
        famousCollision: params.famousCollision ?? false,
        sameSpaceCollision: params.sameSpaceCollision ?? false,
        giantAssociation: params.giantAssociation ?? false,
        unrelatedCount:
          typeof rawCount === "number" && Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0,
        comParked: params.comParked ?? false,
      };
      const { score, reason } = scoreFromSignals(signals);
      const saved = recordAvailability(loaded.state, name, { score, reason, signals });
      saveBrandState(loaded.path, loaded.state);
      ctx.ui.notify(`Availability recorded: ${name} is ${score} (${reason}).`, "info");

      return {
        content: [
          {
            type: "text",
            text: [
              `brand_score: recorded ${name} as ${score} (${reason}).`,
              "This result is saved in this project forever. Neither you nor any future session needs to research this name again.",
            ].join("\n"),
          },
        ],
        details: { name, cached: false, score: saved.score, reason: saved.reason },
      };
    },
  });

  pi.registerCommand("brand", {
    description:
      "Name an app. /brand <desc> start a round · more / pivot <note> for the next shortlist · check for availability of what you kept",
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
    showLikes(ctx, loaded.state.liked);
    return;
  }

  // The two exits from a shortlist, one command each.
  if (sub === "more" || sub === "again" || sub === "next") {
    if (!loaded.state.product) {
      ctx.ui.notify("No product on record. Start with /brand <what the app does>.", "warning");
      return;
    }
    saveBrandState(loaded.path, loaded.state);
    pi.sendUserMessage(buildMorePrompt(loaded.state));
    return;
  }

  if (sub === "pivot" || sub === "new") {
    if (!tail) {
      ctx.ui.notify("Usage: /brand pivot <what to change, e.g. less cute, more verb-able>", "warning");
      return;
    }
    if (!loaded.state.product) {
      ctx.ui.notify("No product on record. Start with /brand <what the app does>.", "warning");
      return;
    }
    loaded.state.directionNotes.push(tail);
    saveBrandState(loaded.path, loaded.state);
    pi.sendUserMessage(buildPivotPrompt(loaded.state, tail));
    return;
  }

  if (sub === "check") {
    // No argument: deep-check the whole kept shortlist, cache first.
    if (!tail) {
      if (loaded.state.liked.length === 0) {
        ctx.ui.notify("Nothing kept to check. Pick favorites first, then /brand check.", "warning");
        return;
      }
      saveBrandState(loaded.path, loaded.state);
      pi.sendUserMessage(buildAvailabilityPrompt(loaded.state));
      return;
    }
    const hit = getAvailability(loaded.state, tail);
    if (hit) {
      ctx.ui.notify(`${tail}: ${hit.score} — ${hit.reason} (checked ${hit.checkedAt}).`, "info");
    } else {
      ctx.ui.notify(`${tail}: not availability-checked yet in this project.`, "info");
    }
    return;
  }

  if (sub === "help") {
    ctx.ui.notify(BRAND_HELP, "info");
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
      availability: {},
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

const BRAND_HELP = [
  "/brand <description>  start a naming round",
  "/brand more  another shortlist, same direction",
  "/brand pivot <note>  change direction and get a shortlist",
  "/brand check  availability deep-check of everything kept",
  "/brand check <name>  cached availability for one name",
  "/brand likes  kept names  ·  /brand note <text>  /brand dismiss <name>  /brand clear",
].join("\n");

function showLikes(
  ctx: ExtensionCommandContext,
  liked: Array<{ name: string; score?: string }>,
): void {
  if (liked.length === 0) {
    ctx.ui.notify("No liked names yet. Run /brand to start a round.", "info");
    return;
  }
  const rendered = liked.map((entry) => (entry.score ? `${entry.name} (${entry.score})` : entry.name));
  ctx.ui.notify(`Liked (${liked.length}): ${rendered.join(", ")}`, "info");
}
