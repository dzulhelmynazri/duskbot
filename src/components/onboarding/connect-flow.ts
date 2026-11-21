// One AI being connected, as stages with a deadline each: waking the cloud, getting the AI ready (a fresh status read,
// then the provider's official helper downloaded when it is missing), opening its sign-in, waiting for the person, and
// confirming. A stage that runs past its deadline ends in a plain message with Try again, never a spinner left alone.
// Kept free of React so a remount (StrictMode, a closed dialog) can't strand it and each transition is testable.
import { deviceSignInLink, isDeviceSignInCode, type DeviceSignInProvider } from "../../../shared/device-sign-in";
import { friendlyError } from "@/lib/plain-error";

export type ConnectStageName = "waking" | "preparing" | "installing" | "opening" | "waiting" | "confirming";

/** How the person finishes signing in: a code at the provider's page, a link that comes back here by itself, a code
 * pasted back (Claude), a provider page that calls back to this machine (managed engines), or, when that callback can't
 * reach the machine running the CLI (a remote server opened in a browser), the address it landed on pasted back. */
export type WaitKind = "device" | "browser" | "paste" | "callback" | "redirect";

export type ConnectState =
  | { stage: "idle" }
  | { stage: "waking"; since: number }
  | { stage: "preparing"; since: number }
  | { stage: "installing"; since: number; downloadBytes: number | null; progress?: InstallProgress | null }
  | { stage: "opening"; since: number }
  | { stage: "waiting"; since: number; kind: WaitKind; flowId: string; link: string | null; code: string | null; opened: boolean; problem?: string | null }
  | { stage: "confirming"; since: number }
  | { stage: "connected"; reused: boolean }
  | { stage: "failed"; at: ConnectStageName; reason: FailReason; message: string | null; link: string | null };

/** What the server measured of an install: bytes of a known total while downloading, then setup. */
export interface InstallProgress {
  phase: "download" | "setup";
  received: number;
  total: number | null;
}

/** A known-total reading worth drawing as a bar, or null for the elapsed-time fallback. */
export function measured(progress: InstallProgress | null | undefined): (InstallProgress & { total: number }) | null {
  if (!progress || typeof progress.total !== "number" || !(progress.total > 0)) return null;
  if (progress.phase !== "download" && progress.phase !== "setup") return null;
  const received = Math.max(0, Math.min(progress.total, Number(progress.received) || 0));
  return { phase: progress.phase, received, total: progress.total };
}

export const INSTALL_POLL_MS = 1_000;

/** Why a stage ended: a timeout, the sign-in lost, the AI unusable here, or the provider's own refusal (its `message`). */
export type FailReason = "timeout" | "lost" | "unavailable" | "error";

export interface ConnectInstance {
  instanceId: string;
  driverKind: string;
  access?: string;
  snapshot: { state: string; authenticated?: boolean; reason?: string; authenticationUnavailableReason?: string };
  authentication?: { method: "device-code" | "paste-code" | "browser" | "browser-pkce" };
  install?: { server?: { standalone?: { downloadBytes?: number } } | unknown; managed?: { downloadBytes?: number } | unknown };
}

export interface ConnectTimeouts {
  waking: number;
  preparing: number;
  installing: number;
  opening: number;
  waiting: number;
  confirming: number;
}

export const CONNECT_TIMEOUTS: ConnectTimeouts = {
  waking: 3 * 60_000,
  preparing: 45_000,
  // the server gives npm 10 minutes; a download that slow is better retried by the person than watched
  installing: 8 * 60_000,
  opening: 60_000,
  // device codes last 15 minutes (Codex, GitHub, Grok)
  waiting: 15 * 60_000,
  confirming: 45_000,
};

export const POLL_MS = 2_000;
/** Status checks in a row that got no answer before the sign-in says it lost track. */
export const LOST_AFTER = 5;
const CHECKING = /^Checking engine status$/;

export interface ConnectDeps {
  api<T = unknown>(path: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<T>;
  /** Reads every AI's status again and answers with the fresh list. */
  refresh(): Promise<readonly ConnectInstance[]>;
  /** Opens a link in the person's browser; false when it could not. */
  open(link: string): Promise<boolean>;
  trail(ev: string, fields: Record<string, string | number | boolean | null | undefined>): void;
  /** The desktop app listening on a loopback port for a provider's browser sign-in on a remote workspace. */
  relay?: LoopbackRelay;
  /** The cloud is asleep or waking right now. */
  waking?(): boolean;
  now?(): number;
  timeouts?: Partial<ConnectTimeouts>;
}

export interface LoopbackRelay {
  /** False when the port is taken on this computer. */
  open(port: number, path: string): Promise<boolean>;
  /** The callback the browser brought back, or null once closed. */
  next(port: number): Promise<string | null>;
  done(port: number, result: { ok: boolean; location?: string | null }): Promise<unknown>;
  close(port: number): Promise<unknown>;
}

type Loopback = { authorizationUrl: string; port: number; path: string };
type StartAnswer = { auth: { phase: string; flowId?: string | null; authorizationUrl?: string | null; userCode?: string; message?: string; loopback?: Loopback }; sameMachine?: boolean };

export interface ConnectTarget {
  /** The card's name for the trail and the messages ("chatgpt"). */
  tile: string;
  /** The instances that are this AI, best first: the first usable one is connected, a signed-in one is reused. */
  candidates: readonly string[];
}

export function ready(instance: ConnectInstance): boolean {
  return instance.snapshot.state === "available" && (instance.access === "custom" || instance.snapshot.authenticated !== false);
}

/** Whether this AI can get from where it is to signed in without leaving the app. */
export function connectsInApp(instance: ConnectInstance): boolean {
  if (instance.snapshot.authenticationUnavailableReason) return false;
  if (instance.snapshot.state === "available") return instance.snapshot.authenticated === false ? Boolean(instance.authentication) : true;
  return Boolean(instance.install?.server || instance.install?.managed) || CHECKING.test(instance.snapshot.reason ?? "");
}

export function signInProvider(driverKind: string): DeviceSignInProvider {
  switch (driverKind) {
    case "grokAgent": return "grok";
    case "kimiAgent": return "kimi";
    case "copilotAgent": return "copilot";
    case "cursorAgent": return "cursor";
    default: return "codex";
  }
}

/** ChatGPT's own authorize page, and nothing else. */
export function chatgptPlanLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/authorize" && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

/** An https page with no login or fragment: the managed engines' provider page (Google for Antigravity). */
/** A provider link's loopback redirect (http://127.0.0.1:<port>/<path>), for servers that do not report it. */
export function loopbackOf(authorizationUrl: string | null | undefined): Loopback | null {
  const link = httpsLink(authorizationUrl);
  if (!link) return null;
  try {
    const redirect = new URL(new URL(link).searchParams.get("redirect_uri") ?? "");
    const port = Number(redirect.port);
    if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname) || !Number.isInteger(port) || port < 1024) return null;
    return { authorizationUrl: link, port, path: redirect.pathname };
  } catch { return null; }
}

function httpsLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

class StageEnded extends Error {
  constructor(readonly reason: FailReason, readonly detail: string | null = null, readonly waking = false) { super(reason); }
}

const STAGES: readonly string[] = ["waking", "preparing", "installing", "opening", "waiting", "confirming"];

const wakingError = (cause: unknown): boolean => {
  const error = cause as { status?: number; body?: { error?: unknown } } | null;
  return error?.status === 503 && (error.body?.error === "waking" || error.body?.error === "asleep");
};

const messageOf = (cause: unknown): string | null => (cause instanceof Error && cause.message ? friendlyError(cause) : null);

type Listener = (state: ConnectState) => void;

/** Runs one connect at a time; `start` on a running one cancels it first. */
export class ConnectFlow {
  state: ConnectState = { stage: "idle" };
  target: ConnectTarget | null = null;
  private instanceId = "";
  private flowId = "";
  private run = 0;
  private abort: AbortController | null = null;
  private listeners = new Set<Listener>();
  private readonly limits: ConnectTimeouts;
  private readonly deps: ConnectDeps;
  private pasteDone: ((code: string) => void) | null = null;
  private relayPort: number | null = null;

  constructor(deps: ConnectDeps) {
    this.deps = deps;
    this.limits = { ...CONNECT_TIMEOUTS, ...deps.timeouts };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The instance the flow is connecting now. */
  get instance(): string { return this.instanceId; }

  get running(): boolean {
    return !["idle", "connected", "failed"].includes(this.state.stage);
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private set(next: ConnectState, run: number): void {
    if (run !== this.run) return;
    const before = this.state;
    this.state = next;
    if (before.stage !== next.stage || next.stage === "waiting") {
      const fields = { tile: this.target?.tile, instance: this.instanceId, from: before.stage };
      if (next.stage === "failed") this.deps.trail(next.reason === "timeout" ? "connect.timeout" : "connect.fail", { ...fields, stage: next.at, reason: next.reason });
      else if (next.stage === "connected") this.deps.trail("connect.done", { ...fields, reused: next.reused });
      else if (next.stage !== "idle") this.deps.trail("connect.stage", { ...fields, stage: next.stage,
        ...(next.stage === "waiting" ? { kind: next.kind, opened: next.opened, link: Boolean(next.link), code: Boolean(next.code) } : {}) });
    }
    for (const listener of this.listeners) listener(next);
  }

  start(target: ConnectTarget): void {
    if (this.running) this.cancel();
    this.target = target;
    const run = ++this.run;
    this.abort = new AbortController();
    void this.connect(run, this.abort.signal);
  }

  retry(): void {
    if (this.target) this.start(this.target);
  }

  /** Stops what is running; a sign-in under way is cancelled on the server too, so its helper doesn't linger. */
  cancel(): void {
    const state = this.state;
    if (!this.running && state.stage !== "failed") return;
    const run = ++this.run;
    this.abort?.abort();
    this.abort = null;
    this.pasteDone = null;
    this.closeRelay();
    if (state.stage === "waiting" && this.instanceId) {
      void this.deps.api(`/api/instances/${encodeURIComponent(this.instanceId)}/auth/cancel`, { method: "POST", body: JSON.stringify({ flowId: state.flowId }) }).catch(() => {});
    }
    if (this.running) this.deps.trail("connect.cancel", { tile: this.target?.tile, instance: this.instanceId, stage: state.stage });
    this.run = run;
    this.state = { stage: "idle" };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Opens the sign-in page again; false when the browser would not open it. */
  async openAgain(): Promise<boolean> {
    const state = this.state;
    const link = state.stage === "waiting" || state.stage === "failed" ? state.link : null;
    if (!link) return false;
    const opened = await this.deps.open(link).catch(() => false);
    this.deps.trail("connect.open", { tile: this.target?.tile, instance: this.instanceId, opened, again: true });
    return opened;
  }

  /** The code a provider showed after sign-in (Claude), or the address its sign-in landed on, pasted back. */
  submit(code: string): void {
    if (this.state.stage === "waiting" && (this.state.kind === "paste" || this.state.kind === "redirect") && code.trim()) this.pasteDone?.(code.trim());
  }

  private closeRelay(): void {
    if (this.relayPort === null) return;
    void this.deps.relay?.close(this.relayPort).catch(() => {});
    this.relayPort = null;
  }

  /** Races `work` against this stage's deadline and a cancel. */
  private within<T>(stage: ConnectStageName, signal: AbortSignal, work: (stageSignal: AbortSignal) => Promise<T>): Promise<T> {
    const stageAbort = new AbortController();
    const relay = () => stageAbort.abort();
    signal.addEventListener("abort", relay, { once: true });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { stageAbort.abort(); reject(new StageEnded("timeout")); }, this.limits[stage]);
      work(stageAbort.signal).then(resolve, reject).finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", relay);
      });
    });
  }

  /** One request that waits out a cloud waking up (stage "waking", then back to `stage`), within the waking deadline. */
  private async awake<T>(run: number, signal: AbortSignal, back: ConnectState, request: () => Promise<T>): Promise<T> {
    const wakeUntil = this.now() + this.limits.waking;
    for (;;) {
      try {
        if (this.deps.waking?.()) throw Object.assign(new Error("waking"), { status: 503, body: { error: "waking" } });
        const answer = await request();
        if (this.state.stage === "waking") this.set(back, run);
        return answer;
      } catch (cause) {
        if (signal.aborted || !wakingError(cause)) throw cause;
        if (this.now() >= wakeUntil) throw new StageEnded("timeout", null, true);
        if (this.state.stage !== "waking") this.set({ stage: "waking", since: this.now() }, run);
        await sleep(3_000, signal);
      }
    }
  }

  /** Reads the install's progress until `signal` ends; a server without the reading stops being asked. */
  private async watchInstall(path: string, signal: AbortSignal, report: (progress: InstallProgress) => void): Promise<void> {
    while (!signal.aborted) {
      await sleep(INSTALL_POLL_MS, signal).catch(() => {});
      if (signal.aborted) return;
      try {
        const answer = await this.deps.api<{ progress?: InstallProgress | null }>(path, { signal });
        if (signal.aborted) return;
        if (answer?.progress) report(answer.progress);
      } catch (cause) {
        if ((cause as { status?: number })?.status === 404 || (cause as { status?: number })?.status === 405) return;
      }
    }
  }

  private find(instances: readonly ConnectInstance[], target: ConnectTarget): { reused: ConnectInstance | null; usable: ConnectInstance | null; first: ConnectInstance | null } {
    const mine = target.candidates.map((id) => instances.find((instance) => instance.instanceId === id)).filter(Boolean) as ConnectInstance[];
    return { reused: mine.find(ready) ?? null, usable: mine.find(connectsInApp) ?? null, first: mine[0] ?? null };
  }

  private async connect(run: number, signal: AbortSignal): Promise<void> {
    const target = this.target!;
    const base = (id: string) => `/api/instances/${encodeURIComponent(id)}`;
    let link: string | null = null;
    let latest: readonly ConnectInstance[] = [];
    const read = async () => {
      latest = await this.deps.refresh();
      return this.find(latest, target);
    };
    try {
      const preparing: ConnectState = { stage: "preparing", since: this.now() };
      this.set(this.deps.waking?.() ? { stage: "waking", since: this.now() } : preparing, run);

      // a fresh read first: a login that already works is reused, an install that is there is not downloaded again
      let found = await this.awake(run, signal, preparing, () => this.within("preparing", signal, async (stageSignal) => {
        let now = await read();
        while (!now.reused && now.usable && CHECKING.test(now.usable.snapshot.reason ?? "")) {
          await sleep(1_000, stageSignal);
          now = await read();
        }
        return now;
      }));
      if (this.state.stage === "waking") this.set(preparing, run);
      if (found.reused) {
        this.instanceId = found.reused.instanceId;
        return this.set({ stage: "connected", reused: true }, run);
      }
      let instance = found.usable;
      if (!instance) {
        this.instanceId = found.first?.instanceId ?? "";
        throw new StageEnded("unavailable", found.first?.snapshot.authenticationUnavailableReason ?? found.first?.snapshot.reason ?? null);
      }
      this.instanceId = instance.instanceId;

      if (instance.snapshot.state !== "available") {
        const install = instance.install as { server?: { standalone?: { downloadBytes?: number } }; managed?: { downloadBytes?: number } } | undefined;
        const downloadBytes = install?.server?.standalone?.downloadBytes ?? install?.managed?.downloadBytes ?? null;
        let installing: ConnectState = { stage: "installing", since: this.now(), downloadBytes, progress: null };
        this.set(installing, run);
        const installId = instance.instanceId;
        await this.awake(run, signal, installing, () => this.within("installing", signal, async (stageSignal) => {
          const done = new AbortController();
          const watching = this.watchInstall(`${base(installId)}/install`, AbortSignal.any([stageSignal, done.signal]), (progress) => {
            if (this.state.stage !== "installing") return;
            installing = { ...this.state, progress };
            this.set(installing, run);
          });
          try {
            return await this.deps.api(`${base(installId)}/install`, { method: "POST", signal: stageSignal });
          } finally {
            done.abort();
            await watching;
          }
        }));
        found = await read();
        if (found.reused) return this.set({ stage: "connected", reused: false }, run);
        const now = found.usable ?? found.first;
        if (!now || now.snapshot.state !== "available") {
          throw new StageEnded("unavailable", now?.snapshot.authenticationUnavailableReason ?? now?.snapshot.reason ?? null);
        }
        instance = now;
        this.instanceId = instance.instanceId;
      }

      // in order: a ChatGPT plan sign-in refused on a remote machine falls back to the Codex code sign-in
      const signIns = [instance, ...target.candidates
        .filter((id) => id !== instance!.instanceId)
        .map((id) => latest.find((candidate) => candidate.instanceId === id))
        .filter((candidate): candidate is ConnectInstance => Boolean(candidate && candidate.snapshot.state === "available" && candidate.authentication && connectsInApp(candidate)))];
      let started: StartAnswer | null = null;
      const startOnce = (candidate: ConnectInstance, browser: boolean) => this.awake(run, signal, { stage: "opening", since: this.now() }, () => this.within("opening", signal,
        (stageSignal) => this.deps.api<StartAnswer>(`${base(candidate.instanceId)}/auth/start`, { method: "POST", body: JSON.stringify({ browser }), signal: stageSignal })));
      for (const [at, candidate] of signIns.entries()) {
        if (!candidate.authentication) continue;
        const opening: ConnectState = { stage: "opening", since: this.now() };
        this.set(opening, run);
        this.instanceId = candidate.instanceId;
        instance = candidate;
        try {
          started = await this.browserStart(candidate, Boolean(this.deps.relay), startOnce, signal);
          break;
        } catch (cause) {
          if ((cause as { status?: number }).status !== 403 || at === signIns.length - 1) throw cause;
          this.deps.trail("connect.fallback", { tile: target.tile, from: candidate.instanceId });
        }
      }
      if (!started) throw new StageEnded("unavailable");
      const { auth } = started;
      if (auth.phase === "succeeded") return await this.confirm(run, signal, target, false);
      if (auth.phase !== "waiting" || !auth.flowId) throw new StageEnded("error", auth.message ?? null);

      const method = instance.authentication!.method;
      const provider = signInProvider(instance.driverKind);
      // the provider's normal sign-in when the browser can reach the CLI's loopback: on this machine, or relayed here.
      // a server from before the relay (madani cloud on 0.2.8) sends neither `loopback` nor `sameMachine`: it is remote,
      // and a callback sign-in's loopback is read from the link's own redirect_uri
      const sameMachine = started.sameMachine === true;
      const loopback = auth.loopback && httpsLink(auth.loopback.authorizationUrl) ? auth.loopback
        : method === "browser" ? loopbackOf(auth.authorizationUrl) : null;
      const viaLoopback = Boolean(loopback && (sameMachine || await this.openRelay(loopback)));
      if (signal.aborted) { this.closeRelay(); return; }
      const pasteBack = method === "browser" && !sameMachine && !viaLoopback;
      if (pasteBack) this.deps.trail("connect.fallback", { tile: target.tile, from: instance.instanceId, to: "redirect", port: loopback?.port ?? null });
      const code = !viaLoopback && method === "device-code" && isDeviceSignInCode(provider, auth.userCode) && auth.userCode ? auth.userCode : null;
      link = viaLoopback ? httpsLink(loopback!.authorizationUrl)
        : method === "browser-pkce" ? chatgptPlanLink(auth.authorizationUrl)
          : method === "paste-code" || method === "browser" ? httpsLink(auth.authorizationUrl)
            : deviceSignInLink(provider, auth.authorizationUrl, code ?? undefined);
      const kind: WaitKind = pasteBack ? "redirect" : viaLoopback ? (method === "browser" ? "callback" : "browser")
        : method === "browser-pkce" ? "browser" : method === "paste-code" ? "paste" : method === "browser" ? "callback" : "device";
      // a device code shows first: the person copies it, then opens the page with one press (Copy code and open)
      const opened = link && !code ? await this.deps.open(link).catch(() => false) : false;
      if (signal.aborted) return;
      this.deps.trail("connect.open", { tile: target.tile, instance: instance.instanceId, opened, again: false });
      this.flowId = auth.flowId;
      this.set({ stage: "waiting", since: this.now(), kind, flowId: auth.flowId, link, code, opened }, run);
      const waitingOn = instance;
      await this.within("waiting", signal, (stageSignal) => this.wait(run, stageSignal, waitingOn, auth.flowId!, kind, provider, target));
      this.closeRelay();
      await this.confirm(run, signal, target, false);
    } catch (cause) {
      this.closeRelay();
      if (signal.aborted || run !== this.run) return;
      const current = this.state.stage;
      const at = (cause instanceof StageEnded && cause.waking ? "waking" : STAGES.includes(current) ? current : "preparing") as ConnectStageName;
      const reason: FailReason = cause instanceof StageEnded ? cause.reason : "error";
      const message = cause instanceof StageEnded ? cause.detail : messageOf(cause);
      this.set({ stage: "failed", at, reason, message, link }, run);
      if (at === "waiting") this.cancelServerFlow();
    }
  }

  /** Asks for the provider's browser sign-in when this desktop can relay it; a CLI whose browser sign-in did not
   * start, or a loopback this computer cannot listen on, gets its device-code sign-in instead. */
  private async browserStart(candidate: ConnectInstance, browser: boolean, startOnce: (candidate: ConnectInstance, browser: boolean) => Promise<StartAnswer>, signal: AbortSignal): Promise<StartAnswer> {
    if (!browser || candidate.authentication?.method !== "device-code") return startOnce(candidate, browser);
    let answer: StartAnswer;
    try {
      answer = await startOnce(candidate, true);
    } catch (cause) {
      if (signal.aborted || (cause as { status?: number }).status === 403) throw cause;
      this.deps.trail("connect.fallback", { tile: this.target?.tile, from: candidate.instanceId, to: "device" });
      return startOnce(candidate, false);
    }
    const loopback = answer.auth.loopback;
    if (!loopback || answer.auth.phase !== "waiting" || answer.sameMachine || await this.openRelay(loopback)) return answer;
    if (answer.auth.flowId) await this.deps.api(`/api/instances/${encodeURIComponent(candidate.instanceId)}/auth/cancel`, { method: "POST", body: JSON.stringify({ flowId: answer.auth.flowId }) }).catch(() => {});
    this.deps.trail("connect.fallback", { tile: this.target?.tile, from: candidate.instanceId, to: "device" });
    return startOnce(candidate, false);
  }

  private async openRelay(loopback: Loopback): Promise<boolean> {
    if (this.relayPort === loopback.port) return true;
    const relay = this.deps.relay;
    if (!relay) return false;
    this.closeRelay();
    const ok = await relay.open(loopback.port, loopback.path).catch(() => false);
    if (ok) this.relayPort = loopback.port;
    return ok;
  }

  /** The browser came back to this computer's loopback: the workspace's CLI gets it and finishes the sign-in. */
  private async relayed(run: number, signal: AbortSignal, base: string, flowId: string, quiet: { relaying: boolean }): Promise<void> {
    const port = this.relayPort;
    const relay = this.deps.relay;
    if (port === null || !relay) return new Promise<void>(() => {});
    const callbackUrl = await relay.next(port);
    if (!callbackUrl || signal.aborted) return new Promise<void>(() => {});
    quiet.relaying = true;
    this.set({ stage: "confirming", since: this.now() }, run);
    try {
      const done = await this.deps.api<{ location?: string }>(`${base}/auth/complete`, { method: "POST", body: JSON.stringify({ flowId, callbackUrl }), signal });
      await relay.done(port, { ok: true, location: done?.location ?? null }).catch(() => {});
    } catch (cause) {
      await relay.done(port, { ok: false }).catch(() => {});
      throw cause;
    } finally {
      if (this.relayPort === port) this.relayPort = null;
    }
  }

  private cancelServerFlow(): void {
    const state = this.state;
    if (state.stage !== "failed" || state.at !== "waiting" || !this.instanceId || !this.flowId) return;
    void this.deps.api(`/api/instances/${encodeURIComponent(this.instanceId)}/auth/cancel`, { method: "POST", body: JSON.stringify({ flowId: this.flowId }) }).catch(() => {});
  }

  /** Until the sign-in finishes: polling the server's flow, or the AI's status for a callback, or the pasted code. */
  private async wait(run: number, signal: AbortSignal, instance: ConnectInstance, flowId: string, kind: WaitKind, provider: DeviceSignInProvider, target: ConnectTarget): Promise<void> {
    const base = `/api/instances/${encodeURIComponent(instance.instanceId)}`;
    if (kind === "paste" || kind === "redirect") return this.pasted(run, signal, base, flowId, kind, provider, target);
    const quiet = { relaying: false };
    const polling = new AbortController();
    const stopPolling = () => polling.abort();
    signal.addEventListener("abort", stopPolling, { once: true });
    const relayed = this.relayed(run, signal, base, flowId, quiet);
    relayed.catch(() => {});
    try {
      await Promise.race([relayed, this.poll(run, polling.signal, base, flowId, kind, provider, target, quiet)]);
    } finally {
      polling.abort();
      signal.removeEventListener("abort", stopPolling);
    }
  }

  /** A pasted code or address; a redirect wait also ends when the sign-in reached the CLI by itself after all. */
  private async pasted(run: number, signal: AbortSignal, base: string, flowId: string, kind: "paste" | "redirect", provider: DeviceSignInProvider, target: ConnectTarget): Promise<void> {
    const polling = new AbortController();
    const stopPolling = () => polling.abort();
    signal.addEventListener("abort", stopPolling, { once: true });
    const waiting = this.state;
    try {
      const byItself = kind === "redirect"
        ? this.poll(run, polling.signal, base, flowId, "callback", provider, target, { relaying: false }).then(() => null)
        : new Promise<null>(() => {});
      byItself.catch(() => {});
      for (;;) {
        const typed = new Promise<string>((resolve, reject) => {
          this.pasteDone = resolve;
          signal.addEventListener("abort", () => reject(new StageEnded("timeout")), { once: true });
        });
        const value = await Promise.race([typed, byItself]);
        this.pasteDone = null;
        if (value === null) return;
        this.set({ stage: "confirming", since: this.now() }, run);
        const body = kind === "redirect" ? { flowId, callbackUrl: value } : { flowId, code: value };
        try {
          await this.deps.api(`${base}/auth/complete`, { method: "POST", body: JSON.stringify(body), signal });
          return;
        } catch (cause) {
          // 400: the server turned the paste away before using it, so the same sign-in still takes another one
          if (signal.aborted || (cause as { status?: number }).status !== 400 || waiting.stage !== "waiting") throw cause;
          this.set({ ...waiting, since: this.now(), problem: messageOf(cause) }, run);
        }
      }
    } finally {
      polling.abort();
      signal.removeEventListener("abort", stopPolling);
    }
  }

  private async poll(run: number, signal: AbortSignal, base: string, flowId: string, kind: WaitKind, provider: DeviceSignInProvider, target: ConnectTarget, quiet: { relaying: boolean }): Promise<void> {
    let missed = 0;
    for (;;) {
      await sleep(POLL_MS, signal);
      if (quiet.relaying) continue;
      try {
        if (kind === "callback") {
          if (this.find(await this.deps.refresh(), target).reused) return;
          missed = 0;
          continue;
        }
        const { auth } = await this.deps.api<{ auth: { phase: string; message?: string; userCode?: string; authorizationUrl?: string | null } }>(
          `${base}/auth/status?flowId=${encodeURIComponent(flowId)}`, { signal });
        missed = 0;
        if (auth.phase === "succeeded") return;
        if (auth.phase === "expired") throw new StageEnded("timeout");
        if (auth.phase !== "waiting") throw new StageEnded("error", auth.message ?? null);
        const state = this.state;
        if (state.stage === "waiting" && isDeviceSignInCode(provider, auth.userCode) && auth.userCode !== state.code) {
          this.set({ ...state, code: auth.userCode, link: deviceSignInLink(provider, auth.authorizationUrl, auth.userCode) ?? state.link }, run);
        }
      } catch (cause) {
        if (cause instanceof StageEnded || signal.aborted) throw cause;
        if (wakingError(cause)) continue;
        if (++missed >= LOST_AFTER) throw new StageEnded("lost");
      }
    }
  }

  /** The sign-in finished: read the AI again until it says it is ready. */
  private async confirm(run: number, signal: AbortSignal, target: ConnectTarget, reused: boolean): Promise<void> {
    if (this.state.stage !== "confirming") this.set({ stage: "confirming", since: this.now() }, run);
    await this.within("confirming", signal, async (stageSignal) => {
      for (;;) {
        const found = this.find(await this.deps.refresh().catch(() => []), target);
        if (found.reused) return;
        await sleep(POLL_MS, stageSignal);
      }
    });
    this.set({ stage: "connected", reused }, run);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); };
    signal.addEventListener("abort", stop, { once: true });
  });
}
