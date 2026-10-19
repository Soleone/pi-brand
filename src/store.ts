import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAvailabilityScore, type CollisionSignals } from "./scoring.ts";
import { applyBriefChanges, documentHash, formatBrief, formatFeedbackEntry, namingContent, parseBrief } from "./brief.ts";
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
  if (explicit) return externalPath(path.resolve(cwd, expandHome(explicit, homeDirectory)), cwd);
  let identity = path.resolve(cwd);
  try { identity = fs.realpathSync(identity); } catch (error) { if (!isMissingFile(error)) throw error; }
  const slug = path.basename(identity).replace(/[^a-zA-Z0-9_-]/g, "-") || "run";
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const data = env.DATA?.trim();
  const root = data
    ? path.join(path.resolve(expandHome(data, homeDirectory)), "apps", "pi-brand")
    : path.join(env.XDG_DATA_HOME || path.join(homeDirectory, ".local", "share"), "pi-brand");
  return externalPath(path.join(root, "runs", `${slug}-${hash}.json`), cwd);
}

function canonicalPath(target: string): string {
  try { return fs.realpathSync(target); }
  catch (error) {
    if (!isMissingFile(error)) throw error;
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return canonicalPath(path.resolve(path.dirname(target), fs.readlinkSync(target)));
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(canonicalPath(parent), path.basename(target));
  }
}

function externalPath(target: string, cwd: string): string {
  let project = canonicalPath(path.resolve(cwd));
  for (let directory = project; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, ".git"))) { project = directory; break; }
    if (path.dirname(directory) === directory) break;
  }
  const relative = path.relative(project, canonicalPath(target));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("pi-brand data must be outside the project. Set DATA to an external data directory, or use an external PI_BRAND_CONFIG path.");
  }
  return target;
}

export function brandDocumentPaths(statePath: string) {
  const base = statePath.replace(/\.json$/, "");
  return { brief: `${base}.brief.md`, feedback: `${base}.feedback.md` };
}

export function loadBrandState(
  cwd: string,
  trustedProject: boolean,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): LoadedBrandState {
  const statePath = getBrandStatePath(cwd, trustedProject, env, homeDirectory);
  const documents = brandDocumentPaths(statePath);
  externalPath(documents.brief, cwd);
  externalPath(documents.feedback, cwd);
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
  const warnings: string[] = [];
  if ((raw as { version: number }).version < 3) {
    const backup = `${statePath}.v2-backup`;
    try { fs.copyFileSync(statePath, backup, fs.constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (parsed.reserve.length) warnings.push("Old reserved names were cleared because their generation inputs were not recorded.");
    parsed.reserve = [];
    saveBrandState(statePath, parsed);
    warnings.push(`Naming brief and feedback history are now editable outside the project: ${documents.brief}`);
  }
  if ((raw as { version: number }).version === 3) {
    const backup = `${statePath}.v3-backup`;
    try { fs.copyFileSync(statePath, backup, fs.constants.COPYFILE_EXCL); fs.chmodSync(backup, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    // Old reserves predate favorite-led generation and must not masquerade as fresh inputs.
    parsed.reserve = [];
    parsed.reservePoolId = undefined;
    warnings.push("Active names now include the last viewed round and favorites. Older rounds remain in History; an external v3 backup was retained.");
  }
  const markdown = fs.readFileSync(documents.brief, "utf8");
  let content;
  try { content = parseBrief(markdown); }
  catch (error) { throw new Error(`Fix the naming document at ${documents.brief}: ${errorMessage(error)}`); }
  if (JSON.stringify(content) !== JSON.stringify(namingContent(parsed))) {
    applyBriefChanges(parsed, content, { text: markdown, source: "file", author: "unknown" });
  }
  parsed.briefDocumentHash = documentHash(markdown);
  if ((raw as { version: number }).version === 3) saveBrandState(statePath, parsed);
  return { state: parsed, path: statePath, isNew: false, warnings };
}

export function saveBrandState(statePath: string, state: BrandState): void {
  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const documents = brandDocumentPaths(statePath);
  let existing: string | undefined;
  try { existing = fs.readFileSync(documents.brief, "utf8"); }
  catch (error) { if (!isMissingFile(error)) throw error; }
  if (existing !== undefined && documentHash(existing) !== state.briefDocumentHash) throw new Error(`The naming brief changed on disk. Reload it before saving: ${documents.brief}`);
  existing = existing?.replace("Feedback history is reference only. Favorites are not implicit instructions; add taste examples here.", "Feedback history is reference only. Favorites are additional positive taste examples; the brief takes priority.");
  const markdown = existing !== undefined && JSON.stringify(parseBrief(existing)) === JSON.stringify(namingContent(state)) ? existing : formatBrief(namingContent(state));
  state.briefDocumentHash = documentHash(markdown);
  atomicWrite(documents.brief, markdown);
  let history = "# Feedback history\n\nOriginal comments and interpretations are retained separately from the active brief.\nYou may annotate or correct this document. Change the naming brief to affect generation.\n\n";
  try { history = fs.readFileSync(documents.feedback, "utf8"); }
  catch (error) { if (!isMissingFile(error)) throw error; }
  for (const entry of state.feedback) {
    if (!history.includes(`<!-- feedback:${entry.id} -->`)) history += `\n${formatFeedbackEntry(entry)}`;
  }
  atomicWrite(documents.feedback, history);
  const payload: BrandState = { ...state, version: 4, updatedAt: new Date().toISOString() };
  atomicWrite(statePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function saveFeedbackDocument(statePath: string, markdown: string, expected: string): void {
  const target = brandDocumentPaths(statePath).feedback;
  if (fs.readFileSync(target, "utf8") !== expected) throw new Error("Feedback history changed on disk. Reopen it before saving.");
  atomicWrite(target, markdown);
}

function atomicWrite(target: string, content: string): void {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

export function recordRound(
  state: BrandState,
  input: { product: string; candidates: Candidate[]; directionHint?: string; poolId?: string; origin?: BrandRound["origin"]; briefRevision?: number },
): BrandRound {
  const round: BrandRound = {
    id: `r${state.rounds.length + 1}-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    product: input.product.trim(),
    directionHint: input.directionHint?.trim() || undefined,
    candidates: input.candidates,
    poolId: input.poolId, origin: input.origin ?? "legacy", briefRevision: input.briefRevision,
  };
  state.rounds.push(round);
  selectNames(state, input.candidates.map(entry => entry.name));
  if (input.directionHint?.trim() && !state.directionNotes.includes(input.directionHint.trim())) {
    state.directionNotes.push(input.directionHint.trim());
  }
  if (input.product.trim()) state.product = input.product.trim();
  return round;
}

export function activeNames(state: BrandState): Candidate[] {
  const known = new Map([...state.rounds.flatMap(round => round.candidates), ...state.liked].map(entry => [availabilityKey(entry.name), entry]));
  return state.selected.map(name => known.get(availabilityKey(name)) ?? { name });
}

export function selectNames(state: BrandState, names: Iterable<string>): void {
  const requested = [...names].map(name => name.trim()).filter(Boolean);
  const restored = new Set(requested.map(availabilityKey));
  state.dismissed = state.dismissed.filter(name => !restored.has(availabilityKey(name)));
  state.selected = [...new Map([...state.selected, ...requested].map(name => [availabilityKey(name), name])).values()];
}

export function removeLikes(state: BrandState, names: Iterable<string>): void {
  const removed = new Set([...names].map(availabilityKey));
  if (!state.liked.some(entry => removed.has(availabilityKey(entry.name)))) return;
  state.liked = state.liked.filter(entry => !removed.has(availabilityKey(entry.name)));
  state.finalists = state.finalists.filter(name => !removed.has(availabilityKey(name)));
  state.reserve = [];
  state.reservePoolId = undefined;
}

/** Add favorites, restoring their active membership if necessary. */
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
  selectNames(state, picks.map(entry => entry.name));
  if (added.length) { state.reserve = []; state.reservePoolId = undefined; }
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
 * Record an availability result and backfill it onto every matching liked
 * entry and round candidate, so the score shows up everywhere the name appears.
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
  const direction = note.trim();
  if (!direction) throw new Error("Provide a naming direction.");
  applyBriefChanges(state, { direction }, { text: note, source: "command", author: "user" });
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
  for (const name of state.selected) seen.add(availabilityKey(name));
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
  removeLikes(state, removed);
  state.selected = state.selected.filter(name => !removed.has(availabilityKey(name)));
  state.reserve = state.reserve.filter(entry => !removed.has(availabilityKey(entry.name)));
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
  if (record.version !== 1 && record.version !== 2 && record.version !== 3 && record.version !== 4) return undefined;
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
        researchVersion: Number.isInteger(entry.researchVersion) ? entry.researchVersion as number : undefined,
        evidence: normalizeEvidence(entry.evidence),
        warnings: Array.isArray(entry.warnings) ? entry.warnings.filter((warning): warning is string => typeof warning === "string").slice(0, 20) : undefined,
        requirementsKey: typeof entry.requirementsKey === "string" ? entry.requirementsKey : undefined,
        model: typeof entry.model === "string" ? entry.model : undefined,
      } });
    }
  }
  state.directionNotes = [...new Set(state.directionNotes)];
  state.brief.direction = state.directionNotes.at(-1) ?? "";
  const brief = record.brief;
  if (brief && typeof brief === "object" && !Array.isArray(brief)) {
    const prefs = brief as Record<string, unknown>;
    if (typeof prefs.direction === "string") state.brief.direction = prefs.direction;
    if (typeof prefs.avoid === "string") state.brief.avoid = prefs.avoid;
    if (typeof prefs.style === "string") state.brief.style = prefs.style;
    if (Array.isArray(prefs.examples)) state.brief.examples = prefs.examples.filter((name): name is string => typeof name === "string");
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
  if (record.version === 3 || record.version === 4) {
    if (!Number.isInteger(record.briefRevision) || (record.briefRevision as number) < 1 || !Array.isArray(record.feedback) || !Array.isArray(record.pools)) throw new Error("Invalid naming context in saved run; refusing to replace it.");
    state.briefRevision = record.briefRevision as number;
    state.feedback = record.feedback as BrandState["feedback"];
    state.pools = record.pools as BrandState["pools"];
    state.briefDocumentHash = typeof record.briefDocumentHash === "string" ? record.briefDocumentHash : undefined;
    state.reservePoolId = typeof record.reservePoolId === "string" ? record.reservePoolId : undefined;
    state.lastBatch = record.lastBatch as BrandState["lastBatch"];
  } else {
    state.feedback = state.directionNotes.map((text, index) => ({ id: `legacy-${index}`, createdAt: new Date().toISOString(), author: "unknown", source: "legacy", text, briefRevision: 1, changes: [] }));
  }
  if (record.version === 4 && (!Array.isArray(record.selected) || record.selected.some(name => typeof name !== "string"))) throw new Error("Invalid active-name list; refusing to replace it.");
  const discarded = new Set(state.dismissed.map(availabilityKey));
  const candidates = new Map([...state.rounds.flatMap(round => round.candidates), ...state.liked].map(entry => [availabilityKey(entry.name), entry.name]));
  const selected = record.version === 4 ? record.selected as string[] : [...(state.rounds.at(-1)?.candidates.map(entry => entry.name) ?? []), ...state.liked.map(entry => entry.name)];
  state.selected = [...new Map([...selected, ...state.liked.map(entry => entry.name)].map(name => candidates.get(availabilityKey(name)) ?? name.trim()).filter(name => !!name && !discarded.has(availabilityKey(name))).map(name => [availabilityKey(name), name])).values()];
  state.liked = state.liked.filter(entry => !discarded.has(availabilityKey(entry.name)));
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
    poolId: typeof record.poolId === "string" ? record.poolId : undefined,
    origin: record.origin === "generated" || record.origin === "reserve" || record.origin === "external" ? record.origin : "legacy",
    briefRevision: typeof record.briefRevision === "number" ? record.briefRevision : undefined,
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
