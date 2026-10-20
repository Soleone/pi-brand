export type AvailabilityScore = "perfect" | "good" | "decent" | "bad" | "terrible" | "review" | "error" | "unknown";

export const SCORE_ORDER: AvailabilityScore[] = ["perfect", "good", "decent", "review", "bad", "terrible", "error", "unknown"];
export const SCORE_INFO: Record<AvailabilityScore, { label: string; meaning: string; nextStep: string }> = {
  perfect: { label: "clear", meaning: "No notable collision found in the searches performed", nextStep: "Worth shortlisting. Verify domains and trademarks before committing." },
  good: { label: "light use", meaning: "Some unrelated usage; worth considering", nextStep: "Check the cited uses for search confusion, then shortlist if they feel distinct." },
  decent: { label: "some overlap", meaning: "Multiple unrelated uses; review discoverability", nextStep: "Compare the cited uses with your audience and search discoverability." },
  bad: { label: "crowded", meaning: "Crowded name or strong unrelated brand association", nextStep: "Consider another name unless you have a clear way to distinguish it." },
  terrible: { label: "name clash", meaning: "Notable same-category or famous-brand collision; avoid confusion", nextStep: "Explore another name. The cited use risks confusion with your product." },
  review: { label: "needs review", meaning: "A specific potential collision needs a human decision", nextStep: "Read the cited finding before deciding. A recheck is available, not required." },
  error: { label: "check failed", meaning: "Research could not complete; no availability verdict", nextStep: "Retry the check. If it keeps failing, verify web search and the worker model in settings." },
  unknown: { label: "recheck needed", meaning: "An older incomplete assessment needs a fresh check", nextStep: "Run a fresh check with the current research rules." },
};

export function isAvailabilityScore(value: unknown): value is AvailabilityScore {
  return typeof value === "string" && SCORE_ORDER.includes(value as AvailabilityScore);
}

export function formatScore(score: AvailabilityScore | undefined): string {
  return score ? SCORE_INFO[score].label : "not checked";
}

export function needsCheck(score: AvailabilityScore | undefined): boolean {
  return !score || score === "unknown" || score === "error";
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
  const complete = [signals.famousCollision, signals.sameSpaceCollision, signals.giantAssociation].every((value) => typeof value === "boolean") && typeof signals.unrelatedCount === "number" && Number.isFinite(signals.unrelatedCount) && signals.unrelatedCount >= 0;
  if (!complete) return { score: "unknown", reason: "incomplete collision evidence" };
  if (signals.unrelatedCount! >= 2) return { score: "decent", reason: "multiple unrelated uses; review discoverability" };
  if (signals.unrelatedCount! >= 1 || signals.comParked) return { score: "good", reason: "some unrelated usage or a parked domain" };
  return { score: "perfect", reason: "no notable collision in the checks performed; not legal clearance" };
}
