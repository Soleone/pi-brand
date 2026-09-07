import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { isAvailabilityScore, type CollisionSignals } from "./scoring.ts";
import {
  emptyBrandState,
  type AvailabilityRecord,
  type BrandRound,
  type BrandState,
  type Candidate,
} from "./types.ts";

const isScore = isAvailabilityScore;

export interface LoadedBrandState {
  state: BrandState;
  /** File the state was loaded from, or would be written to. */
  path: string;
  isNew: boolean;
  warnings: string[];
}

/**
 * Project-local when trusted (<cwd>/.pi/brand.json), otherwise a global
 * fallback so untrusted projects never touch the repo. One file per product
 * naming effort, so likes never leak across projects.
 */
export function getBrandStatePath(
  cwd: string,
  trustedProject: boolean,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const explicit = env.PI_BRAND_CONFIG?.trim();
  if (explicit) return path.resolve(cwd, expandHome(explicit, homeDirectory));
  if (trustedProject) return path.join(cwd, CONFIG_DIR_NAME, "brand.json");
  const directory = env.PI_CODING_AGENT_DIR?.trim() || path.join(homeDirectory, ".pi", "agent");
  return path.join(directory, "pi-brand.json");
}

export function loadBrandState(
  cwd: string,
  trustedProject: boolean,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): LoadedBrandState {
  const statePath = getBrandStatePath(cwd, trustedProject, env, homeDirectory);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFile(error)) {
      return { state: emptyBrandState(), path: statePath, isNew: true, warnings: [] };
    }
    return {
      state: emptyBrandState(),
      path: statePath,
      isNew: true,
      warnings: [`Could not read ${statePath}: ${errorMessage(error)}`],
    };
  }

  const parsed = normalizeState(raw);
  if (!parsed) {
    return {
      state: emptyBrandState(),
      path: statePath,
      isNew: true,
      warnings: [`${statePath}: unrecognized shape, starting fresh.`],
    };
  }
  return { state: parsed, path: statePath, isNew: false, warnings: [] };
}

export function saveBrandState(statePath: string, state: BrandState): void {
  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const payload: BrandState = { ...state, version: 1, updatedAt: new Date().toISOString() };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = path.join(directory, `.pi-brand.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, statePath);
    try {
      fs.chmodSync(statePath, 0o600);
    } catch {
      // Best effort on platforms without chmod.
    }
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export function recordRound(
  state: BrandState,
  input: { product: string; candidates: Candidate[]; directionHint?: string },
): BrandRound {
  const round: BrandRound = {
    id: `r${state.rounds.length + 1}-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    product: input.product.trim(),
    directionHint: input.directionHint?.trim() || undefined,
    candidates: input.candidates,
  };
  state.rounds.push(round);
  if (input.directionHint?.trim()) {
    state.directionNotes.push(input.directionHint.trim());
  }
  if (input.product.trim()) state.product = input.product.trim();
  return round;
}

/** Add picks to liked, skipping duplicates by case-insensitive name. */
export function addLikes(
  state: BrandState,
  round: BrandRound | undefined,
  picks: Candidate[],
): string[] {
  const added: string[] = [];
  const known = new Set(state.liked.map((entry) => entry.name.toLocaleLowerCase()));
  for (const pick of picks) {
    const name = pick.name.trim();
    if (!name || known.has(name.toLocaleLowerCase())) continue;
    known.add(name.toLocaleLowerCase());
    state.liked.push({
      name,
      flavor: pick.flavor,
      style: pick.style,
      roundId: round?.id,
      likedAt: new Date().toISOString(),
      score: pick.score,
      scoreReason: pick.scoreReason,
    });
    added.push(name);
  }
  return added;
}

/** Cache key for an availability record: case-insensitive, whitespace-trimmed. */
export function availabilityKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** Cached availability for a name, if it was ever deep-checked. */
export function getAvailability(state: BrandState, name: string): AvailabilityRecord | undefined {
  const key = availabilityKey(name);
  if (!key) return undefined;
  return state.availability[key];
}

/**
 * Record an availability result forever and backfill it onto every matching
 * liked entry and round candidate, so the score shows up everywhere the name
 * appears without any re-check.
 */
export function recordAvailability(
  state: BrandState,
  name: string,
  input: { score: AvailabilityRecord["score"]; reason: string; signals?: CollisionSignals },
): AvailabilityRecord {
  const trimmed = name.trim();
  const record: AvailabilityRecord = {
    score: input.score,
    reason: input.reason,
    signals: input.signals,
    checkedAt: new Date().toISOString(),
  };
  state.availability[availabilityKey(trimmed)] = record;
  const matches = (other: string): boolean =>
    other.trim().toLocaleLowerCase() === availabilityKey(trimmed);
  for (const entry of state.liked) {
    if (matches(entry.name)) {
      entry.score = record.score;
      entry.scoreReason = record.reason;
    }
  }
  for (const round of state.rounds) {
    for (const candidate of round.candidates) {
      if (matches(candidate.name)) {
        candidate.score = record.score;
        candidate.scoreReason = record.reason;
      }
    }
  }
  return record;
}

/** Names seen in any round, lowercased, so new rounds avoid repeats. */
export function seenNames(state: BrandState): Set<string> {
  const seen = new Set<string>();
  for (const round of state.rounds) {
    for (const candidate of round.candidates) seen.add(candidate.name.toLocaleLowerCase());
  }
  for (const entry of state.liked) seen.add(entry.name.toLocaleLowerCase());
  for (const name of state.dismissed) seen.add(name.toLocaleLowerCase());
  return seen;
}

function normalizeState(raw: unknown): BrandState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const state = emptyBrandState(typeof record.product === "string" ? record.product : "");
  if (Array.isArray(record.rounds)) {
    for (const entry of record.rounds) {
      const round = normalizeRound(entry);
      if (round) state.rounds.push(round);
    }
  }
  if (Array.isArray(record.liked)) {
    for (const entry of record.liked) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.name !== "string" || !candidate.name.trim()) continue;
      state.liked.push({
        name: candidate.name.trim(),
        flavor: typeof candidate.flavor === "string" ? candidate.flavor : undefined,
        style: typeof candidate.style === "string" ? candidate.style : undefined,
        roundId: typeof candidate.roundId === "string" ? candidate.roundId : undefined,
        likedAt: typeof candidate.likedAt === "string" ? candidate.likedAt : new Date().toISOString(),
        // Scores must survive reloads: never drop them when normalizing.
        score: isScore(candidate.score) ? candidate.score : undefined,
        scoreReason: typeof candidate.scoreReason === "string" ? candidate.scoreReason : undefined,
      });
    }
  }
  if (Array.isArray(record.dismissed)) {
    for (const name of record.dismissed) {
      if (typeof name === "string" && name.trim()) state.dismissed.push(name.trim());
    }
  }
  if (Array.isArray(record.directionNotes)) {
    for (const note of record.directionNotes) {
      if (typeof note === "string" && note.trim()) state.directionNotes.push(note.trim());
    }
  }
  if (record.availability && typeof record.availability === "object" && !Array.isArray(record.availability)) {
    for (const [rawKey, rawEntry] of Object.entries(record.availability)) {
      const key = availabilityKey(rawKey);
      if (!key || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as Record<string, unknown>;
      if (!isScore(entry.score)) continue;
      state.availability[key] = {
        score: entry.score,
        reason: typeof entry.reason === "string" && entry.reason ? entry.reason : entry.score,
        signals: isCollisionSignals(entry.signals) ? entry.signals : undefined,
        checkedAt: typeof entry.checkedAt === "string" ? entry.checkedAt : new Date().toISOString(),
      };
    }
  }
  return state;
}

/** Guard for cached collision signals: all-or-nothing, never half-trusted. */
function isCollisionSignals(value: unknown): value is CollisionSignals {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const signals = value as Record<string, unknown>;
  return (
    typeof signals.famousCollision === "boolean" &&
    typeof signals.sameSpaceCollision === "boolean" &&
    typeof signals.giantAssociation === "boolean" &&
    typeof signals.unrelatedCount === "number" &&
    Number.isFinite(signals.unrelatedCount) &&
    typeof signals.comParked === "boolean"
  );
}

function normalizeRound(entry: unknown): BrandRound | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  if (!Array.isArray(record.candidates)) return undefined;
  const candidates: Candidate[] = [];
  for (const item of record.candidates) {
    if (typeof item === "string") {
      if (item.trim()) candidates.push({ name: item.trim() });
      continue;
    }
    if (item && typeof item === "object") {
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.name === "string" && candidate.name.trim()) {
        candidates.push({
          name: candidate.name.trim(),
          flavor: typeof candidate.flavor === "string" ? candidate.flavor : undefined,
          style: typeof candidate.style === "string" ? candidate.style : undefined,
          score: isScore(candidate.score) ? candidate.score : undefined,
          scoreReason: typeof candidate.scoreReason === "string" ? candidate.scoreReason : undefined,
        });
      }
    }
  }
  return {
    id: typeof record.id === "string" ? record.id : `r-${Date.now().toString(36)}`,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    product: typeof record.product === "string" ? record.product : "",
    directionHint: typeof record.directionHint === "string" ? record.directionHint : undefined,
    candidates,
  };
}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~" || value.startsWith("~/")) return path.join(homeDirectory, value.slice(2));
  return value;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
