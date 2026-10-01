import type { Usage } from "@earendil-works/pi-ai";
import type { AvailabilityScore, CollisionSignals } from "./scoring.ts";

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
  warnings?: string[];
  /** A fingerprint of requirements, not a claim of timeless availability. */
  requirementsKey?: string;
}

export interface NamingPreferences {
  direction: string;
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
  version: 2;
  product: string;
  updatedAt: string;
  rounds: BrandRound[];
  liked: LikedName[];
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
  reserve: Candidate[];
  generationMetrics: GenerationMetric[];
}

export function emptyBrandState(product = ""): BrandState {
  return {
    version: 2,
    product,
    updatedAt: new Date().toISOString(),
    rounds: [],
    liked: [],
    dismissed: [],
    directionNotes: [],
    availability: {},
    finalists: [],
    brief: { direction: "", singleWord: true, maxLength: 12, domains: ["com", "app"], checkPackages: false },
    model: "openai/gpt-6-luna",
    reserve: [],
    generationMetrics: [],
  };
}
