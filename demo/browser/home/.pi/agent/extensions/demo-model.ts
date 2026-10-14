// A scripted model, so the demo runs real pi without an API key and nothing leaves the browser.
// pi-brand makes three kinds of request, told apart by their system prompt: naming (a ranked list of names),
// assessment (judging the search excerpts for up to three finalists), and the main agent, which pi-brand
// asks to run brand_check. Each gets a fixed reply; the tools and pi-brand itself are real.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { NAME_LISTS, profileOf } from "../../../.demo/names.ts";

const model = {
  id: "scripted",
  name: "Scripted",
  reasoning: true,
  input: ["text" as const],
  // Priced like a mid-size hosted model, so /brand stats shows what a run would cost.
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

type Step = ReturnType<typeof fauxAssistantMessage>;
type Message = { role: string; content: unknown };
const toolUse = { stopReason: "toolUse" as const };

function text(content: unknown): string {
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join(" ") : "";
}

// Naming: the first list whose names the prompt's exclusion sample doesn't mention, so "More" gets fresh names.
function namingReply(prompt: string): Step {
  const excluded = prompt.split("\n").find((line) => line.startsWith("Do not use excluded names"))?.toLowerCase() ?? "";
  const list = NAME_LISTS.find((names) => !names.some(([name]) => excluded.includes(name.toLowerCase()))) ?? [];
  const candidates = list.map(([name, flavor]) => ({ name, flavor }));
  return fauxAssistantMessage([fauxToolCall("submit_result", { candidates })], toolUse);
}

// Assessment: the prompt ends with the excerpts as JSON; each verdict cites the excerpts it was given.
function assessmentReply(prompt: string): Step {
  const items: { name: string; evidence: { url: string }[] }[] = JSON.parse(prompt.split("\n").at(-1) ?? "[]");
  const results = items.map(({ name, evidence }) => {
    const profile = profileOf(name);
    return {
      name,
      reason: profile.reason,
      famousCollision: false,
      sameSpaceCollision: profile.kind === "collision",
      giantAssociation: false,
      unrelatedCount: profile.kind === "collision" ? 0 : profile.unrelated,
      comParked: false,
      sourceUrls: evidence.map((entry) => entry.url).slice(0, 6),
    };
  });
  return fauxAssistantMessage([fauxToolCall("submit_result", { results })], toolUse);
}

// The main agent: pi-brand's own prompt asks it to call brand_check once, then sum up.
function agentReply(messages: Message[]): Step {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const prompt = text(messages[lastUser]?.content);
  const after = messages.slice(lastUser + 1);
  if (/Call brand_check once/.test(prompt)) {
    if (!after.some((message) => message.role === "assistant")) {
      const names = prompt.match(/names (\[.*?\])/)?.[1];
      return fauxAssistantMessage([fauxToolCall("brand_check", {
        stage: /stage screen/.test(prompt) ? "screen" : "deep",
        refresh: /refresh true/.test(prompt),
        ...(names ? { names: JSON.parse(names) } : {}),
        ...(/allFavorites true/.test(prompt) ? { allFavorites: true } : {}),
      })], toolUse);
    }
    // The tool result lists "Name: score (reason)" per line; point at the best one.
    const result = text(after.findLast((message) => message.role === "toolResult")?.content);
    const order = ["perfect", "good", "decent", "bad", "terrible", "unknown"];
    const scored = [...result.matchAll(/^(.+?): (\w+) \(/gm)].map(([, name, score]) => ({ name, score })).sort((a, b) => order.indexOf(a.score) - order.indexOf(b.score));
    const best = scored[0];
    const lead = !best ? "The check is done." : best.score === "terrible" ? "Each of these collides with something; try another round of names." : `**${best.name}** comes out best (${best.score}).`;
    return fauxAssistantMessage([fauxText(`${lead} The sources are in **/brand evidence <name>**. It's a first screen, not trademark clearance.`)]);
  }
  return fauxAssistantMessage([fauxText("I'm a scripted stand-in for a model, so I only know pi-brand's own requests. Start with the first button above, **/brand a reminder app that tells you when to water each plant**.")]);
}

function reply(context: { messages: Message[] }): Step {
  const prompt = text(context.messages.at(-1)?.content);
  // The system prompt arrives as the transcript's leading system message.
  const system = text(context.messages.find((message) => message.role === "system")?.content);
  if (system.startsWith("You are a product naming specialist")) return namingReply(prompt);
  if (system.startsWith("You assess preliminary brand collisions")) return assessmentReply(prompt);
  return agentReply(context.messages);
}

export default function demoModel(pi: ExtensionAPI): void {
  pi.registerProvider("demo", {
    name: "Demo",
    baseUrl: "http://demo.invalid",
    apiKey: "demo",
    api: "demo-scripted" as never,
    models: [model],
    streamSimple: (requestModel, context, options) => {
      // A core per request, since pi-brand's own requests can overlap the agent's.
      const core = createFauxCore({ provider: "demo", api: "demo-scripted", models: [model], tokensPerSecond: 400 });
      core.setResponses([reply(context as never)]);
      const source = core.streamSimple(requestModel as never, context, options);
      // The faux provider counts tokens but leaves cost at zero; price them like a real reply.
      const priced = createAssistantMessageEventStream();
      void (async () => {
        for await (const event of source) {
          if (event.type === "done") event.message.usage.cost = calculateCost(requestModel, event.message.usage);
          priced.push(event);
        }
        priced.end();
      })();
      return priced;
    },
  });
}
