// The open notch as Chromium really lays it out: the real page and stylesheet at the island window's size, 40 bots, a
// fake bridge. Catches what DOM tests cannot see: cells spread apart, names or states not drawn, a row cut in half.
// Headless only. `node src/ambient/notch-layout.check.mjs` (MADANI_VERIFY_PLAYWRIGHT: a playwright module to load,
// MADANI_VERIFY_BROWSER_CHROME: a Chromium to use, MADANI_NOTCH_SHOT: where to save a screenshot).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { chromium } = await import(process.env.MADANI_VERIFY_PLAYWRIGHT || "playwright");
const server = await createServer({ root, cacheDir: `${root}/.madani-scratch/vite-notch-layout`, configFile: `${root}/vite.config.ts`, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ executablePath: process.env.MADANI_VERIFY_BROWSER_CHROME || undefined, headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });

// electron/ambient-geometry.mjs: the island window, and a 14-inch MacBook Pro's notch
const WINDOW = { width: 560, height: 680 };
const COLLAPSED = { kind: "notch", width: 270, height: 37, top: 0, notch: 186 };

try {
  const page = await browser.newPage({ viewport: WINDOW, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ collapsed, window: size }) => {
    const now = Date.now();
    const names = ["Tally", "Bolt", "Ada", "Bram", "Quillington", "Echo", "Nova"];
    const bots = Array.from({ length: 40 }, (_, index) => ({
      id: `b${index}`, threadId: `t${index}`, name: `${names[index % names.length]}${index}`, color: "blue", body: null, face: null, avatar: null,
      status: index % 5 === 0 ? "working" : index % 7 === 0 ? "done" : "idle", detail: "", line: "Booked the 9:40 to Lisbon.", at: now - index * 3_600_000,
      unread: index % 7 === 0, asks: 0, approval: null, waits: null, question: null,
    }));
    const labels = { working: "Working", done: "Replied", "needs-you": "Needs you", error: "Failed", now: "now", open: "Open {name}", island: "Your bots" };
    window.ambient = {
      surface: "island",
      onState: (cb) => { setTimeout(() => cb({ bots, labels, lang: "en" }), 30); return () => {}; },
      onLayout: (cb) => { setTimeout(() => cb({ surface: "island", ...size, collapsed, tile: 20, size: "medium" }), 10); return () => {}; },
      pointer() {}, open() {}, act() {}, order() {}, ready() {},
    };
  }, { collapsed: COLLAPSED, window: WINDOW });
  await page.goto(`http://127.0.0.1:${port}/ambient.html`);
  await page.waitForSelector(".amb-strip-bot");
  // the pointer on the notch opens it; then let the spring settle
  await page.mouse.move(WINDOW.width / 2, 12);
  await page.waitForFunction(() => document.querySelector(".amb-stage")?.hasAttribute("data-open"));
  await page.waitForTimeout(900);

  const measure = () => page.evaluate(() => {
    const strip = document.querySelector(".amb-strip");
    const box = strip.getBoundingClientRect();
    const alpha = (color) => { const parts = color.match(/[\d.]+/g) ?? []; return parts.length === 4 ? Number(parts[3]) : 1; };
    const cells = [...strip.querySelectorAll(".amb-strip-bot")].map((cell) => {
      const rect = cell.getBoundingClientRect();
      const text = [".amb-strip-name", ".amb-strip-state"].map((selector) => {
        const node = cell.querySelector(selector);
        const area = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        // what is actually on top at the text's middle: clipped, covered or hidden text is not this node
        const hit = document.elementFromPoint(area.left + Math.min(area.width, 8) / 2 + 1, area.top + area.height / 2);
        return { text: node.textContent, width: area.width, height: area.height, size: parseFloat(style.fontSize), alpha: alpha(style.color) * Number(style.opacity), drawn: hit === node || node.contains(hit) };
      });
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height, inside: rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5, outside: rect.bottom <= box.top + 0.5 || rect.top >= box.bottom - 0.5, text };
    });
    return { cells, scrollTop: strip.scrollTop, scrollable: strip.scrollHeight > strip.clientHeight + 1 };
  });

  const check = ({ cells }, when) => {
    const first = cells.filter((cell) => Math.abs(cell.y - cells[0].y) < 1);
    assert.ok(first.length >= 7 && first.length <= 8, `${when}: ${first.length} to a row, wanted 7 or 8`);
    const across = first[1].x - first[0].x;
    const down = cells.find((cell) => cell.y > cells[0].y + 1).y - cells[0].y;
    assert.ok(across <= 52, `${when}: cells ${across}px apart across`);
    assert.ok(down <= 70, `${when}: rows ${down}px apart`);
    for (const [index, cell] of cells.entries()) {
      // every row is wholly in view or wholly scrolled away
      assert.ok(cell.inside || cell.outside, `${when}: cell ${index} cut by the grid's edge`);
      if (!cell.inside) continue;
      for (const line of cell.text) {
        if (!line.text) continue;
        assert.ok(line.width > 0 && line.height > 0, `${when}: cell ${index} "${line.text}" has no box`);
        assert.ok(line.size >= 9.5 && line.size <= 11.5, `${when}: cell ${index} "${line.text}" at ${line.size}px`);
        assert.ok(line.alpha >= 0.4, `${when}: cell ${index} "${line.text}" nearly invisible`);
        assert.ok(line.drawn, `${when}: cell ${index} "${line.text}" clipped or covered`);
      }
      assert.ok(cell.text[0].text, `${when}: cell ${index} has no name`);
    }
  };

  const before = await measure();
  check(before, "opened");
  assert.ok(before.scrollable, "40 bots should scroll past four rows");
  // scrolled all the way down, the last rows are whole too
  await page.mouse.move(WINDOW.width / 2, 120);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(700);
  const after = await measure();
  assert.ok(after.scrollTop > 0, "the grid did not scroll");
  check(after, "scrolled");
  if (process.env.MADANI_NOTCH_SHOT) await page.screenshot({ path: process.env.MADANI_NOTCH_SHOT, clip: { x: 40, y: 0, width: 480, height: 420 } });
  assert.deepEqual(errors, []);
  console.log(`notch layout ok: ${before.cells.filter((cell) => Math.abs(cell.y - before.cells[0].y) < 1).length} to a row, scrolled to ${after.scrollTop}px`);
} finally {
  await browser.close();
  await server.close();
}
