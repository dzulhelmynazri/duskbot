// Connecting a model provider on the machine the bots run on: the catalog groups the picker searches, a live model list
// from the provider once a key is given, the local servers this machine runs, and the instance a connection becomes.
// Security: a key is used only for the provider's own address, is never logged or echoed, and madani cloud never calls an
// address on its own network (a custom endpoint there could otherwise reach the cloud's internals).
import { randomUUID } from "node:crypto";

import {
  MODEL_PROVIDERS, modelProvider, providerBaseUrl, requiredFields,
  type ModelProviderDef, type Place, type ProviderFieldId,
} from "../shared/model-providers.ts";
import type { SearchGroup, SearchModel } from "../shared/model-search.ts";
import { addressHere } from "./cloud-connections.ts";
import type { InstanceConfig } from "./contracts.ts";
import type { ModelCatalog } from "./model-catalog/catalog.ts";
import type { CatalogModel } from "./model-catalog/trim.ts";
import { ADDED_ENDPOINT_PREFIX, CLOUD_CANT_REACH } from "./openai-compat-endpoints.ts";

export const CATALOG_PROVIDER_PREFIX = "catalog:";
export const ANTHROPIC_CONNECTION_PREFIX = "claude-api-";
const LIST_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 700;
const MAX_LISTED = 2_000;

export function searchModelOf(model: CatalogModel): SearchModel {
  const out: SearchModel = {
    id: model.id, name: model.name, tools: model.tool_call === true, reasoning: model.reasoning,
    vision: model.attachment || model.modalities.input.includes("image"),
  };
  if (model.limit?.context) out.context = model.limit.context;
  if (model.cost?.input !== undefined) out.input = model.cost.input;
  if (model.cost?.output !== undefined) out.output = model.cost.output;
  if (model.release_date) out.released = model.release_date;
  return out;
}

/** A provider by id: one of ours, or `catalog:<id>` for any models.dev provider with an OpenAI-compatible address. */
export function resolveProvider(id: string, catalog: ModelCatalog): ModelProviderDef | undefined {
  const own = modelProvider(id);
  if (own) return own;
  if (!id.startsWith(CATALOG_PROVIDER_PREFIX)) return undefined;
  const entry = catalog.providers[id.slice(CATALOG_PROVIDER_PREFIX.length)];
  if (!entry?.api || addressHere(entry.api)) return undefined;
  return { id, label: entry.name, section: "more", wire: "openai", baseUrl: entry.api, catalogId: entry.id, listModels: "openai", words: [entry.id],
    ...(entry.doc ? { keyUrl: entry.doc } : {}) };
}

/** Every catalog provider worth offering besides ours: one with an address of its own that we do not already cover. */
export function moreProviders(catalog: ModelCatalog): ModelProviderDef[] {
  const covered = new Set(MODEL_PROVIDERS.map((def) => def.catalogId).filter(Boolean));
  return Object.values(catalog.providers)
    .filter((entry) => entry.api && !covered.has(entry.id) && Object.keys(entry.models).length > 0)
    .map((entry) => resolveProvider(`${CATALOG_PROVIDER_PREFIX}${entry.id}`, catalog))
    .filter((def): def is ModelProviderDef => def !== undefined)
    .sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
}

/** The catalog as search groups: our providers first, then the rest of models.dev. */
export function catalogGroups(catalog: ModelCatalog, connected: ReadonlySet<string> = new Set()): SearchGroup[] {
  const groups: SearchGroup[] = [];
  for (const def of [...MODEL_PROVIDERS, ...moreProviders(catalog)]) {
    const entry = def.catalogId ? catalog.providers[def.catalogId] : undefined;
    if (!entry) continue;
    groups.push({ providerId: def.id, label: def.label, connected: connected.has(def.id), words: def.words, featured: def.section !== "more",
      models: Object.values(entry.models).map(searchModelOf) });
  }
  return groups;
}

/** Catalog facts by model id, for models a connected engine lists: the provider's own entry wins, then any other. */
export class CatalogIndex {
  private readonly byId = new Map<string, SearchModel>();
  private readonly byProvider = new Map<string, Map<string, SearchModel>>();

  constructor(catalog: ModelCatalog) {
    for (const entry of Object.values(catalog.providers)) {
      const own = new Map<string, SearchModel>();
      for (const model of Object.values(entry.models)) {
        const facts = searchModelOf(model);
        own.set(model.id.toLowerCase(), facts);
        const bare = model.id.toLowerCase().split("/").at(-1)!;
        if (!this.byId.has(bare)) this.byId.set(bare, facts);
      }
      this.byProvider.set(entry.id, own);
    }
  }

  find(modelId: string, catalogId?: string): SearchModel | undefined {
    const id = modelId.toLowerCase().replace(/^models\//u, "");
    const own = catalogId ? this.byProvider.get(catalogId) : undefined;
    return own?.get(id) ?? this.byId.get(id.split("/").at(-1)!) ?? this.byId.get(id.split("::").at(-1)!);
  }
}

export interface ListInput {
  def: ModelProviderDef;
  baseUrl: string;
  key?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type ListResult = { ok: true; models: string[] } | { ok: false; reason: "rejected" | "unreachable" | "unexpected"; status?: number };

/** The provider's own model list: OpenAI's GET /models, or Anthropic's GET /v1/models. */
export async function listProviderModels(input: ListInput): Promise<ListResult> {
  if (input.def.listModels === "none") return { ok: true, models: [] };
  const anthropic = input.def.listModels === "anthropic";
  const base = input.baseUrl.replace(/\/+$/u, "");
  const url = anthropic ? `${base.replace(/\/v1$/u, "")}/v1/models?limit=1000` : `${base}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.key) {
    headers.authorization = `Bearer ${input.key}`;
    if (anthropic) headers["x-api-key"] = input.key;
  }
  if (anthropic) headers["anthropic-version"] = "2023-06-01";
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, { headers, redirect: "error", signal: AbortSignal.timeout(input.timeoutMs ?? LIST_TIMEOUT_MS) });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "rejected", status: response.status };
  if (!response.ok) return { ok: false, reason: "unexpected", status: response.status };
  let body: unknown;
  try { body = await response.json(); } catch { return { ok: false, reason: "unexpected", status: response.status }; }
  const rows = Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data
    : Array.isArray((body as { models?: unknown })?.models) ? (body as { models: unknown[] }).models : [];
  const ids = rows.map((row) => (row as { id?: unknown; name?: unknown })?.id ?? (row as { name?: unknown })?.name)
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256)
    .map((id) => id.replace(/^models\//u, ""));
  return { ok: true, models: [...new Set(ids)].slice(0, MAX_LISTED) };
}

/** Why an address can't be used where the bots run, or null. https anywhere; http only on this machine or its network;
 * never a link-local address (cloud metadata services live there), and on madani cloud nothing on its own network. */
export function addressProblem(raw: string, place: Place): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return "Enter a full address that starts with https:// or http://."; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Enter a full address that starts with https:// or http://.";
  if (url.username || url.password || url.search || url.hash) return "Leave the user name, password and anything after ? or # out of the address.";
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host.startsWith("169.254.") || /^fe[89ab][0-9a-f]:/u.test(host) || host === "metadata.google.internal") return "That address can't be used.";
  const here = addressHere(url.href);
  if (place === "cloud" && here) return CLOUD_CANT_REACH;
  if (url.protocol === "http:" && !here) return "Use https:// for an address on the internet.";
  return null;
}

/** The local servers this machine runs (a 2xx or a key refusal from GET /models both mean something is there). */
export async function probeLocalProviders(place: Place, fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  if (place === "cloud") return new Set();
  const found = await Promise.all(MODEL_PROVIDERS.filter((def) => def.local).map(async (def) => {
    try {
      const response = await fetchImpl(`${def.baseUrl}/models`, { redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      void response.body?.cancel().catch(() => {});
      return response.ok || response.status === 401 || response.status === 403 ? def.id : null;
    } catch {
      return null;
    }
  }));
  return new Set(found.filter((id): id is string => id !== null));
}

export interface ConnectInput {
  key?: string;
  fields?: Partial<Record<ProviderFieldId, string>>;
  /** The models to offer; empty offers whatever the provider lists. */
  models?: string[];
  displayName?: string;
}

/** What a placeholder key says to a local server that takes none. */
const NO_KEY = "local";

/** The instance a connection becomes, saved on the server that handles the request. */
export function buildConnection(def: ModelProviderDef, input: ConnectInput, place: Place): { instanceId: string; entry: InstanceConfig } | { error: string } {
  const missing = requiredFields(def).find((field) => !input.fields?.[field.id]?.trim());
  if (missing) return { error: `Enter the ${missing.label.charAt(0).toLowerCase()}${missing.label.slice(1)}.` };
  const baseUrl = providerBaseUrl(def, input.fields);
  if (!baseUrl) return { error: "Check the details: they can hold only letters, digits, dots and dashes." };
  const problem = addressProblem(baseUrl, place);
  if (problem) return { error: problem };
  if (def.local && place === "cloud") return { error: `${def.label} runs on your own computer, which madani cloud can't reach.` };
  const key = input.key?.trim() ?? "";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/u.test(key)) return { error: "Paste the key without spaces or line breaks." };
  if (/^https?:\/\//iu.test(key)) return { error: "That looks like an address. Paste the key itself." };
  if (!key && !def.keyless) return { error: `Paste your ${def.label} key.` };
  const named = input.fields?.model?.trim();
  const models = [...new Set([...(input.models ?? []), ...(named ? [named] : [])].map((model) => model.trim()).filter(Boolean))].slice(0, 64);
  const displayName = (input.displayName?.trim() || def.label).slice(0, 80);
  if (def.wire === "anthropic") {
    const official = def.id === "anthropic";
    return {
      instanceId: `${ANTHROPIC_CONNECTION_PREFIX}${randomUUID()}`,
      entry: {
        driver: "claudeAgent", displayName, access: "api",
        config: { requireApiKey: true, ...(models.length ? { managedModels: models } : {}) },
        environment: {
          ANTHROPIC_API_KEY: key,
          ...(official ? {} : { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_BASE_URL: baseUrl }),
          ...(models[0] ? { ANTHROPIC_MODEL: models[0] } : {}),
        },
      },
    };
  }
  return {
    instanceId: `${ADDED_ENDPOINT_PREFIX}${randomUUID()}`,
    entry: {
      driver: "openai-compat", displayName, access: def.local || def.section === "custom" ? "custom" : "api",
      config: {
        key: key || NO_KEY, url: baseUrl,
        ...(models.length ? { managedModels: models } : {}),
        ...(def.id === "openai" ? { catalog: "openai" } : def.id === "lmstudio" ? { catalog: "lmstudio" } : {}),
      },
    },
  };
}
