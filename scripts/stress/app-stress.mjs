// Desktop app stress through the smoke shim (never visible, own profile, fake engine): force-quit and harness crash
// mid-turn, renderer offline and frozen mid-stream, and two clients sending at once.
//   PROFILE=<short empty dir, e.g. /tmp/dsa1: unix socket paths> node scripts/stress/app-stress.mjs [--only a,b,c,d,e,f,debug]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchSmokeApp, until } from "../smoke/app.mjs";
import { snapshot, compare } from "../smoke/owner-guard.mjs";

const root = resolve(import.meta.dirname, "../..");
const profile = process.env.PROFILE;
if (!profile) throw new Error("PROFILE is required");
const only = (process.argv[process.argv.indexOf("--only") + 1] ?? "a,b,c,d").split(",");
const dataDir = join(profile, "home", ".madanibot");
mkdirSync(dataDir, { recursive: true });
if (!existsSync(join(dataDir, "config.json"))) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ features: { smartSetupChoices: false },
  instances: { claude: { driver: "claudeAgent", displayName: "Fake", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } } } }));
const replyFile = join(profile, "reply.txt");
const RUN = Date.now().toString(36);
const setReply = (tag, words = 150) => writeFileSync(replyFile, `BEGIN-${tag}${RUN} ${"lorem ".repeat(words)}FINISHED-${tag}${RUN}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const RAW = /\b(Error:|ECONN\w+|SIGKILL|SIGTERM|exit code|exited with|stack|undefined|null\b|\[object)/;
const report = {};
const before = snapshot();

async function start(cadence = "10:100") {
  const app = await launchSmokeApp({ root, profile, log: () => {}, env: {
    MADANI_TEST_SEALED_PATH: "1", FAKE_CLAUDE_REPLY_FILE: replyFile, FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_STREAM_CADENCE: cadence,
  } });
  const base = `http://127.0.0.1:${app.port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { origin: base, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  await until(async () => (await fetch(base + "/api/health")).ok, { timeout: 90_000, what: "harness" });
  // changes come from the window itself (the desktop owner), as the composer's requests do
  const post = async (method, path, body) => {
    const out = await app.evaluate(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body ?? {}))} })
      .then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text() }))`);
    if (!out.ok) throw new Error(`${method} ${path} ${out.status} ${out.text.slice(0, 200)}`);
    return JSON.parse(out.text);
  };
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots[0];
  await until(() => app.evaluate(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`), { timeout: 60_000, what: "composer" });
  await post("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false }).catch((e) => console.log("patch", e.message));
  return { app, base, api, post, bot };
}
const transcript = async (ctx) => (await ctx.api("GET", `/api/threads/${ctx.bot.threadId}/messages?limit=200`)).messages;
const job = (ctx) => ctx.api("GET", `/api/threads/${ctx.bot.threadId}/job?scope=turn`);
const settled = async (ctx, timeout = 120_000) => {
  const t0 = Date.now();
  await sleep(2000);
  let calm = 0, last;
  await until(async () => { last = await job(ctx); calm = last.conversation?.busy || last.conversation?.queued ? 0 : calm + 1; return calm >= 3; }, { timeout, what: "turn to settle", every: 700 });
  return { state: last.state, activity: last.conversation?.activity, ms: Date.now() - t0 };
};
const count = (texts, needle) => texts.filter((text) => text.includes(needle)).length;
const engines = () => { try { return execFileSync("pgrep", ["-f", `${root}/server/testing/fake-claude-cli.ts`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length; } catch { return 0; } };
const harnessPid = async (ctx) => (await (await fetch(`${ctx.base}/api/health`)).json()).pid;
const ppid = (pid) => Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
const domText = (ctx) => ctx.app.evaluate("document.body.innerText");
async function summary(ctx, tag, sentText) {
  const msgs = await transcript(ctx);
  const texts = msgs.filter((m) => m.kind !== "digest").map((m) => String(m.text ?? ""));
  const bot = msgs.filter((m) => m.role !== "user" && m.kind !== "digest").map((m) => String(m.text ?? m.tool?.name ?? ""));
  return { userCopies: count(msgs.filter((m) => m.role === "user").map((m) => String(m.text ?? "")), sentText), replyBegun: count(texts, `BEGIN-${tag}${RUN}`),
    replyFinished: count(texts, `FINISHED-${tag}${RUN}`), rawErrors: bot.filter((text) => RAW.test(text)).map((text) => text.slice(0, 160)),
    lastBot: bot.at(-1)?.slice(0, 160) };
}

let ctx = await start();
try {
  if (only.includes("debug")) {
    setReply("X", 5);
    await ctx.post("POST", `/api/bots/${ctx.bot.id}/messages`, { text: "debug hello", threadId: ctx.bot.threadId });
    await sleep(12000);
    console.log(JSON.stringify((await transcript(ctx)).map((m) => ({ role: m.role, kind: m.kind, text: String(m.text ?? "").slice(0, 120) }))));
    console.log(JSON.stringify(await job(ctx)).slice(0, 600));
    console.log(JSON.stringify((await transcript(ctx)).at(-1)).slice(0, 1500));
    console.log(ctx.app.output().split("\n").filter((l) => !/vite|ECONNREFUSED|afterConnect/.test(l)).slice(-40).join("\n"));
  }
  if (only.includes("a")) {
    // force-quit: the app and its whole process group die mid-stream, then the app starts again on the same profile
    setReply("A");
    const text = `force quit ${Date.now()}`;
    await ctx.post("POST", `/api/bots/${ctx.bot.id}/messages`, { text, threadId: ctx.bot.threadId });
    await sleep(5000);
    const mid = await summary(ctx, "A", text);
    const electron = ppid(await harnessPid(ctx));
    const enginesBefore = engines();
    try { process.kill(-electron, "SIGKILL"); } catch { process.kill(electron, "SIGKILL"); }
    await sleep(3000);
    const orphanEngines = engines();
    await ctx.app.close().catch(() => {});
    const t0 = Date.now();
    ctx = await start();
    const back = Date.now() - t0;
    const final = await settled(ctx);
    report.a_forceQuit = { mid, enginesBefore, orphanEnginesAfterKill: orphanEngines, relaunchMs: back, final, after: await summary(ctx, "A", text) };
    console.log(JSON.stringify(report.a_forceQuit));
  }
  if (only.includes("b")) {
    // the harness alone dies mid-stream; the app restarts it and the open window catches up without a reload
    setReply("B");
    const text = `harness crash ${Date.now()}`;
    await ctx.post("POST", `/api/bots/${ctx.bot.id}/messages`, { text, threadId: ctx.bot.threadId });
    await sleep(5000);
    const pid = await harnessPid(ctx);
    const net = [];
    const tStart = Date.now();
    await ctx.app.send("Network.enable");
    const urls = new Map();
    ctx.app.cdp.on((m) => {
      if (m.method === "Network.requestWillBeSent" && /\/api\//.test(m.params.request.url)) { urls.set(m.params.requestId, m.params.request.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 70)); net.push(`${Date.now() - tStart} send ${urls.get(m.params.requestId)}`); }
      if (m.method === "Network.loadingFailed" && urls.has(m.params.requestId)) net.push(`${Date.now() - tStart} fail ${urls.get(m.params.requestId)} ${m.params.errorText}`);
      if (m.method === "Network.responseReceived" && urls.has(m.params.requestId)) net.push(`${Date.now() - tStart} resp ${m.params.response.status} ${urls.get(m.params.requestId)}`);
    });
    await sleep(500);
    process.kill(pid, "SIGKILL");
    const t0 = Date.now();
    await until(async () => { try { return (await harnessPid(ctx)) !== pid; } catch { return false; } }, { timeout: 60_000, what: "harness back", every: 200 });
    const harnessBackMs = Date.now() - t0;
    // poll the window for the finished reply while the server finishes the turn
    let domFinishedAt = 0;
    const watcher = (async () => { while (!domFinishedAt && Date.now() - t0 < 120_000) { try { if ((await domText(ctx)).includes(`FINISHED-B${RUN}`)) domFinishedAt = Date.now(); } catch {} await sleep(250); } })();
    await sleep(1500);
    const orphanEngines = engines();
    const final = await settled(ctx);
    const after = await summary(ctx, "B", text);
    await watcher;
    const reply = (await transcript(ctx)).find((m) => m.kind === "text" && String(m.text).includes(`FINISHED-B${RUN}`));
    const uiCaughtUpMs = domFinishedAt ? domFinishedAt - reply.at : -1;
    console.log(`killed at ~500, harness back ${harnessBackMs + 500}, server reply at ${reply.at - tStart}, window at ${domFinishedAt - tStart}`);
    console.log(net.filter((l) => !/health|threads\/.*\/job|messages\?limit/.test(l)).join("\n"));
    report.b_harnessCrash = { harnessBackMs, orphanEngines, final, after, uiCaughtUpMs };
    console.log(JSON.stringify(report.b_harnessCrash));
  }
  if (only.includes("d")) {
    // laptop sleep and a network switch, as the window sees it: offline and frozen mid-stream, then back
    setReply("D");
    const text = `sleep wake ${Date.now()}`;
    await ctx.post("POST", `/api/bots/${ctx.bot.id}/messages`, { text, threadId: ctx.bot.threadId });
    await sleep(4000);
    await ctx.app.send("Network.enable");
    await ctx.app.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await ctx.app.send("Page.setWebLifecycleState", { state: "frozen" });
    const final = await settled(ctx);
    await sleep(3000);
    await ctx.app.send("Page.setWebLifecycleState", { state: "active" });
    await ctx.app.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const t0 = Date.now();
    let uiMs = -1;
    try { await until(async () => (await domText(ctx)).includes(`FINISHED-D${RUN}`), { timeout: 60_000, what: "reply in window" }); uiMs = Date.now() - t0; } catch {}
    await sleep(2000);
    const dom = await domText(ctx);
    report.d_sleepOffline = { final, after: await summary(ctx, "D", text), uiRecoveredMs: uiMs, domFinished: dom.split(`FINISHED-D${RUN}`).length - 1, bubbles: await ctx.app.evaluate(`[...document.querySelectorAll(".chat-md")].filter((e) => e.textContent.includes("FINISHED-D${RUN}")).length`), domBegun: dom.split(`BEGIN-D${RUN}`).length - 1, domUserCopies: dom.split(text).length - 1 };
    console.log(JSON.stringify(report.d_sleepOffline));
  }
  if (only.includes("e")) {
    // control for d: the same turn with the window left alone
    setReply("E", 20);
    const text = `control ${Date.now()}`;
    await ctx.post("POST", `/api/bots/${ctx.bot.id}/messages`, { text, threadId: ctx.bot.threadId });
    await settled(ctx);
    await sleep(2000);
    const where = await ctx.app.evaluate(`(() => { const out = []; const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) { const n = walk.currentNode; if (n.textContent.includes("FINISHED-E${RUN}")) { const chain = [n.textContent.slice(0, 50), n.parentElement.closest("[data-message-id],[data-id],[id]")?.outerHTML.slice(0, 160)]; let e = n.parentElement; for (let i = 0; e && i < 6; i++, e = e.parentElement) chain.push(e.tagName + "." + String(e.className).slice(0, 40) + (e.getAttribute("aria-hidden") ? "[hidden]" : "")); out.push(chain.join(" < ")); } }
      return out; })()`);
    const t = await transcript(ctx);
    report.e_server = t.slice(-4).map((m) => ({ id: m.id, kind: m.kind, role: m.role, text: String(m.text ?? "").slice(0, 60) }));
    report.e_control = { domFinished: (await domText(ctx)).split(`FINISHED-E${RUN}`).length - 1, where };
    console.log(JSON.stringify(report.e_control)); console.log(JSON.stringify(report.e_server));
  }
  if (only.includes("f")) {
    // repeat the plain turn and count the reply's chat bubbles (the sidebar preview is not one)
    const bubbles = (tag) => ctx.app.evaluate(`[...document.querySelectorAll(".chat-md")].filter((e) => e.textContent.includes(${JSON.stringify(tag)})).length`);
    const rows = [];
    for (let i = 0; i < 8; i++) {
      const tag = `F${i}`;
      setReply(tag, 20 + i * 10);
      await ctx.post("POST", `/api/bots/${ctx.bot.id}/messages`, { text: `repeat ${i} ${Date.now()}`, threadId: ctx.bot.threadId });
      await settled(ctx);
      const at2 = await bubbles(`FINISHED-${tag}${RUN}`);
      await sleep(5000);
      const at7 = await bubbles(`FINISHED-${tag}${RUN}`);
      const server = (await transcript(ctx)).filter((m) => m.kind === "text" && String(m.text).includes(`FINISHED-${tag}${RUN}`)).map((m) => m.id);
      rows.push({ i, at2, at7, server: server.length });
    }
    report.f_repeat = rows;
    console.log(JSON.stringify(rows));
  }
  if (only.includes("c")) {
    // two clients: the window's composer and an API client send to the same thread at once
    setReply("C", 3);
    const stamp = Date.now();
    const typed = Array.from({ length: 8 }, (_, i) => `ui-${stamp}-${i}`);
    const posted = Array.from({ length: 8 }, (_, i) => `api-${stamp}-${i}`);
    const typeOne = async (value) => {
      const set = await ctx.app.evaluate(`(() => {
        const box = document.querySelector('textarea[aria-label^="Message"]');
        if (!box) return "no composer";
        box.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(value)});
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return "ok";
      })()`);
      if (set !== "ok") return set;
      await sleep(60);
      return ctx.app.evaluate(`(() => { const box = document.querySelector('textarea[aria-label^="Message"]');
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })); return "ok"; })()`);
    };
    const sentErrors = [];
    const pairing = await ctx.post("POST", "/api/auth/pairing", { scopes: ["admin", "client"], label: "stress second device" });
    const paired = await (await fetch(`${ctx.base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: pairing.credential ?? pairing.code, deviceName: "stress second device" }) })).json();
    if (!paired.token) throw new Error(`pairing failed ${JSON.stringify(paired).slice(0, 200)}`);
    const device = async (path, body) => {
      const res = await fetch(ctx.base + path, { method: "POST", headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    };
    await Promise.all([
      (async () => { for (const value of typed) { const r = await typeOne(value); if (r !== "ok") sentErrors.push(r); await sleep(150); } })(),
      (async () => { for (const value of posted) { await device(`/api/bots/${ctx.bot.id}/messages`, { text: value, threadId: ctx.bot.threadId }).catch((e) => sentErrors.push(e.message)); await sleep(130); } })(),
    ]);
    await sleep(2000);
    const final = await settled(ctx, 180_000);
    await sleep(3000);
    const msgs = (await transcript(ctx)).filter((m) => m.role === "user").map((m) => String(m.text ?? ""));
    const copies = (list, texts) => Object.fromEntries(list.map((v) => [v, texts.filter((t) => t.includes(v)).length]));
    const serverCopies = { ...copies(typed, msgs), ...copies(posted, msgs) };
    // the transcript only: the sidebar repeats the last message as its preview
    const pane = await ctx.app.evaluate(`(() => { const box = document.querySelector('textarea[aria-label^="Message"]'); let e = box; while (e && !e.querySelector(".chat-md")) e = e.parentElement; return e ? e.innerText : ""; })()`);
    const domCopies = Object.fromEntries([...typed, ...posted].map((v) => [v, pane.split(v).length - 1]));
    const order = (list) => list.map((v) => msgs.findIndex((t) => t.includes(v)));
    const inOrder = (idx) => idx.every((v, i) => i === 0 || v > idx[i - 1]);
    report.c_twoClients = { sentErrors, final,
      serverLost: Object.entries(serverCopies).filter(([, n]) => n === 0).map(([v]) => v),
      serverDup: Object.entries(serverCopies).filter(([, n]) => n > 1).map(([v]) => v),
      domLost: Object.entries(domCopies).filter(([, n]) => n === 0).map(([v]) => v),
      domDup: Object.entries(domCopies).filter(([, n]) => n > 1).map(([v]) => v),
      uiOrderKept: inOrder(order(typed)), apiOrderKept: inOrder(order(posted)), userMessages: msgs.length };
    console.log(JSON.stringify(report.c_twoClients));
  }
} finally {
  await ctx.app.close().catch(() => {});
  report.ownerGuard = compare(before, [String(ctx.port ?? ""), profile].filter(Boolean));
  report.leftoverEngines = engines();
  console.log("REPORT", JSON.stringify(report));
}
