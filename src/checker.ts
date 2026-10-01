import { Type, type Usage } from "@earendil-works/pi-ai";
import { scoreFromSignals, type CollisionSignals } from "./scoring.ts";
import { availabilityKey, getAvailability } from "./store.ts";
import type { AvailabilityEvidence, AvailabilityRecord, BrandState } from "./types.ts";

const FLAG = Type.Union([Type.Boolean(), Type.Null()]);
const MAX_ASSESSMENT_URL_LENGTH = 320;
export const CHECK_RESEARCH_VERSION = 2;

const LEARNING_PRODUCT = /\b(?:learn\w*|educat\w*|stud\w*|flashcard\w*|memor\w*|retain\w*|retention|knowledge|vocab\w*|vokabel\w*|quiz\w*|school|course|bildung|wissen\w*)\b/i;
const LEARNING_SEARCH_TERMS = "learning education study flashcards vocabulary memory retention quiz knowledge facts trivia game puzzle";
const LEARNING_ACTIVITY = /\b(?:learn\w*|educat\w*|stud\w*|flashcard\w*|vocab\w*|vokabel\w*|mnemonic\w*|merkbild\w*|spaced repetition|memor\w*|memory|retent\w*|quiz\w*|lesson\w*|course\w*|teach\w*|school\w*|lern\w*|wissen\w*)\b/i;
const FACTUAL_GAME = /\b(?:fact\w*|trivia|knowledge|wissen\w*)\b/i;
const GAME_ACTIVITY = /\b(?:game\w*|puzzle\w*|sort\w*|quiz\w*|challenge\w*|daily|täglich)\b/i;

export function buildCollisionSearchQueries(name: string, product: string): string[] {
  const clean = (value: string, limit: number) => value.replace(/[\r\n"]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  const brand = clean(name, 60);
  const productPhrase = clean(product, 120) || "app";
  const spaceTerms = LEARNING_PRODUCT.test(product) ? LEARNING_SEARCH_TERMS : productPhrase;
  return [
    `"${brand}" ${productPhrase} app`,
    `"${brand}" ${spaceTerms} app software company`,
  ];
}

export function shouldRefreshUnknown(record: AvailabilityRecord | undefined, stage: "screen" | "deep"): boolean {
  return stage === "deep" && !!record && record.stage !== "legacy" && record.score === "unknown" && record.researchVersion !== CHECK_RESEARCH_VERSION;
}

function normalizedEvidenceText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function hasLearningProductEvidence(name: string, product: string, evidence: AvailabilityEvidence[]): boolean {
  if (!LEARNING_PRODUCT.test(product)) return false;
  const key = normalizedEvidenceText(name);
  if (key.length < 3) return false;
  return evidence.some((entry) => {
    if (entry.source !== "web") return false;
    let hostname: string;
    try { hostname = new URL(entry.url).hostname; } catch { return false; }
    const hostHasName = hostname.split(".").some((label) => {
      const normalized = normalizedEvidenceText(label);
      return normalized === key || (normalized.startsWith(key) && /^(?:app|game|learn|study|quiz|coach|education)/.test(normalized.slice(key.length)));
    });
    const marketplace = /(?:^|\.)apps\.apple\.com$|(?:^|\.)play\.google\.com$/i.test(hostname);
    if (!hostHasName && !(marketplace && normalizedEvidenceText(entry.detail).includes(key))) return false;
    const detail = entry.detail.toLocaleLowerCase();
    return LEARNING_ACTIVITY.test(detail) || (FACTUAL_GAME.test(detail) && GAME_ACTIVITY.test(detail));
  });
}

function evidenceRelevance(detail: string, product: string): number {
  let score = 0;
  if (LEARNING_PRODUCT.test(product)) {
    if (LEARNING_ACTIVITY.test(detail)) score += 3;
    if (FACTUAL_GAME.test(detail) && GAME_ACTIVITY.test(detail)) score += 3;
  }
  const terms = product.toLocaleLowerCase().match(/[\p{L}]{4,}/gu) ?? [];
  const ignored = new Set(["learning", "retaining", "information", "education", "educational", "software", "product", "application"]);
  for (const term of terms) if (!ignored.has(term) && detail.toLocaleLowerCase().includes(term)) score++;
  return score;
}

function selectAssessmentEvidence(evidence: AvailabilityEvidence[], product: string): AvailabilityEvidence[] {
  return evidence
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.source === "web" && entry.url.length <= MAX_ASSESSMENT_URL_LENGTH)
    .sort((a, b) => evidenceRelevance(b.entry.detail, product) - evidenceRelevance(a.entry.detail, product) || a.index - b.index)
    .slice(0, 4)
    .sort((a, b) => a.index - b.index)
    .map(({ entry }) => entry);
}
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
  // Rank all bounded excerpts so an on-category source later in search results is not discarded.
  const excerpts = items.map((item) => ({ name: item.name, evidence: selectAssessmentEvidence(item.evidence, state.product)
    .map((entry) => ({ url: entry.url, detail: entry.detail.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 400) })) }));
  return [
    "Assess naming collisions from supplied web excerpts only. Null means not established. Do not invent businesses, domains, sources, or legal conclusions.",
    "A package or repository alone is not a same-category collision. Distinguish unrelated famous brands from same-category uses. Count unrelated uses only if identified in evidence.",
    "When the named use clearly serves the product's broad user need, count it as same-space even if its format differs. For learning/retention products, vocabulary, mnemonic, spaced-repetition, quiz, fact-learning, and book-learning products are relevant. Require the excerpt to support the named use and activity; do not infer from the name alone.",
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
      const cachedRecord = options.refresh ? undefined : getAvailability(state, name);
      const previous = shouldRefreshUnknown(cachedRecord, stage) ? undefined : cachedRecord;
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
      const suppliedUrls = new Set(selectAssessmentEvidence(item.evidence, state.product).map((entry) => entry.url));
      // Uncited model judgments never become persisted collision facts.
      const supported = assessment?.sourceUrls.some((url) => suppliedUrls.has(url)) && assessment.sourceUrls.every((url) => suppliedUrls.has(url));
      const learningCollision = hasLearningProductEvidence(item.name, state.product, item.evidence);
      if (assessment && supported) {
        for (const property of ["famousCollision", "sameSpaceCollision", "giantAssociation", "comParked"] as const) {
          if (typeof assessment[property] === "boolean") signals[property] = assessment[property];
        }
        if (typeof assessment.unrelatedCount === "number") signals.unrelatedCount = assessment.unrelatedCount;
      }
      if (learningCollision) signals.sameSpaceCollision = true;
      else if (!supported && !item.previous) item.warnings.push("No supported assessment; missing signals remain unknown.");
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
        reason: learningCollision
          ? `Web evidence describes a learning or knowledge product using this name (${verdict.reason})`
          : assessment && supported ? `${assessment.reason} (${verdict.reason})` : item.previous?.reason ?? verdict.reason,
        signals, checkedAt: new Date().toISOString(), stage, researchVersion: CHECK_RESEARCH_VERSION,
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
