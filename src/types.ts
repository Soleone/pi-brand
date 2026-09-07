import type { AvailabilityScore } from "./scoring.ts";

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

/** Persisted brand state for one product (one file per project). */
export interface BrandState {
  version: 1;
  product: string;
  updatedAt: string;
  rounds: BrandRound[];
  liked: LikedName[];
  dismissed: string[];
  directionNotes: string[];
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
  };
}
