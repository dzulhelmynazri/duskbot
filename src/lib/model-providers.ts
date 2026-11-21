// The renderer's side of /api/model-providers: what the server the window is connected to can connect, a search over
// every model, and connecting a provider there. A key is always sealed for that server before it leaves the app.
import { useEffect, useState } from "react";

import type { ModelProviderDef, Place, ProviderFieldId } from "../../shared/model-providers";
import type { SearchHit } from "../../shared/model-search";
import { api } from "@/state/api";
import { sendSealed } from "@/lib/sealed-send";
import { t } from "@/lib/i18n";

export type ProviderInfo = Omit<ModelProviderDef, "hosts" | "instances" | "driverKinds" | "words"> & {
  offered: boolean;
  reason?: "cloud" | "not-running";
  modelCount: number;
  connected: string[];
};

export interface ProvidersAnswer {
  place: Place;
  catalog: { origin: string; updatedAt: string; providers: number; models: number };
  providers: ProviderInfo[];
  more: Array<{ id: string; label: string; modelCount: number }>;
}

export type ProviderFields = Partial<Record<ProviderFieldId, string>>;

export const fetchProviders = () => api<ProvidersAnswer>("/api/model-providers");

// the last answer, shown at once the next time the directory opens while a fresh one loads behind it
let lastProviders: ProvidersAnswer | null = null;
let loadingProviders: Promise<ProvidersAnswer> | null = null;

export const cachedProviders = () => lastProviders;

/** One request at a time, kept for the next open. */
export function loadProviders(): Promise<ProvidersAnswer> {
  loadingProviders ??= fetchProviders().then((answer) => { lastProviders = answer; return answer; }).finally(() => { loadingProviders = null; });
  return loadingProviders;
}

/** Starts loading the directory before it is opened, so "More providers" has its list ready. */
export function prefetchProviders(): void {
  if (!lastProviders) loadProviders().catch(() => undefined);
}

export const searchEverywhere = (query: string, signal?: AbortSignal) =>
  api<{ hits: SearchHit[] }>(`/api/model-providers/search?q=${encodeURIComponent(query)}`, { signal });

const sealedPost = <T>(path: string, provider: string, key: string, body: Record<string, unknown>) =>
  sendSealed("model-provider", [provider], { key: key.trim() }, (sealed) =>
    api<T>(path, { method: "POST", body: JSON.stringify({ provider, ...body, ...(sealed ? { sealed } : {}) }) }));

export type ListAnswer = { ok: true; models: string[]; source: "provider" | "catalog" } | { ok: false; reason: "rejected" | "unreachable" | "unexpected"; status?: number };

export function listModels(provider: string, fields: ProviderFields, key: string): Promise<ListAnswer> {
  return sealedPost<ListAnswer>("/api/model-providers/models", provider, key, { fields: cleanFields(fields) });
}

export function connectProvider(provider: string, fields: ProviderFields, key: string, models: string[]): Promise<{ instanceId: string; instances: unknown }> {
  return sealedPost("/api/model-providers/connect", provider, key, { fields: cleanFields(fields), ...(models.length ? { models } : {}) });
}

function cleanFields(fields: ProviderFields): ProviderFields {
  return Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, value?.trim() ?? ""]).filter(([, value]) => value));
}

/** "Saved on this computer", "Saved on your madani cloud", "Saved on this server". */
export function placeLine(place: Place): string {
  return t(place === "cloud" ? "models.place.cloud" : place === "server" ? "models.place.server" : "models.place.computer");
}

export function listVerdict(answer: ListAnswer): { ok: boolean; text: string } {
  if (answer.ok) return { ok: true, text: answer.models.length ? t("models.check.found", { count: answer.models.length }) : t("models.check.none") };
  return { ok: false, text: t(answer.reason === "rejected" ? "models.check.rejected" : answer.reason === "unreachable" ? "models.check.unreachable" : "models.check.unexpected") };
}

/** The search's hits for `query`, after a short pause in typing; null while a search is on its way. */
export function useModelSearch(query: string, enabled = true): SearchHit[] | null {
  const [hits, setHits] = useState<SearchHit[] | null>([]);
  const trimmed = query.trim();
  useEffect(() => {
    if (!enabled || !trimmed) { setHits([]); return; }
    setHits(null);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchEverywhere(trimmed, controller.signal).then((answer) => setHits(answer.hits), () => { if (!controller.signal.aborted) setHits([]); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [trimmed, enabled]);
  return hits;
}
