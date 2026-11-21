import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, LogIn, X } from "../icons";
import { api, ApiError, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import { useCopyFeedback } from "@/lib/copy-text";
import { engineSignedIn } from "@/lib/product-events";
import type { LocaleKey } from "@/locales";
import { deviceSignInLink, isDeviceSignInCode, type DeviceSignInProvider } from "../../shared/device-sign-in";
import { CodexMark } from "./ProviderIcons";
import { friendlyError } from "@/lib/plain-error";

export interface DeviceSignInStatus {
  phase: "waiting" | "succeeded" | "failed" | "expired" | "cancelled";
  flowId: string | null;
  authorizationUrl: string | null;
  userCode?: string;
  expiresAt: string | null;
  message?: string;
  /** The CLI's own browser sign-in, which comes back to its listener on the server's machine. */
  loopback?: { authorizationUrl: string; port: number; path: string };
}

import { chatgptPlanLink, loopbackOf, signInProvider } from "./onboarding/connect-flow";

export { chatgptPlanLink };
export const deviceSignInProvider = signInProvider;

export const DEVICE_SIGN_IN_COPY: Record<DeviceSignInProvider, Record<"description" | "start" | "enterCode" | "open" | "security" | "connected" | "connectedAccount" | "failed" | "invalidChallenge", LocaleKey>> = {
  codex: {
    description: "engineSetup.device.description",
    start: "engineSetup.device.start",
    enterCode: "engineSetup.device.enterCode",
    open: "engineSetup.device.openChatGPT",
    security: "engineSetup.device.security",
    connected: "engineSetup.device.connected",
    connectedAccount: "engineSetup.device.connectedAccount",
    failed: "engineSetup.device.failed",
    invalidChallenge: "engineSetup.device.invalidChallenge",
  },
  grok: {
    description: "engineSetup.grok.description",
    start: "engineSetup.grok.start",
    enterCode: "engineSetup.grok.enterCode",
    open: "engineSetup.grok.open",
    security: "engineSetup.grok.security",
    connected: "engineSetup.grok.connected",
    connectedAccount: "engineSetup.grok.connectedAccount",
    failed: "engineSetup.grok.failed",
    invalidChallenge: "engineSetup.grok.invalidChallenge",
  },
  copilot: {
    description: "engineSetup.copilot.description",
    start: "engineSetup.copilot.start",
    enterCode: "engineSetup.copilot.enterCode",
    open: "engineSetup.copilot.open",
    security: "engineSetup.copilot.security",
    connected: "engineSetup.copilot.connected",
    connectedAccount: "engineSetup.copilot.connectedAccount",
    failed: "engineSetup.copilot.failed",
    invalidChallenge: "engineSetup.copilot.invalidChallenge",
  },
  cursor: {
    description: "engineSetup.cursor.description",
    start: "engineSetup.cursor.start",
    enterCode: "engineSetup.cursor.enterCode",
    open: "engineSetup.cursor.open",
    security: "engineSetup.cursor.security",
    connected: "engineSetup.cursor.connected",
    connectedAccount: "engineSetup.cursor.connectedAccount",
    failed: "engineSetup.cursor.failed",
    invalidChallenge: "engineSetup.cursor.invalidChallenge",
  },
  kimi: {
    description: "engineSetup.kimi.description",
    start: "engineSetup.kimi.start",
    enterCode: "engineSetup.kimi.enterCode",
    open: "engineSetup.kimi.open",
    security: "engineSetup.kimi.security",
    connected: "engineSetup.kimi.connected",
    connectedAccount: "engineSetup.kimi.connectedAccount",
    failed: "engineSetup.kimi.failed",
    invalidChallenge: "engineSetup.kimi.invalidChallenge",
  },
};

export function deviceFlowUnavailable(cause: unknown): boolean {
  return cause instanceof ApiError && [401, 403, 404, 410].includes(cause.status);
}

type StartCall = (path: string, init: { method: "POST"; body?: string }) => Promise<{ auth: DeviceSignInStatus; sameMachine?: boolean }>;

/** The CLI's normal browser sign-in when the browser is on the server's machine, as onboarding does: Codex's device-code
 * sign-in only works once the person enabled it in ChatGPT's security settings. Anywhere else, the device code. */
export async function startDeviceSignIn(call: StartCall, base: string): Promise<DeviceSignInStatus> {
  const device = async () => (await call(`${base}/start`, { method: "POST" })).auth;
  let answer: Awaited<ReturnType<StartCall>>;
  try {
    answer = await call(`${base}/start`, { method: "POST", body: JSON.stringify({ browser: true }) });
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 403) throw cause;
    return device();
  }
  const { auth } = answer;
  if (auth.phase !== "waiting" || !auth.loopback || answer.sameMachine === true) return auth;
  // the provider page would send the browser to a localhost nothing here listens on
  if (auth.flowId) await call(`${base}/cancel`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId }) }).catch(() => {});
  return device();
}

function loopbackLink(auth: DeviceSignInStatus): string | null {
  return auth.loopback ? loopbackOf(auth.loopback.authorizationUrl)?.authorizationUrl ?? null : null;
}

function endedFlow(phase: "expired" | "failed", browserPkce = false): DeviceSignInStatus {
  return { phase, flowId: null, authorizationUrl: null, expiresAt: null, ...(phase === "failed" ? { message: t(browserPkce ? "engineSetup.chatgpt.flowEnded" : "engineSetup.device.flowEnded") } : {}) };
}

/** Security: never turn arbitrary process output into a sign-in link; the server validates this address too. */
export function codexDeviceLink(value: string | null): string | null {
  return deviceSignInLink("codex", value);
}


const chatgptButton = "flex w-full items-center justify-center gap-2 rounded-lg border border-black/20 bg-white px-3 py-2 text-[13px] font-semibold text-black hover:opacity-85 disabled:opacity-50";

export function DeviceSignInProgress({ auth, browserPkce = false, provider = "codex" }: { auth: DeviceSignInStatus; browserPkce?: boolean; provider?: DeviceSignInProvider }) {
  const { state: codeCopy, copy: copyCode } = useCopyFeedback(auth.userCode ?? "");
  const copy = DEVICE_SIGN_IN_COPY[provider];
  const viaBrowser = !browserPkce ? loopbackLink(auth) : null;
  const link = browserPkce ? chatgptPlanLink(auth.authorizationUrl) : viaBrowser ?? deviceSignInLink(provider, auth.authorizationUrl, auth.userCode);
  const copyLabel = t(codeCopy === "failed" ? "common.copyFailed" : "engineSetup.device.copyCode");

  if (auth.phase !== "waiting") {
    const label = auth.phase === "succeeded" ? t(copy.connected)
      : auth.phase === "cancelled" ? t(browserPkce ? "engineSetup.chatgpt.cancelled" : "engineSetup.device.cancelled")
      : auth.phase === "expired" ? t(browserPkce ? "engineSetup.chatgpt.expired" : "engineSetup.device.expired")
      : auth.message || t(browserPkce ? "engineSetup.chatgpt.failed" : copy.failed);
    return <p role="status" className={auth.phase === "succeeded" ? "text-[12px] text-success" : "text-[12px] text-ink-secondary"}>{label}</p>;
  }

  if (!link || (!browserPkce && !viaBrowser && !isDeviceSignInCode(provider, auth.userCode))) {
    return <p role="alert" className="text-[12px] text-danger">{t(browserPkce ? "engineSetup.chatgpt.invalidChallenge" : copy.invalidChallenge)}</p>;
  }

  return (
    <div className="space-y-2 rounded-lg border border-transparent bg-app p-3">
      {!browserPkce && !viaBrowser && <><p className="text-[12px] text-ink-secondary">{t(copy.enterCode)}</p>
      <div className="flex items-center justify-between gap-2 rounded-lg bg-inset px-3 py-2">
        <code className="select-all font-mono text-lg font-semibold tracking-widest text-ink">{auth.userCode}</code>
        <button
          type="button"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={copyCode}
          className="rounded-md p-2 text-ink-secondary hover:bg-control hover:text-ink"
        >
          {codeCopy === "copied" ? <Check size={15} className="text-success" /> : codeCopy === "failed" ? <X size={15} className="text-danger" /> : <Copy size={15} />}
        </button>
      </div></>}
      <a href={link} target="_blank" rel="noopener noreferrer" onClick={(event) => {
        if (window.madaniDesktop?.openExternal) { event.preventDefault(); void openExternalLink(link); }
      }} className={browserPkce ? chatgptButton : "flex items-center justify-center gap-2 rounded-lg bg-ink px-3 py-2 text-[13px] font-semibold text-app hover:bg-ink/85"}>
        {browserPkce && <CodexMark size={16} className="fill-current" />}
        {t(browserPkce ? "engineSetup.chatgpt.start" : copy.open)} <ExternalLink size={13} />
      </a>
      <p role="status" className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
        <Loader2 size={12} className="animate-spin" /> {t("engineSetup.device.waiting")}
      </p>
      {auth.expiresAt && Number.isFinite(Date.parse(auth.expiresAt)) && (
        <p className="text-[11px] text-ink-secondary">{t(browserPkce ? "engineSetup.chatgpt.expires" : "engineSetup.device.expires", { time: new Date(auth.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</p>
      )}
      <p className="text-[11px] leading-relaxed text-ink-secondary">{t(browserPkce ? "engineSetup.chatgpt.security" : copy.security)}</p>
    </div>
  );
}

/** `autoStart` begins at once; `onDone` hears the outcome so an account list can close the panel. */
export function DeviceSignIn({ instanceId, browserPkce = false, provider = "codex", autoStart = false, onDone }: {
  instanceId: string;
  browserPkce?: boolean;
  provider?: DeviceSignInProvider;
  autoStart?: boolean;
  onDone?: (signedIn: boolean) => void;
}) {
  const { refreshInstances, refreshModels } = useStore();
  const [auth, setAuth] = useState<DeviceSignInStatus | null>(null);
  const [busy, setBusy] = useState(autoStart);
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/auth`;
  const copy = DEVICE_SIGN_IN_COPY[provider];
  const failed = t(browserPkce ? "engineSetup.chatgpt.failed" : copy.failed);

  // The sign-in already succeeded: a failed catalog refresh must not read as a failed sign-in.
  const refresh = async () => {
    engineSignedIn(provider, browserPkce ? "browser" : "device_code");
    try { await refreshInstances(); } catch {}
    try { await refreshModels(instanceId); } catch {}
    onDone?.(true);
  };

  useEffect(() => {
    if (busy || auth?.phase !== "waiting" || !auth.flowId) return;
    const controller = new AbortController();
    const remaining = auth.expiresAt ? Date.parse(auth.expiresAt) - Date.now() : Number.NaN;
    const expiryTimer = Number.isFinite(remaining)
      ? window.setTimeout(() => { controller.abort(); setAuth(endedFlow("expired")); setError(null); }, Math.max(0, remaining))
      : null;
    const timer = window.setTimeout(() => {
      void api(`${base}/status?flowId=${encodeURIComponent(auth.flowId!)}`, { signal: controller.signal })
        .then(async ({ auth: next }: { auth: DeviceSignInStatus }) => {
          if (controller.signal.aborted) return;
          setAuth(next);
          setError(null);
          if (next.phase === "succeeded") await refresh();
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          if (deviceFlowUnavailable(cause)) {
            setAuth(endedFlow("failed", browserPkce));
            setError(null);
            return;
          }
          setError(friendlyError(cause, failed));
          setAuth({ ...auth });
        });
    }, 2000);
    return () => {
      window.clearTimeout(timer);
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      controller.abort();
    };
  }, [auth, base, browserPkce, busy, failed, instanceId, refreshInstances, refreshModels, onDone]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const next: DeviceSignInStatus = browserPkce || provider !== "codex" ? (await api(`${base}/start`, { method: "POST" })).auth : await startDeviceSignIn(api, base);
      setAuth(next);
      if (next.phase === "succeeded") await refresh();
      else if (next.phase === "waiting") {
        const link = browserPkce ? chatgptPlanLink(next.authorizationUrl) : loopbackLink(next);
        if (link) await openExternalLink(link);
      }
    } catch (cause) {
      setError(friendlyError(cause, failed));
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!auth?.flowId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/cancel`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId }) });
      setAuth({ phase: "cancelled", flowId: null, authorizationUrl: null, expiresAt: null });
      onDone?.(false);
    } catch (cause) {
      if (deviceFlowUnavailable(cause)) setAuth(endedFlow("failed", browserPkce));
      else setError(friendlyError(cause, failed));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    void start();
  }, [autoStart]);

  const startLabel = busy ? t(browserPkce ? "engineSetup.chatgpt.starting" : "engineSetup.device.starting")
    : auth || error ? t("engineSetup.device.tryAgain")
    : t(browserPkce ? "engineSetup.chatgpt.start" : copy.start);

  return (
    <div className="mt-3 space-y-2" data-device-sign-in={provider} data-chatgpt-plan-sign-in={browserPkce || undefined}>
      {auth && <DeviceSignInProgress auth={auth} browserPkce={browserPkce} provider={provider} />}
      {auth?.phase === "waiting" ? (
        <button type="button" disabled={busy} onClick={() => void cancel()} className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-50">
          {busy ? t("engineSetup.device.cancelling") : t("engineSetup.device.cancel")}
        </button>
      ) : auth?.phase !== "succeeded" && (
        <button type="button" disabled={busy} onClick={() => void start()} className={browserPkce ? chatgptButton : "flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-3 py-2 text-[13px] font-semibold text-app hover:bg-ink/85 disabled:opacity-50"}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : browserPkce ? <CodexMark size={16} className="fill-current" /> : <LogIn size={14} />}
          {startLabel}
        </button>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {!browserPkce && provider === "codex" && <p className="text-[11px] leading-relaxed text-ink-secondary">{t("engineSetup.device.enableHint")}</p>}
    </div>
  );
}
