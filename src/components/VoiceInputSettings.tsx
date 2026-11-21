// Settings > Voice: which recognizer hears the person on this device, its key or program, the language, the microphone,
// a short test, and the optional clean-up. Everything here is this device's own (prefs.ts, keys.ts); the desktop and web
// Settings pane and the phone's settings sheet both draw this.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, CircleAlert, ExternalLink } from "../icons";
import { VOICE_PROVIDERS, VOICE_PROVIDER_INFO, type VoiceProvider } from "../../electron/voice-catalog.mjs";
import { openExternalLink } from "@/lib/app-links";
import { activeLocale, t } from "@/lib/i18n";
import { friendlyError } from "@/lib/plain-error";
import { serverListeningReady } from "@/lib/speech";
import { dictationError } from "@/lib/use-composer-dictation";
import { currentVoiceDevice, onPhoneVoice, phoneVoice } from "@/lib/voice-input/device";
import { providerRunsOn, resolveEngine, systemEngineWhere, type KeyState, type ResolvedEngine, type VoiceDevice } from "@/lib/voice-input/engines";
import { saveVoiceKey, useVoiceKeys } from "@/lib/voice-input/keys";
import { listenOnce } from "@/lib/voice-input/listen-once";
import { setVoicePrefs, useVoicePrefs, type VoicePrefs } from "@/lib/voice-input/prefs";
import { voiceBridgeFor } from "@/lib/voice-input/select";
import { useStore, type InstanceInfo } from "@/state/store";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { NoteRow, SwitchRow } from "./ListRows";
import { OpenSystemSettings } from "./OpenSystemSettings";
import { SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { SettingsSelect } from "./SettingsSelect";

type Engine = VoicePrefs["engine"];

const BUILT_IN = {
  mac: "settings.voice.builtIn.mac",
  windows: "settings.voice.builtIn.windows",
  linux: "settings.voice.builtIn.linux",
  iphone: "settings.voice.builtIn.iphone",
  android: "settings.voice.builtIn.android",
  browser: "settings.voice.builtIn.browser",
} as const;

/** Common BCP 47 tags; "" follows the device. */
export const VOICE_LANGUAGES = [
  "en-US", "en-GB", "en-AU", "en-IN", "es-ES", "es-MX", "fr-FR", "de-DE", "it-IT", "pt-BR", "pt-PT", "nl-NL", "sv-SE", "pl-PL",
  "uk-UA", "ru-RU", "tr-TR", "ar-SA", "he-IL", "hi-IN", "id-ID", "vi-VN", "th-TH", "ja-JP", "ko-KR", "zh-CN", "zh-TW",
] as const;

/** The built-in recognizer, named for this device, then every service that can run here (and the chosen one, so the
 * menu always shows what is picked). */
export function engineOptions(device: VoiceDevice, current: Engine): Array<{ value: Engine; label: string }> {
  const services = VOICE_PROVIDERS.filter((provider) => providerRunsOn(provider, device) || provider === current);
  return [
    { value: "system", label: t(BUILT_IN[systemEngineWhere(device)]) },
    ...services.map((provider) => ({ value: provider, label: VOICE_PROVIDER_INFO[provider].name })),
  ];
}

/** The one line under the engine that says what is really used, when it is not what the menu shows and the person
 * cannot fix it right there. */
export function engineNote(engine: ResolvedEngine, prefs: Pick<VoicePrefs, "engine">, device: VoiceDevice): string | null {
  if (device.kind === "browser") return engine.kind === "none" ? t("settings.voice.noRecognizer") : t("settings.voice.browserNote");
  if (engine.kind === "none") return t("settings.voice.noRecognizer");
  if (engine.kind !== "system" || prefs.engine === "system" || !engine.fellBack) return null;
  // a service without its key says nothing here: the key field under the engine is what to do about it
  if (engine.fellBack === "not-set-up") return null;
  const service = VOICE_PROVIDER_INFO[prefs.engine].name;
  return device.kind === "desktop" && !device.providers ? t("settings.voice.remoteNote") : t("settings.voice.notHere", { service });
}

/** The AI connections that can write a one-off line: available, able to write in the background, not blocked by policy. */
export function cleanupConnections(instances: readonly InstanceInfo[]): InstanceInfo[] {
  return instances.filter((instance) => instance.snapshot.state === "available" && instance.capabilities?.backgroundText !== false && !instance.policy);
}

/** "default": the platform has no permission to read (Windows), and dictation listens on the default microphone. */
export type MicState = "granted" | "denied" | "prompt" | "default" | "unknown";

export function micStateFrom(raw: string | undefined): MicState {
  if (raw === "granted") return "granted";
  if (raw === "denied" || raw === "restricted") return "denied";
  if (raw === "not-determined" || raw === "prompt") return "prompt";
  if (raw === "unsupported") return "default";
  return "unknown";
}

function languageLabel(tag: string): string {
  try {
    return new Intl.DisplayNames([activeLocale()], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The device voice runs on, read again when the desktop's capabilities arrive and when the phone registers itself. */
function useVoiceDevice(): VoiceDevice {
  useDesktopCapabilities();
  useSyncExternalStore(onPhoneVoice, phoneVoice, () => null);
  return currentVoiceDevice();
}

/** The microphone's permission on this device, read again when the window comes back to the front. Null where the
 * platform cannot tell. */
function useMicPermission(): { state: MicState | null; refresh: () => void } {
  const [state, setState] = useState<MicState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    let status: PermissionStatus | null = null;
    const desktop = typeof window === "undefined" ? undefined : window.madaniDesktop;
    if (!phoneVoice() && typeof desktop?.permStatus === "function") {
      desktop.permStatus().then((found) => { if (live) setState(micStateFrom(found.mic)); }, () => { if (live) setState("unknown"); });
    } else if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      navigator.permissions.query({ name: "microphone" as PermissionName }).then((found) => {
        if (!live) return;
        status = found;
        setState(micStateFrom(found.state));
        found.onchange = () => { if (live) setState(micStateFrom(found.state)); };
      }, () => {});
    }
    const onFocus = () => setTick((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      if (status) status.onchange = null;
      window.removeEventListener("focus", onFocus);
    };
  }, [tick]);
  return { state, refresh: () => setTick((value) => value + 1) };
}

const FIELD_ROW = "flex flex-col gap-1.5 rounded-lg px-2 py-1.5";
const TITLE = "text-[13px] leading-[18px] tracking-[0.015em] text-ink";
const HINT = "text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary";
/** Settings draws its fields borderless; the faint fill shows where to type where Settings' own styles do not reach. */
const INPUT = "h-[30px] w-full min-w-0 flex-1 rounded-lg border border-transparent bg-ink/[0.07] px-2.5 hover:bg-ink/[0.09] text-[13px] leading-[18px] text-ink outline-none placeholder:text-ink-tertiary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:opacity-60";
const LINK = "inline-flex cursor-pointer items-center gap-1 self-start rounded text-[12px] leading-4 font-medium text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";

function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex gap-1.5 text-[12px] leading-4 text-danger">
      <CircleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A path, an address or a model name: kept as typed, saved when the field is left or Enter is pressed. */
function TextField({ title, hint, value, placeholder, mono = false, inputMode, onCommit, action }: {
  title: string;
  hint?: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  inputMode?: "url" | "text";
  onCommit: (value: string) => void;
  action?: ReactNode;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <div data-voice-field="" className={FIELD_ROW}>
      <label htmlFor={id} className={TITLE}>{title}</label>
      {hint && <p id={`${id}-hint`} className={HINT}>{hint}</p>}
      <div className="flex items-center gap-2">
        <input
          id={id}
          type={inputMode === "url" ? "url" : "text"}
          inputMode={inputMode}
          dir="ltr"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={draft}
          placeholder={placeholder}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className={`${INPUT}${mono ? " font-mono text-[12px] placeholder:font-sans" : ""}`}
        />
        {action}
      </div>
    </div>
  );
}

/** A service's key: typed into a password field, kept in this device's secret storage, and never shown again, only
 * whether one is saved. */
export function VoiceKeyField({ provider, saved, optional = false, onDone }: {
  provider: VoiceProvider;
  saved: boolean;
  optional?: boolean;
  /** opened from "Change key" on a saved key: it starts on the field, and closes when saved, removed or cancelled */
  onDone?: () => void;
}) {
  const id = useId();
  const info = VOICE_PROVIDER_INFO[provider];
  const [draft, setDraft] = useState("");
  const [replacing, setReplacingState] = useState(Boolean(onDone));
  const setReplacing = (next: boolean) => {
    setReplacingState(next);
    if (!next) onDone?.();
  };
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const editing = !saved || replacing;
  const title = optional ? t("settings.voice.compatKey") : t("settings.voice.key", { service: info.name });

  const commit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await saveVoiceKey(provider, value);
      setDraft("");
      setReplacing(false);
      if (!value) onDone?.();
    } catch (cause) {
      setProblem(t("settings.voice.keyFailed", { reason: friendlyError(cause) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="group" aria-labelledby={`${id}-title`} data-voice-key={provider} data-key-state={saved ? "saved" : "empty"} className={FIELD_ROW}>
      <div className="flex min-h-[18px] items-center gap-2">
        {editing
          ? <label id={`${id}-title`} htmlFor={`${id}-input`} className={`${TITLE} min-w-0 flex-1`}>{title}</label>
          : <span id={`${id}-title`} className={`${TITLE} min-w-0 flex-1`}>{title}</span>}
        {saved && (
          <span className="flex shrink-0 items-center gap-1 text-[12px] leading-5 text-ink-secondary">
            <Check size={13} aria-hidden="true" className="text-success" />
            {t("settings.voice.keySaved")}
          </span>
        )}
      </div>
      <p id={`${id}-hint`} className={HINT}>{t("settings.voice.keyHint")}</p>
      {editing ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void commit(draft); }}>
          <input
            id={`${id}-input`}
            type="password"
            dir="ltr"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={draft}
            disabled={busy}
            placeholder={info.placeholder || t("settings.voice.keyPlaceholder")}
            aria-describedby={`${id}-hint`}
            onChange={(event) => { setDraft(event.target.value); setProblem(null); }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && replacing) {
                event.preventDefault();
                event.stopPropagation();
                setReplacing(false);
                setDraft("");
              }
            }}
            className={`${INPUT} min-w-[min(100%,12rem)] font-mono text-[12px] placeholder:font-sans`}
          />
          <span className="flex shrink-0 items-center gap-2">
            <button type="submit" data-voice-key-save="" className="ui-button ui-button-primary" disabled={!draft.trim() || busy}>{t("settings.voice.save")}</button>
            {replacing && <button type="button" className="ui-button" onClick={() => { setReplacing(false); setDraft(""); }}>{t("settings.voice.cancel")}</button>}
            {replacing && onDone && <button type="button" data-voice-key-remove="" className="ui-button" disabled={busy} onClick={() => void commit("")}>{t("settings.voice.keyRemove")}</button>}
          </span>
        </form>
      ) : (
        <span className="flex items-center gap-2">
          <button type="button" data-voice-key-replace="" className="ui-button" disabled={busy} onClick={() => setReplacing(true)}>{t("settings.voice.keyReplace")}</button>
          <button type="button" data-voice-key-remove="" className="ui-button" disabled={busy} onClick={() => void commit("")}>{t("settings.voice.keyRemove")}</button>
        </span>
      )}
      {editing && info.keyUrl && (
        <button type="button" className={LINK} onClick={() => void openExternalLink(info.keyUrl)}>
          {t("settings.voice.getKey")}
          <ExternalLink size={11} aria-hidden="true" />
        </button>
      )}
      {problem && <Problem>{problem}</Problem>}
    </div>
  );
}

function ServiceFields({ provider, prefs, keys, changingKey, onKeyDone }: {
  provider: VoiceProvider;
  prefs: VoicePrefs;
  keys: KeyState;
  changingKey: boolean;
  onKeyDone: () => void;
}) {
  const info = VOICE_PROVIDER_INFO[provider];
  const [finding, setFinding] = useState(false);
  const [findProblem, setFindProblem] = useState<string | null>(null);
  const setModel = (model: string) => setVoicePrefs((current) => ({ models: { ...current.models, [provider]: model } }));

  if (provider === "whisper-cpp") {
    const find = window.madaniDesktop?.voiceInput?.findWhisperCpp;
    const runFind = async () => {
      if (!find || finding) return;
      setFinding(true);
      setFindProblem(null);
      try {
        const found = await find();
        if (!found.binaries.length && !found.models.length) setFindProblem(t("settings.voice.findNone"));
        else setVoicePrefs((current) => ({ whisperCpp: { binary: found.binaries[0] ?? current.whisperCpp.binary, model: found.models[0] ?? current.whisperCpp.model } }));
      } catch (cause) {
        setFindProblem(t("settings.voice.findFailed", { reason: friendlyError(cause) }));
      } finally {
        setFinding(false);
      }
    };
    return (
      <>
        <TextField
          title={t("settings.voice.whisperBinary")}
          hint={t("settings.voice.whisperHint")}
          value={prefs.whisperCpp.binary}
          mono
          onCommit={(binary) => setVoicePrefs((current) => ({ whisperCpp: { ...current.whisperCpp, binary } }))}
          action={find && <button type="button" data-voice-find="" className="ui-button shrink-0" disabled={finding} onClick={() => void runFind()}>{finding ? t("settings.voice.finding") : t("settings.voice.find")}</button>}
        />
        <TextField
          title={t("settings.voice.whisperModel")}
          value={prefs.whisperCpp.model}
          mono
          onCommit={(model) => setVoicePrefs((current) => ({ whisperCpp: { ...current.whisperCpp, model } }))}
        />
        {findProblem && <div className="px-2 pb-1.5"><Problem>{findProblem}</Problem></div>}
      </>
    );
  }

  if (provider === "openai-compatible") {
    return (
      <>
        <TextField
          title={t("settings.voice.compatUrl")}
          hint={t("settings.voice.compatUrlHint")}
          value={prefs.compatBaseUrl}
          placeholder="https://example.com/v1"
          inputMode="url"
          mono
          onCommit={(compatBaseUrl) => setVoicePrefs({ compatBaseUrl })}
        />
        {(keys[provider] !== true || changingKey) && <VoiceKeyField provider={provider} saved={keys[provider] === true} optional onDone={changingKey ? onKeyDone : undefined} />}
        <TextField
          title={t("settings.voice.model")}
          value={prefs.models[provider] ?? ""}
          placeholder={t("settings.voice.compatModelPlaceholder")}
          mono
          onCommit={setModel}
        />
      </>
    );
  }

  return (
    <>
      {(keys[provider] !== true || changingKey) && <VoiceKeyField provider={provider} saved={keys[provider] === true} onDone={changingKey ? onKeyDone : undefined} />}
      {info.realtime && keys[provider] === true && (
        <SwitchRow
          data-panel-row="voice-realtime"
          title={t("settings.voice.realtime")}
          hint={t("settings.voice.realtimeHint")}
          checked={prefs.realtime}
          onChange={() => setVoicePrefs((current) => ({ realtime: !current.realtime }))}
        />
      )}
    </>
  );
}

function MicrophoneRow({ device }: { device: VoiceDevice }) {
  const { state, refresh } = useMicPermission();
  // an allowed (or unreadable) microphone needs nothing from the person, so it takes no row
  if (state !== "denied" && state !== "prompt") return null;
  const desktop = device.kind === "desktop" ? window.madaniDesktop : undefined;
  const phoneSettings = device.kind === "phone" ? phoneVoice()?.openSettings : undefined;
  const action = state === "prompt" && typeof desktop?.permRequestMic === "function"
    ? <button type="button" className="ui-button" onClick={() => void desktop.permRequestMic().catch(() => false).then(refresh)}>{t("settings.voice.mic.allow")}</button>
    : state === "denied" && desktop ? <OpenSystemSettings pane="mic" />
      : state === "denied" && phoneSettings ? <button type="button" className="ui-button" onClick={() => void phoneSettings().catch(() => {})}>{t("settings.voice.mic.openSettings")}</button>
        : null;
  return (
    <SettingRow title={t("settings.voice.mic")} subtitle={state === "denied" ? t("settings.voice.mic.deniedHint") : undefined}>
      <span className="flex flex-wrap items-center justify-end gap-2">
        <span data-voice-mic={state} className="flex items-center gap-1 text-[13px] leading-[18px] text-ink-secondary">
          {state === "denied" && <CircleAlert size={13} aria-hidden="true" className="text-danger" />}
          {t(`settings.voice.mic.${state}`)}
        </span>
        {action}
      </span>
    </SettingRow>
  );
}

/** Three seconds through the engine in use, the words it heard shown under the row. Runs only when pressed. */
function TestRow({ prefs, keys, device, serverListens }: { prefs: VoicePrefs; keys: KeyState; device: VoiceDevice; serverListens: boolean }) {
  const [listening, setListening] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: ReactNode } | null>(null);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  const run = async () => {
    if (running.current) return;
    const engine = resolveEngine(prefs, device, keys, serverListens);
    const where = systemEngineWhere(device);
    const bridge = voiceBridgeFor(engine, prefs);
    if (!bridge) {
      setResult({ ok: false, text: dictationError({ code: 2, reason: "recognizer-unavailable" }, engine, where) });
      return;
    }
    const controller = new AbortController();
    running.current = controller;
    setListening(true);
    setResult(null);
    const heard = await listenOnce(bridge, { signal: controller.signal, ...(prefs.language ? { locale: prefs.language } : {}) });
    running.current = null;
    if (controller.signal.aborted) return;
    setListening(false);
    if (heard.ok) setResult({ ok: true, text: t("settings.voice.testHeard", { text: heard.text }) });
    else setResult({ ok: false, text: heard.end.reason === "no-words" ? t("settings.voice.testNothing") : dictationError(heard.end, engine, where) });
  };

  return (
    <SettingRow
      title={t("settings.voice.test")}
      subtitle={t("settings.voice.testHint")}
      message={(listening || result) && (
        <p role="status" data-voice-test-result={listening ? "listening" : result?.ok ? "ok" : "failed"}
          className={`flex gap-1.5 text-[13px] leading-[18px] ${result && !result.ok ? "text-danger" : "text-ink-secondary"} [overflow-wrap:anywhere]`}>
          {result && !result.ok && <CircleAlert size={13} aria-hidden="true" className="mt-0.5 shrink-0" />}
          <span>{listening ? t("settings.voice.testListening") : result?.text}</span>
        </p>
      )}
    >
      <button type="button" data-voice-test="" className="ui-button" disabled={listening} onClick={() => void run()}>
        {listening ? t("settings.voice.testListening") : t("settings.voice.testStart")}
      </button>
    </SettingRow>
  );
}

function CleanupRows({ prefs }: { prefs: VoicePrefs }) {
  const { state } = useStore();
  const connections = cleanupConnections(state.instances ?? []);
  const chosen = connections.find((instance) => instance.instanceId === prefs.cleanup.instanceId);
  const models = chosen?.models.options.filter((option) => !option.orgBlocked) ?? [];
  return (
    <>
      <SwitchRow
        data-panel-row="voice-cleanup"
        title={t("settings.voice.cleanup")}
        hint={t("settings.voice.cleanupHint")}
        checked={prefs.cleanup.on}
        onChange={() => setVoicePrefs((current) => ({ cleanup: { ...current.cleanup, on: !current.cleanup.on } }))}
      />
      {prefs.cleanup.on && !connections.length && <NoteRow>{t("settings.voice.cleanupNone")}</NoteRow>}
      {prefs.cleanup.on && connections.length > 0 && (
        <SettingRow title={t("settings.voice.cleanupAi")}>
          <SettingsSelect
            data-settings-select="voice-cleanup-ai"
            aria-label={t("settings.voice.cleanupAi")}
            value={chosen?.instanceId ?? ""}
            options={[{ value: "", label: t("settings.voice.cleanupAuto") }, ...connections.map((instance) => ({ value: instance.instanceId, label: instance.displayName }))]}
            onChange={(event) => setVoicePrefs({ cleanup: { on: true, instanceId: event.target.value, model: "" } })}
          />
        </SettingRow>
      )}
      {prefs.cleanup.on && chosen && models.length > 0 && (
        <SettingRow title={t("settings.voice.cleanupModel")}>
          <SettingsSelect
            data-settings-select="voice-cleanup-model"
            aria-label={t("settings.voice.cleanupModel")}
            value={models.some((option) => option.id === prefs.cleanup.model) ? prefs.cleanup.model : ""}
            options={[{ value: "", label: t("settings.voice.cleanupQuick") }, ...models.map((option) => ({ value: option.id, label: option.label }))]}
            onChange={(event) => setVoicePrefs((current) => ({ cleanup: { ...current.cleanup, model: event.target.value } }))}
          />
        </SettingRow>
      )}
    </>
  );
}

export function VoiceInputSettings() {
  const device = useVoiceDevice();
  const prefs = useVoicePrefs();
  const keys = useVoiceKeys();
  const serverListens = serverListeningReady(useStore().state.config);
  const engine = resolveEngine(prefs, device, keys, serverListens);
  const options = engineOptions(device, prefs.engine);
  const note = engineNote(engine, prefs, device);
  const service = prefs.engine !== "system" && providerRunsOn(prefs.engine, device) ? prefs.engine : null;
  const info = service ? VOICE_PROVIDER_INFO[service] : null;
  const keyed = service !== null && service !== "whisper-cpp" && keys[service] === true;
  const [changingKey, setChangingKey] = useState<VoiceProvider | null>(null);
  const changing = changingKey !== null && changingKey === service;
  // a service's model is a choice of the engine, so it sits beside it once the service is ready to use
  const models = service !== "openai-compatible" && keyed && info && info.models.length > 1 ? info.models : null;
  const languages = prefs.language && !(VOICE_LANGUAGES as readonly string[]).includes(prefs.language) ? [prefs.language, ...VOICE_LANGUAGES] : VOICE_LANGUAGES;
  const engineHint = keyed && !changing && info
    ? (
      <>
        {t("settings.voice.keyReady", { service: info.name })}{" "}
        <button type="button" data-voice-key-change="" className="cursor-pointer rounded text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus" onClick={() => setChangingKey(service)}>
          {t("settings.voice.keyChange")}
        </button>
      </>
    )
    : t("settings.voice.engineHint");

  return (
    <>
      <SettingsGroup label={t("settings.voice.group.input")} block="voice">
        <SettingsRows>
          <SettingRow title={t("settings.voice.engine")} subtitle={engineHint}>
            {options.length > 1 ? (
              <span className="flex flex-wrap items-center justify-end gap-1.5">
                <SettingsSelect
                  data-settings-select="voice-engine"
                  aria-label={t("settings.voice.engine")}
                  value={prefs.engine}
                  options={options}
                  onChange={(event) => { setChangingKey(null); setVoicePrefs({ engine: event.target.value as Engine }); }}
                />
                {models && service && (
                  <SettingsSelect
                    data-settings-select="voice-model"
                    aria-label={t("settings.voice.model")}
                    value={prefs.models[service] || models[0]!}
                    options={models.map((model) => ({ value: model, label: model }))}
                    onChange={(event) => setVoicePrefs((current) => ({ models: { ...current.models, [service]: event.target.value } }))}
                  />
                )}
              </span>
            ) : <span data-panel-value="" className="text-[13px] leading-[18px] text-ink-secondary">{options[0]!.label}</span>}
          </SettingRow>
          {note && <NoteRow>{note}</NoteRow>}
          {service && <ServiceFields provider={service} prefs={prefs} keys={keys} changingKey={changing} onKeyDone={() => setChangingKey(null)} />}
          <SettingRow title={t("settings.voice.language")} subtitle={t("settings.voice.languageHint")}>
            <SettingsSelect
              data-settings-select="voice-language"
              aria-label={t("settings.voice.language")}
              value={prefs.language}
              options={[{ value: "", label: t("settings.voice.languageAuto") }, ...languages.map((tag) => ({ value: tag, label: languageLabel(tag) }))]}
              onChange={(event) => setVoicePrefs({ language: event.target.value })}
            />
          </SettingRow>
          <MicrophoneRow device={device} />
          <TestRow prefs={prefs} keys={keys} device={device} serverListens={serverListens} />
        </SettingsRows>
      </SettingsGroup>
      <SettingsGroup label={t("settings.voice.group.cleanup")} block="voice-cleanup">
        <SettingsRows>
          <CleanupRows prefs={prefs} />
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}
