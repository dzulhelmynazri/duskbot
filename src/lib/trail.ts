// The renderer's side of the debug trail (electron/trail.mjs): what the person did (controls by their locale key, never
// what they typed), where they went, and how the screen and take-over connected. Events are batched to main over IPC,
// where they are redacted again and written beside main's own. Outside the desktop app (a browser, the phone) nothing
// is recorded. Nothing here may throw into the page.
import { en, type LocaleKey } from "@/locales";
import { activeLocale, t } from "@/lib/i18n";

export const TRAIL_HEADER = "x-madani-trail";
export const TRAIL_EXPORT_PREVIEW_KEY = "settings.usageLog.preview";

type Value = string | number | boolean | null | undefined | { [key: string]: string | number | boolean | null | undefined };
export type TrailFields = Record<string, Value>;

const FLUSH_MS = 500;
const MAX_QUEUE = 500;
let queue: Array<{ ev: string; ts: string } & TrailFields> = [];
let timer: ReturnType<typeof setTimeout> | null = null;

const bridge = () => (typeof window === "undefined" ? undefined : window.madaniDesktop?.trail);

export function trailAvailable(): boolean {
  return Boolean(bridge());
}

function flush(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const batch = queue;
  queue = [];
  if (!batch.length) return;
  try { bridge()?.write(batch); } catch { /* the trail never breaks the page */ }
}

/** records one event; a no-op outside the desktop app */
export function trail(ev: string, fields: TrailFields = {}): void {
  try {
    if (!bridge() || !/^[a-z][a-z0-9_.-]{0,63}$/.test(ev)) return;
    if (queue.length >= MAX_QUEUE) return;
    queue.push({ ...fields, ev, ts: new Date().toISOString() });
    if (queue.length >= 100) flush();
    else if (!timer) timer = setTimeout(flush, FLUSH_MS);
  } catch { /* never */ }
}

/** a short random id for one action, sent as x-madani-trail so the server's trail names the same action */
export function newTrailId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function trailHeaders(cid: string | undefined): Record<string, string> {
  return cid ? { [TRAIL_HEADER]: cid } : {};
}

/** a stable error code and its message (scrubbed again in main) */
export function trailError(code: string, error: unknown, fields: TrailFields = {}): void {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  trail("error", { code, msg: message.slice(0, 300), ...fields });
}

// ---- naming a control without reading what a person wrote ----

let labels: { locale: string; byText: Map<string, LocaleKey> } | null = null;
/** the locale key whose text this is, in the language the page shows: only words the app itself wrote match */
export function uiKeyFor(text: string | null | undefined): LocaleKey | null {
  const wanted = text?.replace(/\s+/g, " ").trim().toLowerCase();
  if (!wanted || wanted.length > 80) return null;
  const locale = activeLocale();
  if (labels?.locale !== locale) {
    const byText = new Map<string, LocaleKey>();
    for (const key of Object.keys(en) as LocaleKey[]) {
      const shown = t(key).replace(/\s+/g, " ").trim().toLowerCase();
      if (shown && !shown.includes("{") && !byText.has(shown)) byText.set(shown, key);
    }
    labels = { locale, byText };
  }
  return labels.byText.get(wanted) ?? null;
}

const CONTROL = "button,[role=button],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=switch],[role=option],[role=link],a[href],summary,input[type=checkbox],input[type=radio],select";

/** what a control is called: its data-trail or test id, else the locale key of its label; never free text */
export function controlName(element: Element): string {
  const own = element.getAttribute("data-trail") ?? element.getAttribute("data-testid");
  if (own) return own.slice(0, 60);
  for (const text of [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent]) {
    const key = uiKeyFor(text);
    if (key) return key;
  }
  const labelled = element.getAttribute("aria-labelledby");
  if (labelled) {
    const key = uiKeyFor(document.getElementById(labelled.split(/\s+/)[0] ?? "")?.textContent);
    if (key) return key;
  }
  // unnamed: where it sits is still useful (the nearest marked region)
  const region = element.closest("[data-trail],[data-testid]");
  return region ? `in:${(region.getAttribute("data-trail") ?? region.getAttribute("data-testid") ?? "").slice(0, 50)}` : "unnamed";
}

function dialogName(element: Element): string {
  const own = element.getAttribute("data-trail") ?? element.getAttribute("data-testid");
  if (own) return own.slice(0, 60);
  const labelled = element.getAttribute("aria-labelledby");
  const text = element.getAttribute("aria-label") ?? (labelled ? document.getElementById(labelled.split(/\s+/)[0] ?? "")?.textContent : null);
  return uiKeyFor(text) ?? "unnamed";
}

let installed = false;
/** clicks on controls, dialogs opening and closing, page errors; installed once by the app's root */
export function installTrailCapture(): void {
  if (installed || typeof document === "undefined" || !bridge()) return;
  installed = true;
  document.addEventListener("click", (event) => {
    try {
      const target = event.target instanceof Element ? event.target.closest(CONTROL) : null;
      if (!target) return;
      const role = target.getAttribute("role") ?? target.tagName.toLowerCase();
      // a switch or checkbox names the state it is turning to (the click lands before it flips)
      const checked = target.getAttribute("aria-checked") ?? (target instanceof HTMLInputElement ? String(!target.checked) : null);
      trail("ui.click", { control: controlName(target), role, ...(checked === "true" || checked === "false" ? { to: checked !== "true" } : {}) });
    } catch { /* never */ }
  }, { capture: true, passive: true });

  const open = new WeakSet<Element>();
  const names = new WeakMap<Element, string>();
  const seen = () => {
    try {
      const now = new Set(document.querySelectorAll("[role=dialog],[role=alertdialog],dialog[open]"));
      for (const dialog of now) if (!open.has(dialog)) { open.add(dialog); names.set(dialog, dialogName(dialog)); trail("ui.dialog.open", { dialog: names.get(dialog) }); }
      for (const dialog of tracked) if (!now.has(dialog) || !dialog.isConnected) { tracked.delete(dialog); open.delete(dialog); trail("ui.dialog.close", { dialog: names.get(dialog) ?? "unnamed" }); }
      for (const dialog of now) tracked.add(dialog);
    } catch { /* never */ }
  };
  const tracked = new Set<Element>();
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; seen(); });
  }).observe(document.body, { childList: true, subtree: true });

  window.addEventListener("error", (event) => trailError("renderer.error", event.error ?? event.message, { at: event.filename ? event.filename.replace(/[?#].*$/, "").split("/").slice(-1)[0] : undefined }));
  window.addEventListener("unhandledrejection", (event) => trailError("renderer.unhandled-rejection", event.reason));
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
}

let lastPage = "";
/** the page or settings place the person is on now; repeated calls with the same place say nothing */
export function trailNavigation(page: string, fields: TrailFields = {}): void {
  const key = `${page}|${JSON.stringify(fields)}`;
  if (key === lastPage) return;
  lastPage = key;
  trail("ui.nav", { page, ...fields });
}

/** Support and Settings > advanced: the scrubbed usage log, saved where the person picks, then offered to support */
export async function exportUsageLog(from: string): Promise<{ saved: boolean; sent: boolean } | null> {
  const desktop = bridge();
  if (!desktop) return null;
  trail("ui.export", { from });
  flush();
  return desktop.exportUsageLog();
}

// ---- requests and screens ----

const SAFE_VALUE = /^[a-z0-9][a-z0-9_.:-]{0,30}$/;
const PERSONAL = /name|title|prompt|instruction|description|about|persona|avatar|email|note|path|folder|url|host|key|token|secret|password|text/i;

/** the keys a settings write changed, and the new value of each that is a switch, a number or a short choice */
export function settingsChange(body: unknown): { key: string; values: Record<string, string | number | boolean | null> } | null {
  let parsed: unknown = body;
  if (typeof body === "string") { try { parsed = JSON.parse(body); } catch { return null; } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const values: Record<string, string | number | boolean | null> = {};
  const keys = Object.keys(parsed).slice(0, 10);
  for (const key of keys) {
    const value = (parsed as Record<string, unknown>)[key];
    if (PERSONAL.test(key)) continue;
    if (typeof value === "boolean" || value === null || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && SAFE_VALUE.test(value))) values[key] = value as string | number | boolean | null;
  }
  return { key: keys.join(","), values };
}

/** every request that changes something (never a read): method, path without its query, status and time; a failed one is an error */
export function trailApiCall(path: string, method: string, status: number, startedAt: number, body: unknown, cid?: string | null, error?: unknown): void {
  try {
    if (!bridge() || method === "GET" || method === "HEAD") return;
    const bare = path.replace(/[?#].*$/, "");
    const ms = Math.round(performance.now() - startedAt);
    // the caller let the request go (a send confirmed over the live stream drops its own POST): not a failure
    const cancelled = !status && (error as { name?: unknown } | null)?.name === "AbortError";
    const base = { method, path: bare, status, ms, ok: status >= 200 && status < 400, ...(cancelled ? { cancelled: true } : {}), ...(cid ? { cid } : {}) };
    const connector = /^\/api\/connectors\/([\w.-]+)\/(authorize|accounts)/.exec(bare);
    if (connector) trail(connector[2] === "authorize" ? "apps.connect" : "apps.disconnect", { ...base, app: connector[1] });
    else if (bare === "/api/config" && (method === "PUT" || method === "PATCH")) trail("settings.change", { ...base, ...settingsChange(body) });
    else trail("api.call", base);
    if (!cancelled && (!status || status >= 500)) trailError(status ? "api.server-error" : "api.unreachable", error ?? `${status}`, { method, path: bare, status });
  } catch { /* never */ }
}

type Screen = { target: string; path: string; fallback?: string; at: string };
let screen: Screen | null = null;
/** how the live desktop last connected: webrtc (direct or cloudflare-turn) or the websocket over the link */
export function noteScreen(target: string, path: string, fallback?: string): void {
  screen = { target: target.startsWith("vps/") ? "vps" : "vm", path, ...(fallback ? { fallback } : {}), at: new Date().toISOString() };
}
export function lastScreen(): Screen | undefined {
  return screen ?? undefined;
}
