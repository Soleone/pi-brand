import type { Usage } from "@earendil-works/pi-ai";
import type { Candidate } from "./types.ts";

export interface NamingBrief {
  product: string;
  direction: string;
  examples: string[];
  constraints: { singleWord: boolean; maxLength: number };
  excluded: string[];
}

export type GenerationRequest = (
  prompt: string,
  signal: AbortSignal,
) => Promise<{ candidates: Candidate[]; usage?: Usage }>;

const REQUEST_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 45_000;
const MAX_PROPOSALS = 24;
const MAX_POOL = 24;
const REFILL_THRESHOLD = 8;

function compact(value: string, limit: number): string {
  return value.trim().slice(0, limit);
}

function promptFor(brief: NamingBrief, excluded: Set<string>): string {
  const recent = [...excluded].slice(-24);
  const exampleLine = brief.examples.slice(-8).map((item) => compact(item, 60)).filter(Boolean).join(", ");
  return [
    `Generate up to 24 ranked candidate names for: ${compact(brief.product, 300)}`,
    `Direction: ${compact(brief.direction, 500)}`,
    brief.constraints.singleWord
      ? "Use familiar, recognizable English single words; easy to spell."
      : "Use familiar, recognizable words; spaces are allowed.",
    `Maximum length: ${Math.max(1, Math.floor(brief.constraints.maxLength))} characters.`,
    exampleLine ? `Examples show taste only; do not copy: ${exampleLine}` : "",
    "Follow the direction. Avoid obvious famous brands and same-category products using existing knowledge only. Do no availability or other research. Include only a compact optional flavor note for each name.",
    `Do not use excluded names (${excluded.size} total); recent sample: ${recent.join(", ") || "none"}.`,
    "Return candidates in rank order.",
  ].filter(Boolean).join("\n");
}

function key(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase();
}

function validName(name: string, brief: NamingBrief): boolean {
  const normalized = name.normalize("NFKC").trim();
  if (!normalized || normalized.length > brief.constraints.maxLength) return false;
  if (/\d|[-‐‑‒–—]/u.test(normalized)) return false;
  if (/^(?:[Gg]et|[Tt]ry)[A-Z]/u.test(normalized)) return false;
  const pattern = brief.constraints.singleWord ? /^\p{L}+$/u : /^\p{L}+(?: \p{L}+)*$/u;
  return pattern.test(normalized);
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b ? structuredClone(b) : undefined;
  if (!b) return a;
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined ? { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) } : {}),
    ...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

export async function generatePool(
  brief: NamingBrief,
  request: GenerationRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ candidates: Candidate[]; metrics: { modelCalls: number; elapsedMs: number; usage?: Usage } }> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  let modelCalls = 0;
  let usage: Usage | undefined;
  const pool: Candidate[] = [];
  const seen = new Set(brief.excluded.map(key));
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const operationTimeout = new Promise<never>((_, reject) => {
    operationTimer = setTimeout(() => {
      controller.abort(new Error("Naming generation exceeded its time limit"));
      reject(new Error("Naming generation exceeded its time limit"));
    }, timeoutMs);
  });
  const run = async () => {
    for (let call = 0; call < 2; call++) {
      if (call === 1 && pool.length >= REFILL_THRESHOLD) break;
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Generation aborted");
      const requestController = new AbortController();
      const onAbort = () => requestController.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const requestTimer = setTimeout(() => requestController.abort(new Error("Naming request timed out")), Math.min(REQUEST_TIMEOUT_MS, timeoutMs));
      modelCalls++;
      try {
        const result = await Promise.race([
          request(promptFor(brief, seen), requestController.signal),
          new Promise<never>((_, reject) => requestController.signal.addEventListener("abort", () => reject(requestController.signal.reason ?? new Error("Naming request aborted")), { once: true })),
        ]);
        usage = addUsage(usage, result.usage);
        for (const proposal of result.candidates.slice(0, MAX_PROPOSALS)) {
          if (pool.length >= MAX_POOL) break;
          const name = compact(proposal.name, 500);
          const normalizedKey = key(name);
          if (!validName(name, brief)) continue;
          if (seen.has(normalizedKey)) {
            // The refill sees its rejected attempts, not just unrelated recent history.
            seen.delete(normalizedKey);
            seen.add(normalizedKey);
            continue;
          }
          seen.add(normalizedKey);
          pool.push({ name, ...(proposal.flavor ? { flavor: compact(proposal.flavor, 120) } : {}), ...(proposal.style ? { style: compact(proposal.style, 60) } : {}) });
        }
      } finally {
        clearTimeout(requestTimer);
        controller.signal.removeEventListener("abort", onAbort);
      }
    }
    if (pool.length === 0) throw new Error("Name generation returned no valid, non-excluded candidates");
    return { candidates: pool, metrics: { modelCalls, elapsedMs: Date.now() - start, ...(usage ? { usage } : {}) } };
  };
  try {
    return await Promise.race([run(), operationTimeout]);
  } finally {
    if (operationTimer) clearTimeout(operationTimer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
