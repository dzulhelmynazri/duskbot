// The dock's card as Chromium really lays it out: the real page and stylesheet at the dock window's size, a bot with a
// long chat, a fake bridge. Catches what DOM tests cannot see: the reply field or the transcript covered, cut off or
// outside where the page says clicks land, a transcript that does not scroll.
// Headless only. `node src/ambient/dock-card.check.mjs` (MADANI_VERIFY_PLAYWRIGHT: a playwright module to load,
// MADANI_VERIFY_BROWSER_CHROME: a Chromium to use, MADANI_DOCK_SHOT: where to save a screenshot).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { chromium } = await import(process.env.MADANI_VERIFY_PLAYWRIGHT || "playwright");
const server = await createServer({ root, cacheDir: `${root}/.madani-scratch/vite-dock-card`, configFile: `${root}/vite.config.ts`, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ executablePath: process.env.MADANI_VERIFY_BROWSER_CHROME || undefined, headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });

// electron/ambient-geometry.mjs: the dock window on a 14-inch MacBook Pro
const LAYOUT = { surface: "dock", width: 408, height: 945, body: 853, top: 46, dock: { cell: 56, tile: 36, column: 64, open: 404, pad: 8, ear: 18, sliver: 6, margin: 28, overhang: 4 }, order: [] };

try {
  const page = await browser.newPage({ viewport: { width: LAYOUT.width, height: LAYOUT.height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((layout) => {
    const now = Date.now();
    const chat = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, from: index % 2 ? "bot" : "you", text: `message ${index}: a line long enough to wrap once in the card`, at: now - (40 - index) * 60_000 }));
    const bot = (id, name, fields = {}) => ({ id, threadId: `t-${id}`, name, color: "blue", body: null, face: null, avatar: null, status: "done", detail: "", line: "Done.", at: now - 60_000, unread: false, asks: 0, approval: null, waits: null, question: null, step: null, chat, ...fields });
    // the summary carries each bot's newest few; the long stretch comes once the card says which chat it shows
    let viewing = null;
    let feed = () => {};
    const state = () => ({ bots: ["ada", "rivet", "nova"].map((id) => bot(id, id[0].toUpperCase() + id.slice(1), { chat: viewing?.botId === id ? chat.slice(-viewing.limit) : chat.slice(-3), hasMore: viewing?.botId === id })), labels: { send: "Send", replyTo: "Reply to {name}" }, lang: "en" });
    window.__pointer = [];
    window.__acts = [];
    window.ambient = {
      surface: "dock",
      onState: (cb) => { feed = cb; setTimeout(() => cb(state()), 30); return () => {}; },
      onLayout: (cb) => { setTimeout(() => cb(layout), 10); return () => {}; },
      pointer(on) { window.__pointer.push(on); }, open() {}, act(next) { window.__acts.push(next); }, order() {}, ready() {}, typing() {}, settled() {}, viewing(next) { viewing = next; setTimeout(() => feed(state()), 40); },
    };
  }, LAYOUT);
  await page.goto(`http://127.0.0.1:${port}/ambient.html`);
  await page.waitForSelector(".amb-dock-list li");
  const inside = () => page.evaluate(() => window.__pointer.at(-1) === true);

  // to the edge, onto the first mascot, rest there: the card comes out
  await page.mouse.move(LAYOUT.width - 3, LAYOUT.height / 2);
  await page.waitForTimeout(500);
  const mascot = await page.locator(".amb-dock-list li").first().boundingBox();
  await page.mouse.move(mascot.x + mascot.width / 2, mascot.y + mascot.height / 2, { steps: 4 });
  await page.waitForSelector(".amb-card:not([inert])");
  await page.waitForTimeout(400);
  // over to the next bot and back: the card glides there and back
  const next = await page.locator(".amb-dock-list li").nth(1).boundingBox();
  await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2, { steps: 4 });
  await page.waitForTimeout(300);
  await page.mouse.move(mascot.x + mascot.width / 2, mascot.y + mascot.height / 2, { steps: 4 });
  await page.waitForTimeout(600);

  const parts = await page.evaluate(() => {
    const box = (selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
    const list = document.querySelector(".amb-card .amb-chat-list");
    const style = getComputedStyle(list);
    return { card: box(".amb-card"), list: box(".amb-card .amb-chat-list"), field: box(".amb-card .amb-chat-compose textarea, .amb-card .amb-chat-compose input"), overflowY: style.overflowY, scrollable: list.scrollHeight > list.clientHeight + 1, scrollTop: list.scrollTop, end: list.scrollHeight - list.clientHeight };
  });
  assert.ok(parts.field, "no reply field in the card");
  assert.ok(parts.list.h <= 500 && parts.card.h <= 560, `card ${parts.card.h}px tall, transcript ${parts.list.h}px`);
  assert.ok(parts.field.y + parts.field.h <= parts.card.y + parts.card.h + 0.5, "the reply field is cut off by the card");
  assert.ok(parts.scrollable && /auto|scroll/.test(parts.overflowY), "the transcript does not scroll inside");
  assert.ok(Math.abs(parts.scrollTop - parts.end) <= 1, `the newest message is not at the bottom (${parts.scrollTop} of ${parts.end})`);

  // onto the transcript: still on the dock, and the wheel scrolls it
  const at = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const mid = at(parts.list);
  await page.mouse.move(mid.x, mid.y, { steps: 6 });
  await page.waitForTimeout(250);
  assert.ok(await inside(), "the pointer on the transcript counts as off the dock: clicks pass through");
  assert.ok(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".amb-chat-list")), mid), "the transcript is covered");
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
  const scrolled = await page.evaluate(() => document.querySelector(".amb-card .amb-chat-list").scrollTop);
  assert.ok(scrolled < parts.scrollTop - 50, `the transcript did not scroll (${parts.scrollTop} -> ${scrolled})`);

  // onto the reply field: still on the dock, it takes a click and typing, and Enter sends
  const spot = at(parts.field);
  await page.mouse.move(spot.x, spot.y, { steps: 6 });
  await page.waitForTimeout(250);
  assert.ok(await inside(), "the pointer on the reply field counts as off the dock: clicks pass through");
  assert.ok(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".amb-chat-compose")), spot), "the reply field is covered");
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.type("hello there");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const acts = await page.evaluate(() => window.__acts);
  assert.ok(acts.some((next) => next.kind === "reply" && next.text === "hello there"), `the reply was not sent: ${JSON.stringify(acts)}`);
  assert.ok(await page.locator(".amb-card:not([inert])").count(), "the card closed while replying");

  if (process.env.MADANI_DOCK_SHOT) await page.screenshot({ path: process.env.MADANI_DOCK_SHOT });

  // away to the left: the card fades where it was, never moving or resizing while it goes
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(2, spot.y, { steps: 2 });
  const frames = await page.evaluate(() => new Promise((resolve) => {
    const out = [];
    const card = document.querySelector(".amb-card");
    const step = () => {
      // its own place and height, not the box the leaving scale draws
      const style = getComputedStyle(card);
      out.push({ y: Math.round(new DOMMatrix(style.transform).m42), h: card.offsetHeight, o: Number(style.opacity) });
      if (out.length < 30) requestAnimationFrame(step); else resolve(out);
    };
    step();
  }));
  const fading = frames.filter((frame) => frame.o > 0.02 && frame.o < 0.98);
  assert.ok(fading.length, "the card never faded");
  for (const frame of fading) assert.ok(frame.h === fading[0].h && frame.y === fading[0].y, `the card moved while leaving: ${JSON.stringify(fading)}`);
  await page.waitForTimeout(1200);
  assert.equal(await page.locator(".amb-card:not([inert])").count(), 0, "the card stayed after the pointer left");
  assert.deepEqual(errors.filter((message) => !/WebSocket/.test(message)), []);
  console.log(`dock card ok: card ${Math.round(parts.card.h)}px, transcript scrolled ${parts.scrollTop} -> ${scrolled}, reply sent`);
} finally {
  await browser.close();
  await server.close();
}
