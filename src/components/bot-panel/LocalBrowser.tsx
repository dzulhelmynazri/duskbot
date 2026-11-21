import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence } from "motion/react";
import { Hand, Loader2 } from "../../icons";

import { resolveAddressBarInput } from "@/lib/browser-address";
import { browserStreamAccess, createPreviewStreamClient, type PreviewStreamClient, type PreviewStreamControl, type PreviewStreamInput } from "@/lib/browser-stream-client";
import { createLiveStreamClient, type LiveResume } from "@/lib/browser-stream-v1";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { phoneApp } from "@/lib/store-app";
import {
  blankPage, browserHeadline, closeLocalBrowser, keepView, keptKey, keptView, localBrowserFixture, useLocalBrowser,
} from "@/lib/local-browser";
import { usePageVisible } from "@/lib/page-visible";
import { panelRest, panelWide, setPanelWide, usePanelWidth } from "@/lib/panel-wide";
import { browserScope, withBrowserScope } from "@/lib/team-browser";
import { api, useStore, type Bot } from "@/state/store";
import { BROWSER_HELD_ELSEWHERE } from "../../../shared/browser-held";
import type { BrowserNav } from "../browser/ChromeRow";
import { StreamSurface, type SurfaceConnect } from "../browser/StreamSurface";
import { BrowserHeader, BrowserToolbar, FRAME_TONE, StartPill, TabStrip, tabName, type StripTab } from "./browser-strip";
import { buttonCls } from "./rows";
import { BOT_PANEL_ID } from "./side-panel";
import { permissionsMissing, type MacPermissionsBridge } from "@/lib/mac-permissions";
import { MacPermissionsDialog } from "../onboarding/PermissionsStep";
import { useScreenAccessMissing } from "../ScreenAccessNotice";

const NO_NAV: BrowserNav = { url: "", loading: false, canGoBack: false, canGoForward: false };
/** What a new browser and a new tab open on. */
export const START_PAGE = "https://www.google.com/";
/** The pill opening into the browser, and the browser's frame closing back onto its first line. */
const MORPH_MS = 350;
const MORPH_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** A tab change, page load or pointer the person did not cause within this long counts as the bot's. */
const PERSON_ECHO_MS = 2_500;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const canAnimate = () => typeof Element !== "undefined" && typeof Element.prototype.animate === "function";

function tabsOf(value: unknown): StripTab[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tab) => tab && typeof tab === "object" && typeof tab.tabId === "string"
    ? [{ tabId: tab.tabId, title: typeof tab.title === "string" ? tab.title : "", url: typeof tab.url === "string" ? tab.url : "", active: tab.active === true, ...(tab.held === true ? { held: true } : {}) }]
    : []);
}

/** The page as painted, kept for the next time this view opens. */
function snapshot(box: HTMLElement | null): string | null {
  const canvas = box?.querySelector("canvas");
  if (!canvas || !canvas.width || !canvas.height) return null;
  try { return canvas.toDataURL("image/jpeg", 0.8); } catch { return null; }
}

function fixtureTabs(): StripTab[] | null {
  const fixture = localBrowserFixture();
  const tabs = fixture?.tabs;
  return tabs ? tabs.map((tab, at) => ({ tabId: `t${at + 1}`, title: tab.title, url: tab.url, active: at === 0, ...(fixture?.held === at ? { held: true } : {}) })) : null;
}

/** The gallery's stand-in for the browser: tab changes apply to its own list, as the server's next tabs message would. */
function fixtureInput(tabs: readonly StripTab[], input: PreviewStreamInput): StripTab[] {
  const front = (id: string) => tabs.map((tab) => ({ ...tab, active: tab.tabId === id }));
  if (input.type === "tabSelect") return front(input.tabId);
  if (input.type === "tabNew") return [...tabs.map((tab) => ({ ...tab, active: false })), { tabId: `n${Date.now().toString(36)}`, title: "", url: input.url ?? "about:blank", active: true }];
  if (input.type === "tabClose") {
    const at = tabs.findIndex((tab) => tab.tabId === input.tabId);
    const rest = tabs.filter((tab) => tab.tabId !== input.tabId);
    if (!tabs[at]?.active || rest.length === 0) return rest;
    const next = rest[Math.min(at, rest.length - 1)]!;
    return rest.map((tab) => ({ ...tab, active: tab.tabId === next.tabId }));
  }
  if (input.type === "navigate") return tabs.map((tab) => (tab.active ? { ...tab, url: input.url, title: "" } : tab));
  if (input.type === "releaseControl") return tabs.map(({ held: _held, ...tab }) => tab);
  return [...tabs];
}

/** The gallery's page: its tab's own last screen, as the server would stream it. */
function FixturePage({ tab }: { tab: StripTab | null }) {
  const image = localBrowserFixture()?.tabs?.find((one) => one.url === tab?.url)?.image;
  return image ? <img src={image} alt="" className="absolute inset-0 size-full object-cover object-top" /> : null;
}

/** Where the pill stood, for the browser to open from. */
export interface MorphFrom { top: number; left: number; width: number; height: number }

/**
 * The bot's browser while it runs: a line saying who is using it, its tabs, back, forward, reload and the address, and the
 * live page, which the person uses together with the bot. Expand widens the panel beside the chat; at the panel's own
 * width the page is too small to aim at, so a click on it expands. What it last showed is kept, so coming back paints at
 * once and goes live after.
 */
export function LocalBrowserLive({ bot, from, started = false, onClosed, onEnded }: {
  bot: Bot; from?: MorphFrom | null;
  /** The person started this browser with Start browser, so a browser with nothing open yet shows the start page. */
  started?: boolean;
  /** The person closed it. */
  onClosed: () => void;
  /** The browser closed while shown (idle, or elsewhere). */
  onEnded: () => void;
}) {
  const { state } = useStore();
  const [fallback, setFallback] = useState(false);
  const stream = state.config?.browserEngine?.engine === "chrome" && !fallback;
  const scopedThread = browserScope(state.config?.team, bot.threadId).threadId;
  const key = keptKey(bot.id, bot.threadId);
  const fixture = localBrowserFixture();
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const [painted, setPainted] = useState(false);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [tabs, setTabs] = useState<readonly StripTab[]>(() => fixtureTabs() ?? (from ? [] : keptView(key).tabs ?? []));
  // the tabs this connection's browser announced: until then a tab id may be the last session's, which it refuses
  const [heard, setHeard] = useState(false);
  const opening = useRef<{ quiet: boolean; done: boolean }>({ quiet: false, done: !started });
  const [nav, setNav] = useState<BrowserNav>(NO_NAV);
  const [picked, setPicked] = useState<string | null>(null);
  const [closingTabs, setClosingTabs] = useState<ReadonlySet<string>>(() => new Set());
  const [frame] = useState(() => keptView(key).frame ?? null);
  const [error, setError] = useState("");
  const [closing, setClosing] = useState(false);
  const [actedAt, setActedAt] = useState<number | null>(null);
  const wide = usePanelWidth() > panelRest();
  const pageVisible = usePageVisible();
  const clientRef = useRef<PreviewStreamClient | null>(null);
  const controlRef = useRef<PreviewStreamControl | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const insideRef = useRef<HTMLDivElement | null>(null);
  const resume = useRef<LiveResume & { key: string }>({ key: "", viewer: "" });
  const personAt = useRef(0);
  const connectedAt = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const latest = useRef({ onClosed, onEnded });
  latest.current = { onClosed, onEnded };

  const connect = useCallback<SurfaceConnect>((target, events) => {
    // together: the person's input runs beside the bot's work, taking no hold
    const scope: Record<string, string> = scopedThread ? { threadId: scopedThread } : {};
    const together = { ...scope, together: "1" };
    if (stream) return createPreviewStreamClient({ access: browserStreamAccess(bot.id, window.location, together), ...target }, events);
    const resumeKey = `${bot.id}\n${bot.browserProfile ?? ""}${scopedThread ? `\n${scopedThread}` : ""}`;
    if (resume.current.key !== resumeKey) resume.current = { key: resumeKey, viewer: "" };
    return createLiveStreamClient(bot.id, events, (body, viewerId) => api(withBrowserScope(`/api/bots/${encodeURIComponent(bot.id)}/browser/action`, scope), {
      method: "POST", body: JSON.stringify({ ...body, viewerId }), timeoutMs: 120_000,
    }), resume.current, together, { width: target.width, height: target.height });
  }, [bot.id, bot.browserProfile, scopedThread, stream]);

  const send = useCallback((input: PreviewStreamInput) => {
    personAt.current = Date.now();
    if (fixture) { setTabs((current) => fixtureInput(current, input)); return true; }
    if (clientRef.current?.send(input)) { setError(""); return true; }
    if (controlRef.current?.controller === "another-viewer") setError(BROWSER_HELD_ELSEWHERE);
    return false;
  }, [fixture]);
  const onControl = useCallback((next: PreviewStreamControl | null) => { controlRef.current = next; setControl(next); }, []);
  const onClient = useCallback((client: PreviewStreamClient | null) => { clientRef.current = client; }, []);
  const botActed = useCallback(() => {
    const now = Date.now();
    if (now - personAt.current < PERSON_ECHO_MS || now - connectedAt.current < PERSON_ECHO_MS) return;
    setActedAt(now);
  }, []);
  const onMessage = useCallback((message: Readonly<Record<string, unknown>>) => {
    if (message.type === "tabs") {
      const next = tabsOf(message.tabs);
      setTabs(next);
      setHeard(true);
      // a browser with nothing open yet shows the start page, once; a failure there is the view's own, never a toast
      if (!opening.current.done && next.length > 0 && next.every((tab) => blankPage(tab.url)) && clientRef.current) {
        opening.current = { quiet: true, done: true };
        clientRef.current.send({ type: "navigate", url: START_PAGE });
        setTimeout(() => { opening.current.quiet = false; }, 15_000);
      } else if (next.some((tab) => !blankPage(tab.url))) opening.current.done = true;
      keepView(key, { tabs: next });
      const active = next.find((tab) => tab.active);
      if (active) setNav((current) => ({ ...current, url: active.url }));
      setPicked((chosen) => (chosen === null || chosen === active?.tabId || !next.some((tab) => tab.tabId === chosen) ? null : chosen));
      setClosingTabs((hidden) => (hidden.size && [...hidden].some((id) => !next.some((tab) => tab.tabId === id)) ? new Set([...hidden].filter((id) => next.some((tab) => tab.tabId === id))) : hidden));
      botActed();
    } else if (message.type === "nav" && typeof message.url === "string") {
      setNav({ url: message.url, loading: message.loading === true, canGoBack: message.canGoBack === true, canGoForward: message.canGoForward === true });
      botActed();
    } else if (message.type === "url" && typeof message.url === "string") {
      setNav((current) => ({ ...current, url: message.url as string }));
    } else if (message.type === "pointer") {
      setActedAt(Date.now());
    } else if (message.type === "asleep") {
      latest.current.onEnded();
    }
  }, [key, botActed]);

  // a picked tab shows as chosen at once; one the browser never brought forward lets go
  useEffect(() => {
    if (picked === null) return;
    const timer = setTimeout(() => setPicked(null), 2_500);
    return () => clearTimeout(timer);
  }, [picked]);

  // Leaving the tab, closing the panel or switching bots keeps the last picture for the next open. A layout cleanup runs
  // before the page's own surface lets go of its canvas.
  useLayoutEffect(() => () => {
    const kept = snapshot(screenRef.current);
    if (kept) keepView(key, { frame: kept });
  }, [key]);

  // the panel goes back to its own width when the browser leaves it
  useEffect(() => () => { if (panelWide()) setPanelWide(false); }, []);
  useEffect(() => {
    if (!wide) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable=true]")) return;
      const dialog = target?.closest?.("[role=dialog], [role=alertdialog]");
      if (dialog && dialog.id !== BOT_PANEL_ID) return;
      // Escape narrows the panel back; the panel's own Escape (closing it) waits for the next press
      event.preventDefault();
      event.stopImmediatePropagation();
      setPanelWide(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [wide]);

  // Start browser: the pill grows into the frame, sliding down to its place while the frame opens around it. Once, on mount.
  const openedFrom = useRef(from);
  useLayoutEffect(() => {
    const from = openedFrom.current;
    const section = sectionRef.current, box = frameRef.current, inside = insideRef.current;
    if (!from || !section || !box || !inside || !canAnimate()) return;
    if (reduced()) { section.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" }); return; }
    const rect = box.getBoundingClientRect();
    const dx = from.left - rect.left, dy = from.top - rect.top;
    const right = Math.max(0, rect.width - from.width), bottom = Math.max(0, rect.height - from.height);
    const radius = from.height / 2;
    box.animate([
      { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(0 ${right}px ${bottom}px 0 round ${radius}px)` },
      { transform: "none", clipPath: "inset(0 0 0 0 round 16px)" },
    ], { duration: MORPH_MS, easing: MORPH_EASE });
    inside.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: MORPH_MS, easing: "ease-out" });
    section.querySelector<HTMLElement>("[data-local-browser-header]")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 110, easing: "ease-out", fill: "backwards" });
  }, []);

  const shown = tabs.filter((tab) => !closingTabs.has(tab.tabId));
  const active = shown.find((tab) => tab.active) ?? shown[0] ?? null;
  const selected = picked ?? active?.tabId ?? null;
  const ready = fixture !== null || (connected && heard);
  const heldIds = new Set([...(control?.heldTabs ?? []), ...shown.filter((tab) => tab.held).map((tab) => tab.tabId)]);
  const strip = shown.map((tab) => (heldIds.has(tab.tabId) && !tab.held ? { ...tab, held: true } : tab));
  const heldTab = strip.find((tab) => tab.tabId === selected && tab.held) ?? strip.find((tab) => tab.held) ?? null;
  const shownNav = fixture ? { url: strip.find((tab) => tab.tabId === selected)?.url ?? "", loading: false, canGoBack: true, canGoForward: false } : nav;
  const headline = browserHeadline({ busy: bot.busy === true, turnStartedAt: bot.turnStartedAt ?? undefined, actedAt, working: fixture?.working });
  const lastFrame = keptView(key).frame ?? frame;

  const select = (tab: StripTab) => { setPicked(tab.tabId); if (!send({ type: "tabSelect", tabId: tab.tabId })) setPicked(null); };
  const closeTab = (tab: StripTab) => {
    if (fixture) { send({ type: "tabClose", tabId: tab.tabId }); return; }
    if (send({ type: "tabClose", tabId: tab.tabId })) setClosingTabs((hidden) => new Set(hidden).add(tab.tabId));
  };
  const toggleWide = () => setPanelWide(!wide);
  const closeBrowser = () => {
    if (fixture) { latest.current.onClosed(); return; }
    setClosing(true);
    setError("");
    closeLocalBrowser(bot.id, bot.threadId).then(() => latest.current.onClosed(), () => { setClosing(false); setError(t("localBrowser.closeFailed")); });
  };

  return (
    <section ref={sectionRef} data-local-browser="live" data-wide={wide || undefined} aria-label={t("localBrowser.label", { name: bot.name })} className="flex flex-col gap-1.5">
      <BrowserHeader bot={bot} headline={headline} wide={wide} closing={closing} failed={Boolean(error) && !closing} onExpand={toggleWide} onClose={closeBrowser} />
      <div ref={frameRef} data-local-browser-frame="" className={cn("relative flex w-full flex-col overflow-hidden rounded-[16px] p-1", FRAME_TONE)}>
        <div ref={insideRef} className="flex min-w-0 flex-col">
          {wide && <TabStrip bot={bot} tabs={strip} selected={selected} wide={wide} ready={ready} onSelect={select} onClose={closeTab} onNew={() => send({ type: "tabNew", url: START_PAGE })} />}
          <BrowserToolbar nav={shownNav} ready={ready}
            onHistory={(delta) => send({ type: "history", delta })}
            onReload={() => send({ type: "reload" })}
            onAddress={(text) => {
              const url = resolveAddressBarInput(text);
              if (url) send({ type: "navigate", url });
              else if (text.trim()) setError(t("browser.panel.enterAddress"));
            }} />
          <div ref={screenRef} data-local-browser-page="" className="relative m-1 aspect-[16/10] overflow-hidden rounded-[12px] bg-composer">
            {fixture ? <FixturePage tab={strip.find((tab) => tab.tabId === selected) ?? null} /> : pageVisible ? (
              <div data-local-browser-surface={painted ? "painted" : "waiting"} className={cn("absolute inset-0 flex flex-col transition-opacity duration-150 ease-out", !wide && "pointer-events-none", !painted && "opacity-0")} inert={!wide || undefined}>
                <StreamSurface
                  key={`${attempt}:${stream ? "stream" : "live"}:${bot.browserProfile ?? ""}`}
                  connect={connect}
                  input={send}
                  together
                  label={t("localBrowser.page", { name: bot.name })}
                  onClient={onClient}
                  onControl={onControl}
                  onMessage={onMessage}
                  quietNotice={() => { if (!opening.current.quiet) return false; opening.current.quiet = false; return true; }}
                  onFirstFrame={() => setPainted(true)}
                  onConnectedChange={(next) => { setConnected(next); if (!next) { setHeard(false); setPainted(false); } if (next) { connectedAt.current = Date.now(); setError(""); } }}
                  onUnauthorized={() => { if (stream) setFallback(true); else setAttempt((n) => n + 1); }}
                  onGone={() => { setConnected(false); latest.current.onEnded(); }}
                />
              </div>
            ) : null}
            {!fixture && !painted && lastFrame && (
              <img src={lastFrame} alt="" aria-hidden="true" data-local-browser-kept="" draggable={false} className="pointer-events-none absolute inset-0 size-full object-contain" />
            )}
            {!wide && (
              // the page draws at a desktop's width, too small here to aim at: a click widens the panel, where it is used
              <button type="button" data-local-browser-action="open-page" aria-label={t("localBrowser.expand")} onClick={toggleWide}
                className="absolute inset-0 z-10 cursor-zoom-in focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus max-md:cursor-default" />
            )}
            {!fixture && !connected && !lastFrame && (
              <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-[12px] leading-4 text-ink/[0.56]">
                <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />{t("browser.panel.connecting")}
              </div>
            )}
          </div>
        </div>
      </div>
      {heldTab && (
        <div data-local-browser-held-line="" className="flex min-h-8 items-center gap-2 ps-1">
          <Hand size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-ink-secondary">
            {heldTab.tabId === selected ? t("localBrowser.heldHere") : t("localBrowser.heldThere", { title: tabName(heldTab) })}
          </span>
          <button type="button" data-local-browser-action="hand-back" className={buttonCls} onClick={() => send({ type: "releaseControl" })}>{t("browser.control.handBack")}</button>
        </div>
      )}
      {error && <p role="alert" className="m-0 ps-1 text-[12px] leading-4 text-danger">{error}</p>}
    </section>
  );
}

/** A closed browser: only the gray Start browser pill; its tabs show again once it is open. */
export function LocalBrowserClosed({ bot, pill, starting = false, onStart }: {
  bot: Bot; pill: RefObject<HTMLButtonElement | null>; starting?: boolean; onStart: () => void;
}) {
  return (
    <section data-local-browser="closed" aria-label={t("localBrowser.label", { name: bot.name })} className={cn("flex transition-opacity duration-200 ease-out starting:opacity-0", phoneApp() && "flex-col items-center gap-4 px-6 pb-6 pt-10 text-center")}>
      {phoneApp() && <p className="max-w-[300px] text-[15px] leading-[22px] text-ink-secondary">{t("localBrowser.explain", { name: bot.name })}</p>}
      <StartPill ref={pill} onStart={onStart} disabled={starting} />
    </section>
  );
}

/** What the person did that the server's next answer has not caught up with: started the browser, or closed it (or saw it
 * close). `confirmed`: the server has since said it is closed, so its own answer leads again. */
type Override = { kind: "started"; from: MorphFrom | null } | { kind: "closed"; confirmed: boolean };


/** A bot's browser on this computer in its Computer tab: the live browser while it runs; otherwise the Start browser pill. */
export function LocalBrowserSection({ bot, after, askFirst = null }: {
  bot: Bot; after?: ReactNode;
  /** this Mac's permissions the bot needs, asked for when the person starts its browser while any is off */
  askFirst?: MacPermissionsBridge | null;
}) {
  const { open, known } = useLocalBrowser(bot.id, bot.threadId, bot.browser !== false);
  const [override, setOverride] = useState<Override | null>(null);
  const pill = useRef<HTMLButtonElement | null>(null);
  const below = useRef<HTMLDivElement | null>(null);
  const belowTop = useRef<number | null>(null);
  // what comes after waits for the first answer, briefly, so it never shows alone and is then pushed down
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (known) return;
    const timer = setTimeout(() => setLate(true), 1_500);
    return () => clearTimeout(timer);
  }, [known]);
  useEffect(() => { setOverride(null); }, [bot.id, bot.threadId]);
  // the server's answer catching up: a started browser it reports open, a closed one it reports closed
  useEffect(() => {
    if (override?.kind === "started" && open) setOverride(null);
    if (override?.kind === "closed" && !override.confirmed && !open && known) setOverride({ ...override, confirmed: true });
  }, [override, open, known]);
  // a close the server never reports (a dropped connection, or the bot opened it again at once) lets its answer lead
  const unconfirmed = override?.kind === "closed" && !override.confirmed;
  useEffect(() => {
    if (!unconfirmed) return;
    const timer = setTimeout(() => setOverride((current) => (current?.kind === "closed" && !current.confirmed ? null : current)), 12_000);
    return () => clearTimeout(timer);
  }, [unconfirmed]);

  const live = override?.kind === "started" ? true : override?.kind === "closed" && !override.confirmed ? false : open;

  const openBrowser = () => {
    setAsking(false);
    const box = pill.current?.getBoundingClientRect();
    belowTop.current = below.current?.getBoundingClientRect().top ?? null;
    setOverride({ kind: "started", from: box ? { top: box.top, left: box.left, width: box.width, height: box.height } : null });
  };
  // what the bot needs on this Mac and lacks is asked for first; once all of it is on, the browser opens
  const [asking, setAsking] = useState(false);
  const [checking, setChecking] = useState(false);
  // the helper a copy run from source drives this Mac through reports its own grants
  const helperMissing = useScreenAccessMissing();
  const start = () => {
    if (!askFirst) { openBrowser(); return; }
    if (helperMissing) { setAsking(true); return; }
    setChecking(true);
    void askFirst.status().then((status) => (permissionsMissing(status) ? setAsking(true) : openBrowser()), () => setAsking(true)).finally(() => setChecking(false));
  };
  const ended = (kind: "closed" | "ended") => () => {
    belowTop.current = below.current?.getBoundingClientRect().top ?? null;
    setOverride({ kind: "closed", confirmed: kind === "ended" && !open });
  };

  // what sits below moves with the browser opening or closing above it, instead of jumping
  useLayoutEffect(() => {
    const box = below.current, was = belowTop.current;
    belowTop.current = null;
    if (!box || was === null || reduced() || !canAnimate()) return;
    const dy = was - box.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) box.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: MORPH_MS, easing: MORPH_EASE });
  }, [live]);

  const from = override?.kind === "started" ? override.from : null;
  const wide = usePanelWidth() > panelRest();
  return (
    <>
      {live ? <LocalBrowserLive key={`${bot.id}\n${bot.threadId ?? ""}`} bot={bot} from={from} started={override?.kind === "started"} onClosed={ended("closed")} onEnded={ended("ended")} />
        : known || late || override ? <LocalBrowserClosed bot={bot} pill={pill} starting={checking} onStart={start} /> : null}
      <div ref={below} className="mt-3 empty:hidden">{(known || late) && !wide && after}</div>
      <AnimatePresence>{asking && askFirst && <MacPermissionsDialog key="mac-permissions-dialog" bridge={askFirst} onClose={() => setAsking(false)} onAllowed={openBrowser}
        relaunch={typeof window.madaniDesktop?.relaunch === "function" ? () => void window.madaniDesktop!.relaunch!() : null} />}</AnimatePresence>
    </>
  );
}
