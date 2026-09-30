import { Type, type Usage } from "@earendil-works/pi-ai";
import { scoreFromSignals, type CollisionSignals } from "./scoring.ts";
import { availabilityKey, getAvailability } from "./store.ts";
import type { AvailabilityEvidence, AvailabilityRecord, BrandState } from "./types.ts";

const FLAG = Type.Union([Type.Boolean(), Type.Null()]);
const MAX_ASSESSMENT_URL_LENGTH = 320;
export const ASSESSMENT_SCHEMA = Type.Object({ results: Type.Array(Type.Object({
  name: Type.String(), reason: Type.String({ maxLength: 400 }),
  famousCollision: FLAG, sameSpaceCollision: FLAG, giantAssociation: FLAG,
  unrelatedCount: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
  comParked: FLAG, sourceUrls: Type.Array(Type.String(), { maxItems: 6 }),
}), { maxItems: 3 }) });

type Assessment = { name: string; reason: string; sourceUrls: string[] } & { [K in keyof CollisionSignals]: CollisionSignals[K] | null };
export interface CheckDependencies {
  search: (name: string, signal: AbortSignal) => Promise<AvailabilityEvidence[]>;
  assess: (prompt: string, signal: AbortSignal) => Promise<{ results: Assessment[]; usage?: Usage }>;
  fetch: typeof fetch;
}

/** Extract source-linked snippets rather than retaining an entire search transcript. */
export function extractWebEvidence(content: unknown): AvailabilityEvidence[] {
  const found = new Map<string, AvailabilityEvidence>();
  const add = (url: string, detail: string) => {
    if (/^https?:\/\//.test(url) && !found.has(url) && found.size < 6) found.set(url, { source: "web", url, detail: detail.slice(0, 1500) });
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 10 || found.size >= 6) return;
    if (typeof value === "string") {
      try { visit(JSON.parse(value), depth + 1); return; } catch { /* Plain search excerpts may use Markdown. */ }
      const lines = value.split("\n");
      for (let index = 0; index < lines.length; index++) {
        for (const match of lines[index].matchAll(/https?:\/\/[^\s<>"\]\)]+/g)) {
          add(match[0], lines.slice(Math.max(0, index - 1), index + 3).join("\n"));
        }
      }
      return;
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 30)) visit(item, depth + 1); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    const url = item.url ?? item.link;
    if (typeof url === "string") {
      const detail = [item.title, item.description, item.snippet, item.content, item.text].filter((part): part is string => typeof part === "string").join("\n");
      if (detail) add(url, detail);
    }
    for (const [key, child] of Object.entries(item)) if (key !== "url" && key !== "link") visit(child, depth + 1);
  };
  visit(content, 0);
  return [...found.values()];
}

function requirementsKey(state: BrandState): string {
  return JSON.stringify({ product: state.product, domains: state.brief.domains, packages: state.brief.checkPackages });
}

async function inspectUrl(url: string, source: AvailabilityEvidence["source"], signal: AbortSignal, fetcher: typeof fetch): Promise<AvailabilityEvidence> {
  const timeout = AbortSignal.timeout(5000);
  try {
    const response = await fetcher(url, { signal: AbortSignal.any([signal, timeout]), headers: { Accept: "application/json" } });
    await response.body?.cancel();
    // Registry responses establish only registry status, not brand or legal ownership.
    if (response.status === 404) return { source, url, detail: source === "domain" ? "No registration record found. Confirm registrability and price with a registrar." : "No package entry found." };
    if (!response.ok) return { source, url, detail: `Unknown: lookup returned HTTP ${response.status}.` };
    if (source === "domain") return { source, url, detail: "A domain registration record exists. Ownership, price and active business remain unverified." };
    if (source === "npm") return { source, url, detail: "An npm package uses this name. This alone does not establish a same-category brand collision." };
    // No repository response body is needed to establish that this endpoint was queried.
    return { source, url, detail: "GitHub name search succeeded. Repository matches are not trademark or organization-handle clearance; inspect the linked search." };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { source, url, detail: `Unknown: ${error instanceof Error ? error.message : "lookup failed"}.` };
  }
}

function assessPrompt(state: BrandState, items: { name: string; evidence: AvailabilityEvidence[] }[]): string {
  // Pass only bounded web excerpts. Keep original evidence intact for display and later checks.
  const excerpts = items.map((item) => ({ name: item.name, evidence: item.evidence
    .filter((entry) => entry.source === "web" && entry.url.length <= MAX_ASSESSMENT_URL_LENGTH)
    .slice(0, 3)
    .map((entry) => ({ url: entry.url, detail: entry.detail.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 400) })) }));
  return [
    "Assess naming collisions from supplied web excerpts only. Null means not established. Do not invent businesses, domains, sources, or legal conclusions.",
    "A package or repository alone is not a same-category collision. Distinguish unrelated famous brands from same-category uses. Count unrelated uses only if identified in evidence.",
    "comParked requires evidence of parking/for-sale, not registration. Give a short factual reason and cite only URLs below. This is not trademark clearance.",
    `Product: ${state.product.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)}`,
    JSON.stringify(excerpts),
  ].join("\n");
}

export async function checkFinalists(
  state: BrandState,
  stage: "screen" | "deep",
  dependencies: CheckDependencies,
  options: { refresh?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ records: Record<string, AvailabilityRecord>; cached: string[]; usage?: Usage }> {
  if (state.finalists.length === 0 || state.finalists.length > 3) throw new Error("Choose one to three finalists first.");
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error("Check cancelled"));
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const abort = () => reject(controller.signal.reason ?? new Error("Check cancelled"));
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    timer = setTimeout(() => controller.abort(new Error("Availability check exceeded its 45-second budget; retry explicitly.")), options.timeoutMs ?? 45_000);
  });
  const run = async () => {
    const records: Record<string, AvailabilityRecord> = Object.create(null);
    const cached: string[] = [];
    const pending: { name: string; evidence: AvailabilityEvidence[]; warnings: string[]; previous?: AvailabilityRecord }[] = [];
    const key = requirementsKey(state);
    await Promise.all(state.finalists.map(async (name) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const previous = options.refresh ? undefined : getAvailability(state, name);
      if (previous && (previous.stage !== "screen" || stage === "screen" || previous.score === "terrible")) {
        records[availabilityKey(name)] = previous.requirementsKey && previous.requirementsKey !== key
          ? { ...previous, warnings: [...(previous.warnings ?? []), "Requirements changed since this check. Use /brand check refresh to update it."] }
          : previous;
        cached.push(name);
        return;
      }
      const warnings: string[] = [];
      let evidence = previous?.evidence?.slice() ?? [];
      if (!previous) {
        try { evidence = (await dependencies.search(name, controller.signal)).slice(0, 6); }
        catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          warnings.push(`Web search unavailable: ${error instanceof Error ? error.message : "failed"}`);
        }
      }
      if (!evidence.some((entry) => entry.source === "web")) warnings.push("No source-linked web evidence; collision assessment is incomplete.");
      pending.push({ name, evidence, warnings, previous });
    }));
    // Network completion order must not randomize the worker request or its cache prefix.
    pending.sort((a, b) => state.finalists.indexOf(a.name) - state.finalists.indexOf(b.name));
    let usage: Usage | undefined;
    let assessments: Assessment[] = [];
    const needsAssessment = pending.filter((item) => !item.previous && item.evidence.some((entry) => entry.source === "web" && entry.url.length <= MAX_ASSESSMENT_URL_LENGTH));
    if (needsAssessment.length > 0) {
      try {
        const response = await dependencies.assess(assessPrompt(state, needsAssessment), controller.signal);
        assessments = response.results;
        usage = response.usage;
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        for (const item of needsAssessment) item.warnings.push(`Assessment unavailable: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    await Promise.all(pending.map(async (item) => {
      const assessment = assessments.find((entry) => availabilityKey(entry.name) === availabilityKey(item.name));
      const signals: Partial<CollisionSignals> = { ...item.previous?.signals };
      const suppliedUrls = new Set(item.evidence.filter((entry) => entry.source === "web" && entry.url.length <= MAX_ASSESSMENT_URL_LENGTH).slice(0, 3).map((entry) => entry.url));
      // Uncited model judgments never become persisted collision facts.
      const supported = assessment?.sourceUrls.some((url) => suppliedUrls.has(url)) && assessment.sourceUrls.every((url) => suppliedUrls.has(url));
      if (assessment && supported) {
        for (const property of ["famousCollision", "sameSpaceCollision", "giantAssociation", "comParked"] as const) {
          if (typeof assessment[property] === "boolean") signals[property] = assessment[property];
        }
        if (typeof assessment.unrelatedCount === "number") signals.unrelatedCount = assessment.unrelatedCount;
      } else if (!item.previous) item.warnings.push("No supported assessment; missing signals remain unknown.");
      let verdict = scoreFromSignals(signals);
      // A decisive collision earns early exit. Do not spend domain/package requests on it.
      if (stage === "deep" && verdict.score !== "terrible") {
        const label = item.name.toLowerCase().replace(/\s+/g, "");
        const lookups = state.brief.domains.map((suffix) => inspectUrl(`https://rdap.org/domain/${encodeURIComponent(`${label}.${suffix}`)}`, "domain", controller.signal, dependencies.fetch));
        if (state.brief.checkPackages) {
          lookups.push(inspectUrl(`https://registry.npmjs.org/${encodeURIComponent(label)}`, "npm", controller.signal, dependencies.fetch));
          lookups.push(inspectUrl(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${label} in:name`)}&per_page=3`, "github", controller.signal, dependencies.fetch));
        }
        item.evidence.push(...await Promise.all(lookups));
        if (item.evidence.some((entry) => entry.detail.startsWith("Unknown:"))) {
          item.warnings.push("Some registry checks failed; registrability/handles remain unknown.");
          if (verdict.score === "perfect" || verdict.score === "good" || verdict.score === "decent") verdict = { score: "unknown", reason: "incomplete registry checks" };
        }
      }
      if (stage === "screen") item.warnings.push("Quick web screen only. Domains, package names and trademarks were not cleared.");
      if (item.warnings.length > 0 && verdict.score === "perfect") verdict = { score: "unknown", reason: "incomplete check coverage" };
      records[availabilityKey(item.name)] = {
        score: verdict.score,
        reason: assessment && supported ? `${assessment.reason} (${verdict.reason})` : item.previous?.reason ?? verdict.reason,
        signals, checkedAt: new Date().toISOString(), stage,
        evidence: item.evidence.slice(0, 20), warnings: item.warnings,
        requirementsKey: key,
      };
    }));
    if (controller.signal.aborted) throw controller.signal.reason;
    return { records, cached, usage };
  };
  try { return await Promise.race([run(), deadline]); }
  finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
