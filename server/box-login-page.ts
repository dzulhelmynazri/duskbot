// fill_login on a bot's own desktop: the page in front of its Chromium, reached over that box's DevTools relay. Reads run in
// an isolated world the page's scripts cannot see or patch, and typing goes to that page's own renderer as real input, so
// nothing lands in another window of the desktop. The password is only ever an Input.insertText argument.
import { CdpConnection, type CdpSession, type Params } from "./browser/cdp/connection.ts";
import { webSocketTransport } from "./browser/cdp/transport.ts";
import type { FillLoginDeps } from "./login-fill.ts";

export type LoginInput = Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click">;

export interface BoxLoginPage {
  input: LoginInput;
  url: string;
  close(): void;
}

const WORLD = "madani-login";
const VERSION_ATTEMPTS = 4;
const VERSION_RETRY_MS = 1_500;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface BoxLoginOptions {
  /** Throws when the person took the computer back; asked before every keystroke and click. */
  guard?: () => void;
  fetch?: Fetch;
  connect?: (wsUrl: string) => Promise<CdpConnection>;
  sleep?: (ms: number) => Promise<void>;
}

/** The DevTools socket of the Chromium behind a loopback relay, waiting for one that is still starting. */
export async function boxChromeSocket(httpUrl: string, options: Pick<BoxLoginOptions, "fetch" | "sleep"> = {}): Promise<string> {
  const fetchJson = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = new URL(httpUrl);
  let last = "it did not answer";
  for (let attempt = 0; attempt < VERSION_ATTEMPTS; attempt++) {
    if (attempt) await sleep(VERSION_RETRY_MS);
    try {
      const answer = await fetchJson(new URL("/json/version", base).toString(), { signal: AbortSignal.timeout(8_000) });
      const body = answer.ok ? await answer.json() as { webSocketDebuggerUrl?: unknown } : null;
      const socket = typeof body?.webSocketDebuggerUrl === "string" ? new URL(body.webSocketDebuggerUrl) : null;
      if (socket) {
        // the box names its own loopback port; the relay is this server's
        socket.host = base.host;
        socket.protocol = base.protocol === "https:" ? "wss:" : "ws:";
        return socket.toString();
      }
      last = "it gave no DevTools address";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`The desktop's Chromium did not start (${last}).`);
}

async function defaultConnect(wsUrl: string): Promise<CdpConnection> {
  return new CdpConnection(await webSocketTransport(wsUrl), { defaultTimeoutMs: 10_000 });
}

type TargetInfo = { targetId: string; type: string; url: string; attached?: boolean };

const PAGE_URL = /^(?:https?:|about:blank)/iu;

class PageWorld {
  private context: number | null = null;
  readonly session: CdpSession;
  constructor(session: CdpSession) { this.session = session; }

  private async world(): Promise<number> {
    if (this.context !== null) return this.context;
    await this.session.send("Page.enable");
    const tree = await this.session.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const made = await this.session.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false });
    this.context = made.executionContextId;
    return this.context;
  }

  /** A navigation drops the world, so a stale one is made again once. */
  async evaluate(expression: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        const contextId = await this.world();
        const result = await this.session.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error("the page script failed");
        return result.result?.value;
      } catch (error) {
        this.context = null;
        if (attempt >= 1) throw error;
      }
    }
  }
}

async function attach(connection: CdpConnection, targetId: string): Promise<CdpSession> {
  const { sessionId } = await connection.root.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  for (let tick = 0; tick < 20; tick++) {
    const session = connection.session(sessionId);
    if (session) return session;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the page did not accept a DevTools session");
}

const FRONT = `JSON.stringify({ visible: document.visibilityState === "visible", focused: document.hasFocus() })`;

/** The tab a person looking at the desktop sees: the focused window's, else the only one showing. */
async function frontPage(connection: CdpConnection): Promise<{ target: TargetInfo; session: CdpSession; world: PageWorld } | { refusal: string }> {
  const { targetInfos } = await connection.root.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  const pages = targetInfos.filter((target) => target.type === "page" && PAGE_URL.test(target.url));
  if (!pages.length) return { refusal: "Chromium on your computer has no page open. Open the site's login page there first, then call fill_login." };
  const seen: Array<{ target: TargetInfo; session: CdpSession; world: PageWorld; visible: boolean; focused: boolean }> = [];
  for (const target of pages) {
    let session: CdpSession;
    try { session = await attach(connection, target.targetId); } catch { continue; }
    const world = new PageWorld(session);
    let state: { visible?: unknown; focused?: unknown } = {};
    try { state = JSON.parse(String(await world.evaluate(FRONT))) as typeof state; } catch {}
    seen.push({ target, session, world, visible: state.visible === true, focused: state.focused === true });
  }
  const visible = seen.filter((page) => page.visible);
  const chosen = visible.find((page) => page.focused) ?? (visible.length === 1 ? visible[0] : undefined) ?? (seen.length === 1 ? seen[0] : undefined);
  for (const page of seen) if (page !== chosen) void connection.root.send("Target.detachFromTarget", { sessionId: page.session.id }).catch(() => undefined);
  if (!chosen) return { refusal: "Several Chromium windows show a page on your computer and none is in front. Click the login page's window once (or close the others), then call fill_login again." };
  return chosen;
}

const KEYS: Record<string, Params> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" },
};

/** Its centre, once it is scrolled into view and is what a click there would hit. */
const CLICK_POINT = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!(el instanceof Element)) return JSON.stringify({ found: false });
  try { el.scrollIntoView({ block: "center" }); } catch {}
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2, y = box.top + box.height / 2;
  const hit = document.elementFromPoint(x, y);
  return JSON.stringify({ found: true, x, y, hit: Boolean(hit && (hit === el || el.contains(hit))) });
})()`;

/** The front page of the Chromium a relay at `httpUrl` reaches, as fill_login's reads and typing. */
export async function openBoxLoginPage(httpUrl: string, options: BoxLoginOptions = {}): Promise<BoxLoginPage | { refusal: string }> {
  const guard = options.guard ?? (() => undefined);
  const socket = await boxChromeSocket(httpUrl, options);
  const connection = await (options.connect ?? defaultConnect)(socket);
  let front: Awaited<ReturnType<typeof frontPage>>;
  try {
    front = await frontPage(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
  if ("refusal" in front) {
    connection.close();
    return front;
  }
  const { target, session, world } = front;
  const href = async () => {
    const { targetInfo } = await connection.root.send<{ targetInfo: TargetInfo }>("Target.getTargetInfo", { targetId: target.targetId });
    return targetInfo.url;
  };
  const input: LoginInput = {
    engine: async (args) => {
      if (session.detached) return null;
      if (args[0] === "get" && args[1] === "url") return { url: await href() };
      if (args[0] === "eval" && typeof args[1] === "string") return { result: await world.evaluate(args[1]) };
      return null;
    },
    insertText: async (text) => {
      guard();
      await session.send("Input.insertText", { text });
    },
    press: async (key) => {
      const spec = KEYS[key];
      if (!spec) throw new Error(`fill_login cannot press ${key} here`);
      guard();
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...spec });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...spec, text: undefined, unmodifiedText: undefined });
    },
    click: async (selector) => {
      const point = JSON.parse(String(await world.evaluate(CLICK_POINT(selector)))) as { found?: boolean; x?: number; y?: number; hit?: boolean };
      if (!point.found || !point.hit || typeof point.x !== "number" || typeof point.y !== "number") throw new Error("the sign-in button could not be clicked");
      guard();
      const at = { x: point.x, y: point.y, button: "left", clickCount: 1 };
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
      await session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
      await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
    },
  };
  return {
    input,
    url: target.url,
    close: () => {
      void connection.root.send("Target.detachFromTarget", { sessionId: session.id }).catch(() => undefined).finally(() => connection.close());
    },
  };
}
