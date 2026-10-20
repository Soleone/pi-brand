import type { ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { AvailabilityScore, CollisionSignals } from "./scoring.ts";

/** Explicit brand reasoning override. Omitted means follow pi's configured default for the model. */
export type BrandReasoning = ThinkingLevel | "off";

export const BRAND_REASONING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function isBrandReasoning(value: string): value is BrandReasoning {
  return value === "off" || (BRAND_REASONING_LEVELS as readonly string[]).includes(value);
}

export interface Candidate {
  name: string;
  flavor?: string;
  style?: string;
  score?: AvailabilityScore;
  scoreReason?: string;
}

export interface BrandRound {
  id: string;
  createdAt: string;
  product: string;
  directionHint?: string;
  candidates: Candidate[];
  poolId?: string;
  origin?: "generated" | "reserve" | "external" | "legacy";
  briefRevision?: number;
}

export interface LikedName extends Candidate {
  roundId?: string;
  likedAt: string;
}

export interface AvailabilityEvidence {
  source: "web" | "domain" | "npm" | "github";
  url: string;
  detail: string;
}

export interface AvailabilityRecord {
  score: AvailabilityScore;
  reason: string;
  signals?: Partial<CollisionSignals>;
  checkedAt: string;
  stage?: "legacy" | "screen" | "deep";
  /** Checker research rules that produced this record. */
  researchVersion?: number;
  evidence?: AvailabilityEvidence[];
  /** Exact queries used, including for successful searches with no hits. */
  searchQueries?: string[];
  warnings?: string[];
  /** A fingerprint of requirements, not a claim of timeless availability. */
  requirementsKey?: string;
  model?: string;
}

export interface NamingContent {
  product: string;
  direction: string;
  avoid: string;
  style: string;
  examples: string[];
  singleWord: boolean;
  maxLength: number;
}

export interface FeedbackEntry {
  id: string;
  createdAt: string;
  author: "user" | "assistant" | "unknown";
  source: "chat" | "picker" | "command" | "file" | "brief-editor" | "similar" | "legacy";
  text: string;
  briefRevision: number;
  changes: string[];
  error?: string;
  before?: NamingContent;
  after?: NamingContent;
}

export interface GenerationPool {
  id: string;
  createdAt: string;
  model: string;
  briefRevision: number;
  inputKey: string;
  brief: import("./generation.ts").NamingBrief;
  prompts: string[];
  systemPrompt?: string;
  candidates: Candidate[];
  origin: "generated" | "external";
}

export interface NamingPreferences {
  direction: string;
  avoid: string;
  style: string;
  examples: string[];
  singleWord: boolean;
  maxLength: number;
  /** Suffixes to inspect, not promises of domain registration. */
  domains: string[];
  checkPackages: boolean;
}

export interface GenerationMetric {
  createdAt: string;
  model: string;
  modelCalls: number;
  elapsedMs: number;
  generated: number;
  usage?: Usage;
}

export interface BrandState {
  version: 4;
  product: string;
  updatedAt: string;
  rounds: BrandRound[];
  liked: LikedName[];
  /** Active names; favorites are a subset. Historical rounds remain immutable. */
  selected: string[];
  dismissed: string[];
  /** Historical notes are retained but no longer replayed into every prompt. */
  directionNotes: string[];
  availability: Record<string, AvailabilityRecord>;
  finalists: string[];
  brief: NamingPreferences;
  /** Creative model for naming. */
  model: string;
  /** Omitted means use the creative model for availability assessment too. */
  workerModel?: string;
  /** Overrides pi's configured reasoning level for the creative model. Omitted follows pi. */
  reasoning?: BrandReasoning;
  /** Overrides pi's configured reasoning level for the worker model. Omitted follows pi. */
  workerReasoning?: BrandReasoning;
  reserve: Candidate[];
  generationMetrics: GenerationMetric[];
  briefRevision: number;
  /** Exact document last read. Prevents overwriting concurrent edits. */
  briefDocumentHash?: string;
  feedback: FeedbackEntry[];
  pools: GenerationPool[];
  reservePoolId?: string;
  lastBatch?: { poolId: string; origin: "generated" | "reserve" | "external" };
}

export function emptyBrandState(product = ""): BrandState {
  return {
    version: 4,
    product,
    updatedAt: new Date().toISOString(),
    rounds: [],
    liked: [],
    selected: [],
    dismissed: [],
    directionNotes: [],
    availability: {},
    finalists: [],
    brief: { direction: "", avoid: "", style: "Recognizable, easy to say and spell.", examples: [], singleWord: true, maxLength: 12, domains: ["com", "app"], checkPackages: false },
    model: "openai/gpt-6-luna",
    reserve: [],
    generationMetrics: [],
    briefRevision: 1,
    feedback: [],
    pools: [],
  };
}
