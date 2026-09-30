export type AvailabilityScore = "perfect" | "good" | "decent" | "bad" | "terrible" | "unknown";

export const SCORE_ORDER: AvailabilityScore[] = ["perfect", "good", "decent", "bad", "terrible", "unknown"];
export const SCORE_INFO: Record<AvailabilityScore, { label: string; meaning: string }> = {
  perfect: { label: "perfect", meaning: "No notable collision in the checks performed; not legal clearance" },
  good: { label: "good", meaning: "Some unrelated usage; worth considering" },
  decent: { label: "decent", meaning: "Multiple unrelated uses; review discoverability" },
  bad: { label: "bad", meaning: "Crowded name or strong unrelated brand association" },
  terrible: { label: "terrible", meaning: "Notable same-category or famous-brand collision; avoid confusion" },
  unknown: { label: "unknown", meaning: "Insufficient evidence; missing checks are not a clean result" },
};

export function isAvailabilityScore(value: unknown): value is AvailabilityScore {
  return typeof value === "string" && SCORE_ORDER.includes(value as AvailabilityScore);
}

export function formatScore(score: AvailabilityScore | undefined): string {
  return score ?? "unscored";
}

export function compareScores(a: AvailabilityScore, b: AvailabilityScore): number {
  return SCORE_ORDER.indexOf(a) - SCORE_ORDER.indexOf(b);
}

export interface CollisionSignals {
  famousCollision: boolean;
  sameSpaceCollision: boolean;
  giantAssociation: boolean;
  unrelatedCount: number;
  comParked: boolean;
}

export function scoreFromSignals(signals: Partial<CollisionSignals>): { score: AvailabilityScore; reason: string } {
  if (signals.sameSpaceCollision || signals.famousCollision) {
    return { score: "terrible", reason: "notable same-category or famous-brand collision; not a legal determination" };
  }
  if (signals.giantAssociation) return { score: "bad", reason: "strong unrelated brand association" };
  if ((signals.unrelatedCount ?? 0) >= 5) return { score: "bad", reason: "crowded name" };
  const complete = [signals.famousCollision, signals.sameSpaceCollision, signals.giantAssociation, signals.comParked].every((value) => typeof value === "boolean") && typeof signals.unrelatedCount === "number" && Number.isFinite(signals.unrelatedCount) && signals.unrelatedCount >= 0;
  if (!complete) return { score: "unknown", reason: "incomplete collision evidence" };
  if (signals.unrelatedCount! >= 2) return { score: "decent", reason: "multiple unrelated uses; review discoverability" };
  if (signals.unrelatedCount! >= 1 || signals.comParked) return { score: "good", reason: "some unrelated usage or a parked domain" };
  return { score: "perfect", reason: "no notable collision in the checks performed; not legal clearance" };
}
