/**
 * Availability score scale. The deep check that computes this (npm, GitHub,
 * DNS, web) lands in a later step. For now the scale is defined and every
 * candidate carries an optional score so the UI and storage are ready.
 */
export type AvailabilityScore = "perfect" | "good" | "decent" | "bad" | "terrible";

export const SCORE_ORDER: AvailabilityScore[] = ["perfect", "good", "decent", "bad", "terrible"];

export const SCORE_INFO: Record<AvailabilityScore, { label: string; meaning: string }> = {
  perfect: {
    label: "perfect",
    meaning: "pretty much no collisions",
  },
  good: {
    label: "good",
    meaning: "some unrelated collisions, still commercially possible",
  },
  decent: {
    label: "decent",
    meaning:
      "further clashes, but not in the same category. Should be okay for open source legal wise, and people should not think of the other collision when introduced to this app",
  },
  bad: {
    label: "bad",
    meaning: "lots of collisions, some in the same category",
  },
  terrible: {
    label: "terrible",
    meaning: "actual high legal risk from a reputable company",
  },
};

export function isAvailabilityScore(value: unknown): value is AvailabilityScore {
  return (
    value === "perfect" ||
    value === "good" ||
    value === "decent" ||
    value === "bad" ||
    value === "terrible"
  );
}

export function formatScore(score: AvailabilityScore | undefined): string {
  if (!score) return "unscored";
  return score;
}

/** Compare two scores. Negative when a is better than b. */
export function compareScores(a: AvailabilityScore, b: AvailabilityScore): number {
  return SCORE_ORDER.indexOf(a) - SCORE_ORDER.indexOf(b);
}

/**
 * STUB for the next step. Returns undefined (unscored) with a reason so the
 * picker UI can show that the deep check has not run yet.
 */
export function stubScoreFor(_name: string): { score: undefined; reason: string } {
  return { score: undefined, reason: "deep check not run yet (npm/GitHub/DNS/web land next)" };
}

export interface CollisionSignals {
  /** Famous product or brand in any space. */
  famousCollision: boolean;
  /** Active business in the same or adjacent space on .com. */
  sameSpaceCollision: boolean;
  /** Strong association with an unrelated giant. */
  giantAssociation: boolean;
  /** Count of unrelated collisions. */
  unrelatedCount: number;
  /** .com parked or for sale with no product. */
  comParked: boolean;
}

/**
 * STUB mapping for the next step. Pure function so the real checker only has
 * to produce CollisionSignals and this mapping stays. Untested against live
 * data until the checker lands.
 */
export function scoreFromSignals(signals: CollisionSignals): {
  score: AvailabilityScore;
  reason: string;
} {
  if (signals.famousCollision || signals.sameSpaceCollision || signals.giantAssociation) {
    return {
      score: "terrible",
      reason: "high legal risk: famous, same-space, or giant-associated collision",
    };
  }
  if (signals.unrelatedCount >= 5) {
    return { score: "bad", reason: "lots of collisions" };
  }
  if (signals.unrelatedCount >= 2) {
    return {
      score: "decent",
      reason: "further clashes but none in the same category",
    };
  }
  if (signals.unrelatedCount >= 1 || signals.comParked) {
    return { score: "good", reason: "some unrelated collisions, still commercially possible" };
  }
  return { score: "perfect", reason: "pretty much no collisions" };
}
