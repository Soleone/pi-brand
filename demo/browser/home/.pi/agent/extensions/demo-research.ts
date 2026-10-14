// Stand-ins for what a check reaches outside the browser: the web_search tool pi-brand calls through pi,
// and the domain registry lookups (rdap.org) it fetches. Both answer from .demo/names.ts, so nothing leaves the page.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { NAME_LISTS, profileOf } from "../../../.demo/names.ts";

const names = NAME_LISTS.flat().map(([name]) => name);

export default function demoResearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web search (sample)",
    description: "Searches a fixed set of sample results for the demo's names.",
    parameters: Type.Object({
      queries: Type.Array(Type.String()),
      numResults: Type.Optional(Type.Number()),
      includeContent: Type.Optional(Type.Boolean()),
      workflow: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const query = params.queries.join(" ").toLowerCase();
      const name = names.find((candidate) => query.includes(`"${candidate.toLowerCase()}"`));
      const results = name ? profileOf(name).results : [];
      await new Promise((resolve) => setTimeout(resolve, 900));
      return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results } };
    },
  });

  // Registry lookups: every sample .com is taken, and .app is free unless another plant app holds the name.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "rdap.org") return realFetch(input, init);
    const domain = decodeURIComponent(url.pathname.replace("/domain/", ""));
    const [label, suffix] = domain.split(".");
    const taken = suffix === "com" || profileOf(label).kind === "collision";
    await new Promise((resolve) => setTimeout(resolve, 400));
    return new Response(taken ? JSON.stringify({ ldhName: domain }) : null, { status: taken ? 200 : 404 });
  };
}
