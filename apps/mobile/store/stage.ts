// The phone app on a throwaway fixture, for the store screenshots (capture.ts) and the rendered layout check
// (layout-check.ts), at 440 x 956 points.
//
// It launches a throwaway fixture workspace with the fake engine (scripts/control-madani.ts launch), seeds the team in
// team.mjs, and serves the phone app through vite. A small proxy sits between vite and the fixture and swaps each chat's
// history for the scripted one in team.mjs, so the chats read as written. Nothing reaches a real bot or service.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openHeadlessChrome, type HeadlessPage } from "../../../scripts/testing/headless-chrome.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
/** MADANI_STAGE_TEAM names another team module shaped like team.mjs, for screens the store set does not show */
const { ROOM, ROUTINES, TEAM } = await import(process.env.MADANI_STAGE_TEAM ?? "./team.mjs") as typeof import("./team.mjs");
const RESERVED = new Set([5199, 8799, 5299, 8899, 9335, 5320]);
const work = mkdtempSync(join(tmpdir(), "madani-store-"));
const children = new Set<ChildProcess>();
const MINUTE = 60_000;
/** the apps the team shows as added */
const CONNECTED: Record<string, object> = {
  "/api/connectors/connected": { inventoryComplete: true, services: Object.fromEntries(["gmail", "googlecalendar", "googledrive", "notion", "github"].map((id) => [id, { connected: true }])) },
};

function stopAll() { for (const child of children) child.kill("SIGTERM"); }
process.once("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopAll(); process.exit(1); });

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((done, fail) => {
      const server = net.createServer().once("error", fail).listen(0, "127.0.0.1", () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => done(port));
      });
    });
    if (!RESERVED.has(port)) return port;
  }
}

function launchFixture(replies: Record<string, string>): Promise<string> {
  writeFileSync(join(work, "markers.json"), JSON.stringify(replies));
  writeFileSync(join(work, "tools.json"), "[]");
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-madani.ts", "launch"], {
    cwd: repoRoot,
    env: { ...process.env, FAKE_CLAUDE_MARKER_REPLIES: join(work, "markers.json"), FAKE_CLAUDE_TOOL_CALLS_FILE: join(work, "tools.json"), FAKE_CLAUDE_TOOL_PROGRESS_MS: "600000" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.add(child);
  return new Promise((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error("the fixture printed no URL in 90 seconds")), 90_000);
    child.stdout!.on("data", (chunk) => {
      text += chunk;
      try {
        const info = JSON.parse(text);
        clearTimeout(timer);
        done(info.url);
      } catch {}
    });
    child.once("exit", () => fail(new Error("the fixture exited before it was ready")));
  });
}

async function api(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, base), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

type Bot = { id: string; threadId: string; name: string; color: string };
type Seeded = { bots: Map<string, Bot>; room: { id: string; threadId: string } | null };

async function seed(base: string): Promise<Seeded> {
  const bots = new Map<string, Bot>();
  const { bots: existing } = await api(base, "GET", "/api/bots");
  const starter = existing.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff) ?? existing[0];
  for (const one of TEAM) {
    const created = one.chief && starter ? starter : (await api(base, "POST", "/api/bots", { name: one.name })).bot;
    const { bot } = await api(base, "PATCH", `/api/bots/${encodeURIComponent(created.id)}`, { name: one.name, color: one.color, mascotBody: one.body, ...(one.pinned ? { pinned: true } : {}), ...("section" in one && one.section ? { section: one.section } : {}) });
    bots.set(one.name, bot);
  }
  const memberIds = ROOM.members.map((name) => bots.get(name)!.id);
  const made = await api(base, "POST", "/api/groups", { name: ROOM.name, memberIds }).catch((error) => { console.error(`room: ${error.message}`); return null; });
  const group = made?.group ?? made;
  for (const routine of ROUTINES) {
    await api(base, "POST", "/api/routines", { name: routine.name, prompt: routine.prompt, botId: bots.get(routine.bot)!.id, schedule: routine.schedule, enabled: true })
      .catch((error) => console.error(`routine ${routine.name}: ${error.message}`));
  }
  return { bots, room: group?.id ? { id: group.id, threadId: group.threadId } : null };
}

/** the held live turns: each bot with `live` gets a real message the fake engine answers with a tool call it never ends */
async function startLiveTurns(base: string, seeded: Seeded) {
  for (const one of TEAM) {
    if (!("live" in one) || !one.live) continue;
    writeFileSync(join(work, "tools.json"), JSON.stringify([{ name: one.live.tool, input: one.live.input, ok: true, hold: "idle" }]));
    await api(base, "POST", `/api/bots/${encodeURIComponent(seeded.bots.get(one.name)!.id)}/messages`, { text: one.live.text });
    await delay(2500);
  }
  writeFileSync(join(work, "tools.json"), "[]");
}

type Message = Record<string, unknown> & { id: string; at: number; role: string; kind: string; parentId?: string | null };
type Line = [string, string, number, Record<string, unknown>?];

function scripted(seeded: Seeded) {
  const now = Date.now();
  const threads = new Map<string, { messages: Message[]; unread: boolean; tail?: Message }>();
  const from = (name: string) => {
    const bot = seeded.bots.get(name);
    return bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {};
  };
  /** a chat line is [who, text, minutesAgo] and may add message fields (attachments, a card) as a fourth entry */
  const build = (threadId: string, chat: Line[], room: boolean) => {
    const messages: Message[] = [];
    chat.forEach(([who, text, ago, extra], index) => {
      messages.push({ id: `store-${threadId}-${index}`, at: now - ago * MINUTE, parentId: messages.at(-1)?.id ?? null, role: who === "me" ? "user" : "bot", kind: "text", text, ...(room && who !== "me" ? from(who) : {}), ...extra });
    });
    return messages;
  };
  for (const one of TEAM) {
    const bot = seeded.bots.get(one.name)!;
    const messages = build(bot.threadId, one.chat as Line[], false);
    let tail: Message | undefined;
    if ("approval" in one && one.approval) {
      tail = { id: `store-${bot.threadId}-approval`, at: now - MINUTE, parentId: messages.at(-1)!.id, role: "bot", kind: "options", text: "",
        card: { title: one.approval.title, subtitle: one.approval.subtitle, options: ["Allow", "Deny"], requestType: "permission", requestId: "store-approval", tool: one.approval.tool } };
    }
    threads.set(bot.threadId, { messages, unread: Boolean(one.unread), tail });
  }
  if (seeded.room) threads.set(seeded.room.threadId, { messages: build(seeded.room.threadId, ROOM.chat as Line[], true), unread: false });
  return threads;
}

/** the scripted history, then whatever real turn followed it; the fixture's greeting and first-run card are dropped */
function rewrite(threadId: string, real: Message[], threads: ReturnType<typeof scripted>): Message[] | null {
  const script = threads.get(threadId);
  if (!script) return null;
  const firstUser = real.findIndex((message) => message.role === "user");
  const kept = (firstUser < 0 ? [] : real.slice(firstUser)).map(({ unconfirmed: _unconfirmed, ...message }) => message as Message);
  const head = script.tail ? [...script.messages, script.tail] : script.messages;
  if (kept[0]) kept[0] = { ...kept[0], parentId: head.at(-1)!.id };
  const all = [...head, ...kept];
  if (all.length <= SERVER_PAGE) return all;
  const page = all.slice(-SERVER_PAGE);
  page[0] = { ...page[0]!, parentId: null };
  return page;
}

/** the newest messages a server hands over at once; the rest come as the phone asks for older ones */
const SERVER_PAGE = 120;

function patchOwner(owner: Record<string, any>, threads: ReturnType<typeof scripted>) {
  const script = threads.get(owner.threadId);
  if (!script || !Array.isArray(owner.messages)) return;
  owner.messages = rewrite(owner.threadId, owner.messages, threads);
  owner.activeLeafId = owner.messages.at(-1)?.id ?? null;
  if (!owner.busy) owner.unread = script.unread;
  const last = owner.messages.at(-1)!;
  for (const task of owner.tasks ?? []) {
    if (task.threadId !== owner.threadId) continue;
    task.updatedAt = Math.max(last.at, task.busy ? task.updatedAt : 0);
    task.lastThreadOrderAt = task.updatedAt;
    task.title = String(script.messages[0]?.text ?? task.title);
    if (!task.busy) task.unread = script.unread;
  }
}

/** a made-up photo for a chat to show, at /api/stage-picture/<n> */
export const stagePictureUrl = (n: number) => `/api/stage-picture/${n}`;
function stagePicture(n: number): string {
  const hue = (n * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 60% 40%)"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="${300 + (n % 5) * 120}" cy="380" r="160" fill="rgb(255 255 255 / .35)"/></svg>`;
}

function startProxy(target: string, threads: () => ReturnType<typeof scripted> | null): Promise<number> {
  const upstream = new URL(target);
  const server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    const picture = /^\/api\/stage-picture\/(\d+)/.exec(path);
    if (picture) {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" });
      res.end(stagePicture(Number(picture[1])));
      return;
    }
    const patch = req.method === "GET" && (/^\/api\/bots(\?|$)/.test(path) || path.startsWith("/api/transcripts?") || path.startsWith("/api/notifications") || path in CONNECTED);
    const headers = { ...req.headers, host: upstream.host, ...(patch ? { "accept-encoding": "identity" } : {}) };
    const forward = http.request({ host: upstream.hostname, port: upstream.port, path, method: req.method, headers }, (answer) => {
      const map = threads();
      if (!patch || !map || !String(answer.headers["content-type"] ?? "").includes("json")) {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      answer.on("data", (chunk) => chunks.push(chunk));
      answer.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        try {
          const data = JSON.parse(body);
          if (path in CONNECTED) Object.assign(data, CONNECTED[path]);
          if (path.startsWith("/api/notifications")) {
            for (const key of Object.keys(data)) if (Array.isArray(data[key])) data[key] = [];
            if (typeof data.unread === "number") data.unread = 0;
          }
          for (const owner of [...(data.bots ?? []), ...(data.groups ?? [])]) patchOwner(owner, map);
          for (const thread of data.threads ?? []) {
            const messages = rewrite(thread.threadId, thread.messages ?? [], map);
            if (messages) { thread.messages = messages; if ("activeLeafId" in thread) thread.activeLeafId = messages.at(-1)?.id ?? null; if ("hasMore" in thread) thread.hasMore = messages.length >= SERVER_PAGE; }
          }
          body = JSON.stringify(data);
        } catch {}
        const { "content-length": _length, "transfer-encoding": _encoding, ...rest } = answer.headers;
        res.writeHead(answer.statusCode ?? 200, { ...rest, "content-length": Buffer.byteLength(body) });
        res.end(body);
      });
    });
    forward.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(forward);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done((server.address() as net.AddressInfo).port)));
}

/** How the phone app is served: vite's dev server by default; perf.ts serves a production build instead. */
export interface Serve { args: string[]; ready: string }
const DEV_SERVER: Serve = { args: ["--config", "apps/mobile/store/vite.config.ts"], ready: "ready in" };

function startVite(apiPort: number, port: number, serve: Serve): Promise<void> {
  const child = spawn(join(repoRoot, "node_modules/.bin/vite"), serve.args, {
    cwd: repoRoot, env: { ...process.env, MADANI_PORT: String(apiPort), MADANI_MOBILE_PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"],
  });
  children.add(child);
  return new Promise((done, fail) => {
    let text = "";
    child.stdout!.on("data", (chunk) => { text += chunk; if (text.includes(serve.ready)) done(); });
    child.once("exit", () => fail(new Error("vite exited")));
  });
}

export const js = (value: unknown) => JSON.stringify(value);
export const button = (name: string) => `[...document.querySelectorAll("button")].find((el) => el.textContent.trim().toLowerCase().startsWith(${js(name.toLowerCase())}))`;
export const click = async (page: HeadlessPage, expression: string) => {
  if (!(await page.evaluate(`(() => { const el = ${expression}; if (!el) return false; el.click(); return true; })()`))) throw new Error(`nothing to click: ${expression.slice(0, 120)}`);
};

export type Scheme = "light" | "dark";
export type Stage = Awaited<ReturnType<typeof startStage>>;

/** `replies`: the fake engine answers a message holding one of these markers with its text, streamed at
 * FAKE_CLAUDE_STREAM_CADENCE when that is set */
export async function startStage(serve: Serve = DEV_SERVER, replies: Record<string, string> = {}) {
  const fixture = await launchFixture(replies);
  console.log(`fixture ${fixture}`);
  const seeded = await seed(fixture);
  let threads: ReturnType<typeof scripted> | null = null;
  const proxy = await startProxy(fixture, () => threads);
  threads = scripted(seeded);
  await startLiveTurns(fixture, seeded);
  const vitePort = await freePort();
  await startVite(proxy, vitePort, serve);
  const base = `http://127.0.0.1:${vitePort}`;
  console.log(`phone app ${base}`);

  const profile = mkdtempSync(join(tmpdir(), "madani-store-chrome-"));
  const page = await openHeadlessChrome(profile);
  // a Pixel 7 for an android run
  const screen = process.env.MADANI_STAGE_PLATFORM === "android" ? { width: 412, height: 915, deviceScaleFactor: 2.625 } : { width: 440, height: 956, deviceScaleFactor: 3 };
  await page.send("Emulation.setDeviceMetricsOverride", { ...screen, mobile: true });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // the store build marks <html data-mobile-app="ios"> from the native shell, which hides screen view (4.2.7) and every
  // plan line; the browser preview would say "web", so the mark is pinned before the app renders
  await page.send("Page.enable");
  const mark = process.env.MADANI_STAGE_PLATFORM === "android" ? "android" : "ios";
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `new MutationObserver(() => { const root = document.documentElement; if (root && root.dataset.mobileApp && root.dataset.mobileApp !== "${mark}") root.dataset.mobileApp = "${mark}"; }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-mobile-app"] });` });

  const open = async (scheme: Scheme, query = "", storage: Record<string, string> = { "madani.mobile.introSeen": "1" }) => {
    await page.send("Page.navigate", { url: `${base}/?frame=1&scheme=${scheme}${query}` });
    await delay(1200);
    await page.evaluate(`localStorage.clear(); sessionStorage.clear(); for (const [k, v] of Object.entries(${js(storage)})) localStorage.setItem(k, v); location.reload()`);
    await delay(2500);
  };
  const home = async (scheme: Scheme) => {
    await open(scheme);
    await page.until(`document.body.textContent.includes(${js(ROOM.name)})`, 30_000);
    // the store app asks once before anything reaches an AI; the screens show someone who said yes
    await delay(1200);
    if (await page.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((el) => el.textContent.trim().toLowerCase() === "allow"); b?.click(); return Boolean(b); })()`)) await delay(1500);
    await delay(800);
  };
  const chat = async (name: string) => {
    await click(page, button(name));
    await page.until(`Boolean(document.querySelector("[data-mobile-chat] textarea"))`, 20_000);
    // the page slides in, then the transcript settles at its end
    await delay(2200);
  };
  const stop = async () => {
    page.close();
    await delay(500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    writeFileSync(join(work, "release"), "");
    stopAll();
  };
  return { page, open, home, chat, stop, base, fixture };
}
