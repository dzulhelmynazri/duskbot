// Jev, the small model that picks who answers in a group chat: set up right where "Let Madani choose" is picked.
// Security: keys are write-only; the server reports configured-or-not and the model, never a key.
import { useEffect, useState } from "react";
import { ArrowUpRight } from "../../icons";

import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { jevRoomRoutingOn } from "@/lib/group-routing";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { AdminOnly } from "../AdminOnly";
import { buttonCls, Card, fieldCls, ItemRow, LinkRow, NoteRow, rowCls, Segmented } from "../bot-panel/rows";
import { SettingsSelect } from "../SettingsSelect";
import { friendlyError } from "@/lib/plain-error";

export type JevProvider = "gateway" | "openrouter" | "jev";
type Api = "chat" | "decisions";
type ModelList = { source: string; models: Array<{ id: string; name: string; group: "recommended" | "more"; api?: Api }> };
type TestResult = { ok: true; latencyMs: number } | { ok: false; reason: string; status?: number };

export const PROVIDERS: ReadonlyArray<{ id: JevProvider; label: LocaleKey; keyUrl: string }> = [
  { id: "gateway", label: "room.jev.provider.gateway", keyUrl: "https://vercel.com/ai-gateway" },
  { id: "openrouter", label: "room.jev.provider.openrouter", keyUrl: "https://openrouter.ai/keys" },
  { id: "jev", label: "room.jev.provider.jev", keyUrl: "https://typesafe.ai" },
];

/** Where each provider's key lives: the config field (web) and the desktop credential name. */
const KEY_SLOT: Record<JevProvider, { field: string; credential: "gatewayDeciderKey" | "openrouterDeciderKey" | "jevApiKey" }> = {
  gateway: { field: "gatewayKey", credential: "gatewayDeciderKey" },
  openrouter: { field: "openrouterKey", credential: "openrouterDeciderKey" },
  jev: { field: "key", credential: "jevApiKey" },
};

const CUSTOM = "__custom";
const primaryCls = cn(buttonCls, "bg-ink text-app shadow-none enabled:hover:bg-[color-mix(in_srgb,var(--color-ink)_88.5%,var(--color-menu))] disabled:bg-ink/15 disabled:text-ink/30");
const MODEL_ID = /^[A-Za-z0-9][\w.-]*\/[\w.:-]+$/;

const FAILURES: Record<string, LocaleKey> = {
  rejected: "room.jev.error.rejected",
  unreachable: "decider.error.unreachable",
  timeout: "decider.error.timeout",
  rate_limited: "decider.error.rateLimited",
  overloaded: "decider.error.overloaded",
  malformed: "decider.error.malformed",
  no_key: "decider.error.noKey",
  misconfigured: "decider.error.misconfigured",
};

/** A fixed sentence per failure: the vendor's own body never reaches the UI. */
export function jevFailureText(result: { reason: string; status?: number }): string {
  if (result.reason === "http_error" && result.status === 402) return t("room.jev.error.credits");
  if (result.reason === "http_error") return t("decider.error.http", { status: String(result.status ?? "?") });
  const key = FAILURES[result.reason];
  return key ? t(key) : t("decider.error.other");
}

function providerName(provider: string): string {
  if (provider === "gateway") return t("room.jev.provider.gateway");
  if (provider === "openrouter") return t("room.jev.provider.openrouter");
  if (provider === "workersai") return "Cloudflare";
  return "typesafe.ai";
}

/** What "Jev: <model> via <provider>" says once it is set up. */
export function jevSummary(decider: NonNullable<ConfigStatus["decider"]>, names: Record<string, string> = {}): string {
  if (decider.included) return t("room.jev.included");
  if (decider.provider === "jev") return t("room.jev.usingTypesafe");
  const model = decider.provider === "workersai" ? "Clef" : decider.model ? names[decider.model] ?? decider.model : "Jev";
  return t("room.jev.using", { model, provider: providerName(decider.provider) });
}

function useModels(provider: JevProvider): ModelList | null {
  const [lists, setLists] = useState<Partial<Record<JevProvider, ModelList>>>({});
  useEffect(() => {
    if (provider === "jev" || lists[provider]) return;
    let cancelled = false;
    api<ModelList>(provider === "gateway" ? "/api/decider/models?provider=gateway" : "/api/decider/models").then(
      (list) => { if (!cancelled) setLists((now) => ({ ...now, [provider]: list })); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [provider, lists]);
  return provider === "jev" ? null : lists[provider] ?? null;
}

/** The room's Jev card: a quiet "Jev: <model> via <provider>" row once set up, else a provider, a key, Test, a model. */
export function JevSetup() {
  const { state } = useStore();
  const decider = state.config?.decider;
  const ready = jevRoomRoutingOn(state.config);
  const [editing, setEditing] = useState(false);
  if (!state.config) return null;
  const configured = decider?.configured === true;
  return (
    <Card label={t("room.jev.title")} data-sheet-group="jev">
      <AdminOnly>
        {configured && !editing ? <JevReady ready={ready} onChange={() => setEditing(true)} /> : <JevForm onDone={configured ? () => setEditing(false) : undefined} />}
      </AdminOnly>
    </Card>
  );
}

function JevReady({ ready, onChange }: { ready: boolean; onChange: () => void }) {
  const { state, dispatch } = useStore();
  const decider = state.config!.decider!;
  const provider: JevProvider = decider.provider === "gateway" || decider.provider === "openrouter" ? decider.provider : "jev";
  const models = useModels(provider);
  const names = Object.fromEntries((models?.models ?? []).map((model) => [model.id, model.name]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      dispatch({ type: "configStatus", config: await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: { enabled: true, jobs: { roomRouting: true } } }) }) });
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ItemRow data-sheet-row="jev-ready" title={<span role="status">{jevSummary(decider, names)}</span>} hint={ready ? undefined : t("room.jev.off")}>
        {!ready && <button type="button" data-jev-action="on" disabled={busy} onClick={() => void turnOn()} className={buttonCls}>{t("room.jev.turnOn")}</button>}
        <button type="button" data-jev-action="change" onClick={onChange} className={buttonCls}>{t("room.jev.change")}</button>
      </ItemRow>
      {error && <NoteRow tone="danger">{error}</NoteRow>}
    </>
  );
}

function JevForm({ onDone }: { onDone?: () => void }) {
  const { state, dispatch } = useStore();
  const decider = state.config?.decider;
  const own = state.config?.helpers?.own;
  const [provider, setProvider] = useState<JevProvider>(decider?.configured && !decider.included && (decider.provider === "openrouter" || decider.provider === "jev") ? decider.provider : "gateway");
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const models = useModels(provider);
  const draft = key.trim();
  const saved = provider === "gateway" ? own?.gateway === true : provider === "openrouter" ? own?.openrouter === true : own?.jev === true;
  const keyed = Boolean(draft) || saved;
  const tested = verdict?.ok === true;
  const hasModels = provider !== "jev";
  const savedModel = decider?.provider === provider ? decider.model : undefined;
  const model = picked ?? savedModel ?? models?.models[0]?.id ?? "";
  const customModel = custom.trim();
  const modelOk = !hasModels || (model === CUSTOM ? MODEL_ID.test(customModel) : Boolean(model));
  const canSave = !saving && modelOk && (draft ? tested : saved);

  const pickProvider = (next: JevProvider) => {
    setProvider(next);
    setKey("");
    setVerdict(null);
    setPicked(null);
    setCustom("");
  };

  const test = async () => {
    if (testing || !keyed) return;
    setTesting(true);
    setVerdict(null);
    try {
      const result = await api<TestResult>("/api/decider/test", { method: "POST", body: JSON.stringify({ provider, ...(draft ? { key: draft } : {}) }) });
      setVerdict(result.ok ? { ok: true, text: t("room.jev.works", { ms: String(result.latencyMs) }) } : { ok: false, text: jevFailureText(result) });
    } catch (cause) {
      setVerdict({ ok: false, text: friendlyError(cause) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const id = model === CUSTOM ? customModel : model;
      const api_: Api = model === CUSTOM ? "chat" : models?.models.find((entry) => entry.id === id)?.api ?? "chat";
      const choice = provider === "gateway" ? { gatewayModel: id, gatewayApi: api_ } : provider === "openrouter" ? { openrouterModel: id, openrouterApi: api_ } : {};
      const slot = KEY_SLOT[provider];
      const put = (decision: Record<string, unknown>) => api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: decision }) });
      let status: ConfigStatus;
      if (draft && window.madaniDesktop?.setCredential) {
        await put({ provider, ...choice });
        status = await window.madaniDesktop.setCredential(slot.credential, draft);
      } else {
        status = await put({ provider, ...choice, ...(draft ? { [slot.field]: draft } : { enabled: true, jobs: { roomRouting: true } }) });
      }
      dispatch({ type: "configStatus", config: status });
      setKey("");
      onDone?.();
    } catch (cause) {
      setVerdict({ ok: false, text: friendlyError(cause) });
    } finally {
      setSaving(false);
    }
  };

  const keyLabel = t("room.jev.keyLabel", { provider: t(PROVIDERS.find((entry) => entry.id === provider)!.label) });
  return (
    <>
      <div className={rowCls} data-sheet-row="jev-provider">
        <Segmented
          compact
          attr="data-jev-provider"
          label={t("room.jev.providerLabel")}
          value={provider}
          onChange={pickProvider}
          options={PROVIDERS.map((entry) => ({ value: entry.id, label: t(entry.label) }))}
        />
      </div>
      <form
        className={rowCls}
        data-sheet-row="jev-key"
        onSubmit={(event) => { event.preventDefault(); void test(); }}
      >
        <input
          type="password"
          value={key}
          aria-label={keyLabel}
          placeholder={saved ? t("room.jev.keySaved") : keyLabel}
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          onChange={(event) => { setKey(event.target.value); setVerdict(null); }}
          className={fieldCls}
        />
        <button type="submit" data-jev-action="test" disabled={testing || saving || !keyed} className={buttonCls}>
          {testing ? t("botPanel.ui.keysTesting") : t("botPanel.ui.keysTest")}
        </button>
      </form>
      {verdict && <div role="status" className="contents"><NoteRow tone={verdict.ok ? undefined : "danger"}>{verdict.text}</NoteRow></div>}
      {hasModels && (tested || saved) && (
        <ItemRow data-sheet-row="jev-model" title={t("room.jev.model")}>
          <SettingsSelect
            data-settings-select="jev-model"
            aria-label={t("room.jev.model")}
            value={model}
            onChange={(event) => setPicked(event.target.value)}
            options={[
              ...(savedModel && !models?.models.some((entry) => entry.id === savedModel) ? [{ value: savedModel, label: savedModel }] : []),
              ...(models?.models ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
              { value: CUSTOM, label: t("room.jev.customModel") },
            ]}
          />
        </ItemRow>
      )}
      {hasModels && (tested || saved) && model === CUSTOM && (
        <div className={rowCls} data-sheet-row="jev-custom">
          <input
            value={custom}
            aria-label={t("room.jev.customModel")}
            placeholder={t("room.jev.customPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCustom(event.target.value)}
            className={fieldCls}
          />
        </div>
      )}
      {(tested || saved) && (
        <div className="flex items-center justify-end gap-1.5 px-2 py-1.5">
          {onDone && <button type="button" data-jev-action="cancel" onClick={onDone} className={buttonCls}>{t("botPanel.ui.commonCancel")}</button>}
          <button type="button" data-jev-action="save" disabled={!canSave} onClick={() => void save()} className={primaryCls}>
            {t("botPanel.ui.commonSave")}
          </button>
        </div>
      )}
      {!tested && !saved && (
        <LinkRow data-panel-link="jev-get-key" icon={ArrowUpRight} onClick={() => void openExternalLink(PROVIDERS.find((entry) => entry.id === provider)!.keyUrl)}>
          {t("room.jev.getKey")}
        </LinkRow>
      )}
      {!tested && !saved && onDone && (
        <div className="flex items-center justify-end px-2 py-1.5">
          <button type="button" data-jev-action="cancel" onClick={onDone} className={buttonCls}>{t("botPanel.ui.commonCancel")}</button>
        </div>
      )}
    </>
  );
}
