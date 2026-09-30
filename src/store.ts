import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAvailabilityScore, type CollisionSignals } from "./scoring.ts";
import {
  emptyBrandState,
  type AvailabilityRecord,
  type BrandRound,
  type BrandState,
  type Candidate,
} from "./types.ts";

const isScore = isAvailabilityScore;
const CONFIG_DIR_NAME = ".pi";

export interface LoadedBrandState {
  state: BrandState;
  /** File the state was loaded from, or would be written to. */
  path: string;
  isNew: boolean;
  warnings: string[];
}

/** Run data belongs to the app, not the source repository. */
export function getBrandStatePath(
  cwd: string,
  trustedProject: boolean,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const explicit = env.PI_BRAND_CONFIG?.trim();
  if (explicit) return path.resolve(cwd, expandHome(explicit, homeDirectory));
  let identity = path.resolve(cwd);
  try { identity = fs.realpathSync(identity); } catch (error) { if (!isMissingFile(error)) throw error; }
  const slug = path.basename(identity).replace(/[^a-zA-Z0-9_-]/g, "-") || "run";
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const data = env.DATA?.trim();
  const root = data
    ? path.join(path.resolve(expandHome(data, homeDirectory)), "apps", "pi-brand")
    : path.join(env.XDG_DATA_HOME || path.join(homeDirectory, ".local", "share"), "pi-brand");
  return path.join(root, "runs", `${slug}-${hash}.json`);
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
    if (!isMissingFile(error)) throw new Error(`Could not read ${statePath}: ${errorMessage(error)}`);
    const legacyPath = path.join(cwd, CONFIG_DIR_NAME, "brand.json");
    if (trustedProject && !env.PI_BRAND_CONFIG?.trim() && fs.existsSync(legacyPath)) {
      const original = fs.readFileSync(legacyPath, "utf8");
      const migrated = normalizeState(JSON.parse(original));
      if (!migrated) throw new Error(`${legacyPath}: invalid run data; migration stopped.`);
      const backupPath = `${statePath}.v1-backup`;
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(backupPath, original, { mode: 0o600, flag: "wx" }); }
      catch (backupError) {
        if ((backupError as NodeJS.ErrnoException).code !== "EEXIST" || fs.readFileSync(backupPath, "utf8") !== original) throw backupError;
      }
      saveBrandState(statePath, migrated);
      return { state: migrated, path: statePath, isNew: false, warnings: [`Imported ${legacyPath} into ${statePath}. Original retained; byte-for-byte backup: ${backupPath}.`] };
    }
    return { state: emptyBrandState(), path: statePath, isNew: true, warnings: [] };
  }

  const parsed = normalizeState(raw);
  if (!parsed) throw new Error(`${statePath}: unrecognized run data; refusing to overwrite it.`);
  return { state: parsed, path: statePath, isNew: false, warnings: [] };
}

export function saveBrandState(statePath: string, state: BrandState): void {
  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const payload: BrandState = { ...state, version: 2, updatedAt: new Date().toISOString() };
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
  if (input.directionHint?.trim() && !state.directionNotes.includes(input.directionHint.trim())) {
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
  const known = new Set(state.liked.map((entry) => availabilityKey(entry.name)));
  for (const pick of picks) {
    const name = pick.name.trim();
    if (!name || known.has(availabilityKey(name))) continue;
    known.add(availabilityKey(name));
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
  return name.normalize("NFKC").trim().toLocaleLowerCase();
}

/** Cached availability for a name, if it was ever deep-checked. */
export function getAvailability(state: BrandState, name: string): AvailabilityRecord | undefined {
  const key = availabilityKey(name);
  if (!key) return undefined;
  return Object.hasOwn(state.availability, key) ? state.availability[key] : undefined;
}

/**
 * Record an availability result forever and backfill it onto every matching
 * liked entry and round candidate, so the score shows up everywhere the name
 * appears without any re-check.
 */
export function recordAvailability(
  state: BrandState,
  name: string,
  input: Omit<AvailabilityRecord, "checkedAt">,
): AvailabilityRecord {
  const trimmed = name.trim();
  const record: AvailabilityRecord = {
    ...input,
    checkedAt: new Date().toISOString(),
  };
  Object.defineProperty(state.availability, availabilityKey(trimmed), { value: record, enumerable: true, writable: true, configurable: true });
  const matches = (other: string): boolean => availabilityKey(other) === availabilityKey(trimmed);
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

export function setDirection(state: BrandState, note: string): void {
  const direction = note.trim().slice(0, 1000);
  if (!direction) throw new Error("Provide a naming direction.");
  if (state.brief.direction !== direction) state.reserve = [];
  state.brief.direction = direction;
  if (!state.directionNotes.includes(direction)) state.directionNotes.push(direction);
}

export function setFinalists(state: BrandState, names: string[]): void {
  const liked = new Map(state.liked.map((entry) => [availabilityKey(entry.name), entry.name]));
  const requested = [...new Set(names.map(availabilityKey))];
  if (requested.length > 3) throw new Error("Choose at most three finalists.");
  if (requested.some((name) => !liked.has(name))) throw new Error("Finalists must come from your favorites.");
  state.finalists = requested.map((name) => liked.get(name)!);
}

export function getAvailabilityBatch(state: BrandState, names: string[]): { cached: Record<string, AvailabilityRecord>; fresh: string[] } {
  const cached: Record<string, AvailabilityRecord> = {};
  const fresh: string[] = [];
  for (const name of [...new Set(names.map(availabilityKey))]) {
    const hit = getAvailability(state, name);
    if (hit) Object.defineProperty(cached, name, { value: hit, enumerable: true });
    else fresh.push(name);
  }
  return { cached, fresh };
}

/** Names seen in any round, lowercased, so new rounds avoid repeats. */
export function seenNames(state: BrandState): Set<string> {
  const seen = new Set<string>();
  for (const round of state.rounds) {
    for (const candidate of round.candidates) seen.add(availabilityKey(candidate.name));
  }
  for (const entry of state.liked) seen.add(availabilityKey(entry.name));
  for (const name of state.dismissed) seen.add(availabilityKey(name));
  return seen;
}

/**
 * Add names to the permanent do-not-suggest-again list, deduped
 * case-insensitively. Returns how many were new, so callers can report it.
 */
export function dismissNames(state: BrandState, names: Iterable<string>): string[] {
  const known = new Set(state.dismissed.map(availabilityKey));
  const added: string[] = [];
  const removed = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    removed.add(availabilityKey(name));
    if (known.has(availabilityKey(name))) continue;
    known.add(availabilityKey(name));
    state.dismissed.push(name);
    added.push(name);
  }
  state.liked = state.liked.filter((entry) => !removed.has(availabilityKey(entry.name)));
  state.finalists = state.finalists.filter((name) => !removed.has(availabilityKey(name)));
  return added;
}

/**
 * Every name this project has ever shown, kept, or rejected. This is the
 * authoritative duplicate filter: it is checked in code, never from a
 * truncated prompt list, so it holds at hundreds of names.
 */
export function excludedNames(state: BrandState): { seen: Set<string>; kept: Set<string> } {
  const kept = new Set(state.liked.map((entry) => availabilityKey(entry.name)));
  const seen = seenNames(state);
  for (const name of state.dismissed) seen.add(availabilityKey(name));
  return { seen, kept };
}

function normalizeState(raw: unknown): BrandState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) return undefined;
  if (!Array.isArray(record.rounds) || !Array.isArray(record.liked)) return undefined;
  const state = emptyBrandState(typeof record.product === "string" ? record.product : "");
  if (typeof record.updatedAt === "string") state.updatedAt = record.updatedAt;
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
      Object.defineProperty(state.availability, key, { enumerable: true, writable: true, configurable: true, value: {
        score: entry.score,
        reason: typeof entry.reason === "string" && entry.reason ? entry.reason : entry.score,
        signals: normalizeSignals(entry.signals),
        checkedAt: typeof entry.checkedAt === "string" ? entry.checkedAt : new Date().toISOString(),
        stage: entry.stage === "screen" || entry.stage === "deep" ? entry.stage : "legacy",
        evidence: normalizeEvidence(entry.evidence),
        warnings: Array.isArray(entry.warnings) ? entry.warnings.filter((warning): warning is string => typeof warning === "string").slice(0, 20) : undefined,
        requirementsKey: typeof entry.requirementsKey === "string" ? entry.requirementsKey : undefined,
      } });
    }
  }
  state.directionNotes = [...new Set(state.directionNotes)];
  state.brief.direction = state.directionNotes.at(-1)?.slice(0, 1000) ?? "";
  const brief = record.brief;
  if (brief && typeof brief === "object" && !Array.isArray(brief)) {
    const prefs = brief as Record<string, unknown>;
    if (typeof prefs.direction === "string") state.brief.direction = prefs.direction.slice(0, 1000);
    if (typeof prefs.singleWord === "boolean") state.brief.singleWord = prefs.singleWord;
    if (typeof prefs.maxLength === "number" && Number.isInteger(prefs.maxLength) && prefs.maxLength >= 3 && prefs.maxLength <= 30) state.brief.maxLength = prefs.maxLength;
    if (Array.isArray(prefs.domains)) state.brief.domains = prefs.domains.filter((suffix): suffix is string => typeof suffix === "string" && /^[a-z]{2,12}$/.test(suffix)).slice(0, 3);
    if (typeof prefs.checkPackages === "boolean") state.brief.checkPackages = prefs.checkPackages;
  }
  if (typeof record.model === "string" && /^[^/]+\/.+$/.test(record.model)) state.model = record.model;
  if (typeof record.workerModel === "string" && /^[^/]+\/.+$/.test(record.workerModel)) state.workerModel = record.workerModel;
  if (Array.isArray(record.reserve)) state.reserve = normalizeRound({ candidates: record.reserve })?.candidates ?? [];
  if (Array.isArray(record.finalists)) {
    const liked = new Map(state.liked.map((entry) => [availabilityKey(entry.name), entry.name]));
    state.finalists = [...new Set(record.finalists.filter((name): name is string => typeof name === "string").map((name) => liked.get(availabilityKey(name))).filter((name): name is string => !!name))].slice(0, 3);
  }
  if (Array.isArray(record.generationMetrics)) {
    state.generationMetrics = record.generationMetrics.filter((item) => item && typeof item === "object" && typeof item.model === "string" && Number.isFinite(item.elapsedMs) && Number.isFinite(item.modelCalls) && Number.isFinite(item.generated)).slice(-50);
  }
  return state;
}

function normalizeSignals(value: unknown): Partial<CollisionSignals> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const signals: Partial<CollisionSignals> = {};
  for (const key of ["famousCollision", "sameSpaceCollision", "giantAssociation", "comParked"] as const) {
    if (typeof raw[key] === "boolean") signals[key] = raw[key];
  }
  if (typeof raw.unrelatedCount === "number" && Number.isFinite(raw.unrelatedCount)) signals.unrelatedCount = Math.max(0, Math.floor(raw.unrelatedCount));
  return signals;
}

function normalizeEvidence(value: unknown): AvailabilityRecord["evidence"] {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => item && typeof item === "object" && ["web", "domain", "npm", "github"].includes(item.source) && typeof item.url === "string" && /^https?:\/\//.test(item.url) && typeof item.detail === "string").slice(0, 20).map((item) => ({ source: item.source, url: item.url, detail: item.detail.slice(0, 2000) }));
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
