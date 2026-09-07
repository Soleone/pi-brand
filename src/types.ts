import type { AvailabilityScore, CollisionSignals } from "./scoring.ts";

/** One generated name candidate. */
export interface Candidate {
  name: string;
  flavor?: string;
  /** Loose style bucket, e.g. playful, plain, invented. */
  style?: string;
  /** Availability score. Undefined until the deep check runs. */
  score?: AvailabilityScore;
  scoreReason?: string;
}

/** One generation round. */
export interface BrandRound {
  id: string;
  createdAt: string;
  product: string;
  directionHint?: string;
  candidates: Candidate[];
}

/** A name the user liked via the picker. */
export interface LikedName {
  name: string;
  flavor?: string;
  style?: string;
  roundId?: string;
  likedAt: string;
  score?: AvailabilityScore;
  scoreReason?: string;
}

/** One availability deep-check result, cached forever so a name is never researched twice. */
export interface AvailabilityRecord {
  score: AvailabilityScore;
  reason: string;
  /** The raw collision signals behind the score, kept for audit. */
  signals?: CollisionSignals;
  checkedAt: string;
}

/** Persisted brand state for one product (one file per project). */
export interface BrandState {
  version: 1;
  product: string;
  updatedAt: string;
  rounds: BrandRound[];
  liked: LikedName[];
  dismissed: string[];
  directionNotes: string[];
  /** Availability cache, keyed by lowercased name. Survives across sessions. */
  availability: Record<string, AvailabilityRecord>;
}

export function emptyBrandState(product = ""): BrandState {
  return {
    version: 1,
    product,
    updatedAt: new Date().toISOString(),
    rounds: [],
    liked: [],
    dismissed: [],
    directionNotes: [],
    availability: {},
  };
}
