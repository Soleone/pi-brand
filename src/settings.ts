import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Effective pi settings as returned by the registration API. */
export type BrandPiSettings = ReturnType<ExtensionAPI["getSettings"]>;

/**
 * Pi owns the effective settings, and extensions receive them through the
 * registration API, not the per-call context. Keep one provider so brand
 * requests can follow pi's configured reasoning defaults without threading
 * settings through every call site.
 */
let provider: () => BrandPiSettings = () => ({});

export function setSettingsProvider(read: () => BrandPiSettings): void {
  provider = read;
}

export function brandPiSettings(): BrandPiSettings {
  return provider();
}
