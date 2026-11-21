import { useEffect, useState } from "react";
import { Loader2 } from "../icons";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { normalizeImageGenerationUrl, type AvatarImageProvider } from "../../shared/image-generation";
import { Select } from "./Select";
import { t } from "@/lib/i18n";
import { putConfig } from "@/lib/sealed-send";
import { productName } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { fieldLabelCls, rowButtonCls, textFieldCls } from "./ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";

const PROVIDERS = {
  openai: { label: "OpenAI", keyLabel: "OpenAI image API key", credential: "openaiImageApiKey" },
  xai: { label: "Grok (xAI)", keyLabel: "Grok API key", credential: "xaiApiKey" },
  custom: { label: "Custom", keyLabel: "Custom image API key", credential: "customImageApiKey" },
} as const;

const LABEL = cn(fieldLabelCls, "flex flex-col gap-1");
const NOTE = "m-0 text-[12px] leading-4 tracking-[0.01em] text-ink/56 text-pretty";

export function AvatarImageGenerator({
  botLabel,
  disabled,
  generating,
  onGenerate,
  onSavingChange,
}: {
  botLabel: string;
  disabled: boolean;
  generating: boolean;
  onGenerate: (direction: string) => Promise<void>;
  onSavingChange: (saving: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const imageGen = state.config?.imageGen;
  const savedProvider = imageGen?.provider ?? "openai";
  const [providerDraft, setProviderDraft] = useState<AvatarImageProvider | null>(null);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [imageKey, setImageKey] = useState("");
  const [direction, setDirection] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = providerDraft ?? savedProvider;
  const customUrl = urlDraft ?? imageGen?.customUrl ?? "";
  const customModel = modelDraft ?? imageGen?.customModel ?? "";
  const providerInfo = PROVIDERS[provider];
  const busy = disabled || generating || saving;
  const keyConfigured = provider === "custom"
    ? imageGen?.customKeyConfigured === true
    : provider === "xai"
      ? (imageGen?.xaiConfigured ?? state.config?.xai?.configured) === true
      : (imageGen?.openaiConfigured ?? (savedProvider === "openai" && imageGen?.configured)) === true;
  const settingsDirty = provider !== savedProvider || (provider === "custom" && (
    customUrl.trim() !== (imageGen?.customUrl ?? "") ||
    customModel.trim() !== (imageGen?.customModel ?? "")
  ));
  const unsaved = settingsDirty || !!imageKey.trim();
  const configured = provider === savedProvider && imageGen?.configured === true;

  useEffect(() => {
    setImageKey("");
  }, [provider]);

  const setPending = (pending: boolean) => {
    setSaving(pending);
    onSavingChange(pending);
  };

  const saveConfig = async (patch: object) => {
    const status: ConfigStatus = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    dispatch({ type: "configStatus", config: status });
  };

  const saveCredential = async (key: string) => {
    const status: ConfigStatus = window.madaniDesktop?.setCredential
      ? await window.madaniDesktop.setCredential(providerInfo.credential, key)
      : await putConfig(provider === "xai"
          ? { xai: { key } }
          : { imageGen: provider === "custom" ? { customApiKey: key } : { key } });
    dispatch({ type: "configStatus", config: status });
    setImageKey("");
  };

  const chooseProvider = async (next: AvatarImageProvider) => {
    if (busy) return;
    setProviderDraft(next);
    setImageKey("");
    setUrlDraft(null);
    setModelDraft(null);
    setError(null);
    if (next === "custom") return;
    setPending(true);
    try {
      await saveConfig({ imageGen: { provider: next } });
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setProviderDraft(null);
      setPending(false);
    }
  };

  const saveConnection = async () => {
    if (busy || (provider === "custom" && (!customUrl.trim() || !customModel.trim()))) return;
    if (provider !== "custom" && !imageKey.trim()) return;
    setPending(true);
    setError(null);
    try {
      // Validate the whole connection before replacing its stored credential.
      const url = provider === "custom" ? normalizeImageGenerationUrl(customUrl.trim()) : "";
      const model = customModel.trim();
      if (provider === "custom" && (model.length > 200 || ["\r", "\n", "\0"].some((character) => model.includes(character)))) {
        throw new Error("Use a model ID of at most 200 characters without control characters");
      }
      if (imageKey.trim()) await saveCredential(imageKey.trim());
      if (provider === "custom") {
        await saveConfig({ imageGen: {
          provider,
          customUrl: url,
          customModel: model,
        } });
        setProviderDraft(null);
        setUrlDraft(null);
        setModelDraft(null);
      }
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setPending(false);
    }
  };

  const removeKey = async () => {
    if (busy) return;
    setPending(true);
    setError(null);
    try {
      await saveCredential("");
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setPending(false);
    }
  };

  const connectionForm = (
    <div className="flex flex-col gap-3">
      {provider === "custom" && (
        <>
          <label className={LABEL}>
            {t("botIdentity.ai.baseUrl")}
            <input
              type="url"
              value={customUrl}
              disabled={busy}
              onChange={(event) => setUrlDraft(event.target.value)}
              placeholder="http://127.0.0.1:4000/v1"
              autoComplete="off"
              className={textFieldCls}
            />
          </label>
          <label className={LABEL}>
            {t("botIdentity.ai.imageModel")}
            <input
              value={customModel}
              disabled={busy}
              onChange={(event) => setModelDraft(event.target.value)}
              placeholder="Model ID from your image provider"
              autoComplete="off"
              className={textFieldCls}
            />
          </label>
          <p className={NOTE}>
            OpenAI-compatible images API. Localhost refers to the {productName()} server, including when you open this page remotely.
          </p>
        </>
      )}
      <label className={LABEL}>
        {t(provider === "openai" ? "botIdentity.ai.openaiKey" : provider === "xai" ? "botIdentity.ai.xaiKey" : "botIdentity.ai.customKey")}{provider === "custom" ? ` (${t("botIdentity.ai.optional")})` : ""}
        <input
          type="password"
          value={imageKey}
          disabled={busy}
          onChange={(event) => setImageKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveConnection();
            }
          }}
          placeholder={keyConfigured ? t("botIdentity.ai.savedKey") : provider === "custom" ? t("botIdentity.ai.keyless") : t("botIdentity.ai.pasteKey")}
          autoComplete="off"
          className={textFieldCls}
        />
      </label>
      {provider === "xai" && (
        <p className={NOTE}>Shares the Grok API key in settings. Changing or removing it also affects other Grok features.</p>
      )}
      {provider === "custom" && keyConfigured && (
        <p className={NOTE}>The saved custom key will be used. Remove it for a keyless connection.</p>
      )}
      <div className="flex items-center justify-end gap-2">
        {keyConfigured && (
          <button type="button" onClick={() => void removeKey()} disabled={busy} className="mr-auto cursor-pointer rounded-[6px] py-1 text-[12px] leading-4 text-ink/68 transition-colors duration-[120ms] ease-[ease] hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:opacity-50">
            {t("botIdentity.ai.removeKey")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void saveConnection()}
          disabled={busy || (provider === "custom" ? !customUrl.trim() || !customModel.trim() || (!unsaved && configured) : !imageKey.trim())}
          className={rowButtonCls}
        >
          {saving && <Loader2 size={13} className="animate-spin" />}
          {provider === "custom" ? t("botIdentity.ai.saveConnection") : t("botIdentity.ai.saveKey")}
        </button>
      </div>
    </div>
  );

  const connection = (
    <>
      <label className={LABEL}>
        {t("botIdentity.ai.provider")}
        <Select variant="ghost" value={provider} onChange={(event) => void chooseProvider(event.target.value as AvatarImageProvider)} disabled={busy || !state.config} className="w-fit">
          {Object.entries(PROVIDERS).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
        </Select>
      </label>
      <p className={cn(NOTE, "-mt-1")}>
        {provider === "openai" ? t("botIdentity.ai.openaiHint")
          : provider === "xai" ? t("botIdentity.ai.xaiHint")
            : t("botIdentity.ai.customHint")}
        {" "}{t("botIdentity.ai.shared")}
      </p>
      {connectionForm}
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      <textarea
        value={direction}
        disabled={busy}
        onChange={(event) => setDirection(event.target.value.slice(0, 400))}
        maxLength={400}
        placeholder={t("botIdentity.ai.directionPlaceholder", { name: botLabel })}
        aria-label={t("botIdentity.ai.directionLabel")}
        className="block h-[174px] w-full resize-none rounded-[10px] border border-transparent bg-menu px-2.5 py-2 text-[14px] leading-[22px] tracking-[0.015em] text-ink outline-none [scrollbar-width:thin] placeholder:text-ink/56 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={() => {
          if (!busy && configured && !unsaved) {
            setError(null);
            void onGenerate(direction.trim());
          }
        }}
        disabled={busy || !configured || unsaved}
        className="flex h-[30px] w-full cursor-pointer items-center justify-center gap-1.5 rounded-[10px] bg-ink px-[13px] text-[13px] font-[425] leading-[18px] tracking-[0.195px] text-app transition-[background-color] duration-[120ms] ease-[ease] enabled:hover:bg-[color-mix(in_srgb,var(--color-ink)_88.5%,var(--color-menu))] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-56"
      >
        {generating && <Loader2 size={13} className="animate-spin" />}
        {generating ? t("botIdentity.ai.generating") : t("botPanel.avatar.tabGenerate")}
      </button>
      {unsaved && <p role="status" className={NOTE}>{t("botIdentity.ai.saveBeforeGenerate")}</p>}
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
      {configured ? (
        <details key={provider} className="-mt-1 [&[open]>summary]:mb-2.5">
          <summary className="w-fit cursor-pointer rounded-[6px] text-[12px] leading-4 text-ink/56 transition-colors duration-[120ms] ease-[ease] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">{t("botIdentity.ai.connectionSettings")}</summary>
          <div className="flex flex-col gap-3">{connection}</div>
        </details>
      ) : connection}
    </div>
  );
}
