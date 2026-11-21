// Composes the store images from capture.ts's screens: headline, one line, the screen in a phone frame, pixel art.
// Writes opaque sRGB PNGs: ios/6.9, ios/6.5, play/phone, play/feature-graphic.png, and a contact sheet.
//
//   node --experimental-strip-types apps/mobile/store/compose.ts [storeDir] [sheetPath]
//     storeDir  default ~/Desktop/code/omb-ref/store (reads raw/, writes ios/ and play/)
//     sheetPath default ~/.playwright-mcp/store-sheet.png
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Resvg } from "@resvg/resvg-js";
import { openHeadlessChrome } from "../../../scripts/testing/headless-chrome.ts";
import { C, opaquePng72, scene } from "../../../build/art/pixel-scene.mjs";
import { stillSvgPaths } from "../../../src/pixel/core.ts";
import { FEATURE, IOS_SHOTS, PLAY_SHOTS, SHOTS, SIZES } from "./story.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const fonts = fileURLToPath(new URL("../../../build/art/fonts/", import.meta.url));
const store = process.argv[2] ?? join(homedir(), "Desktop/code/omb-ref/store");
const sheetPath = process.argv[3] ?? join(homedir(), ".playwright-mcp/store-sheet.png");
const raw = join(store, "raw");
const work = mkdtempSync(join(tmpdir(), "madani-store-compose-"));

const INK = "#1b1b1f";
const PAPER = "#fcfcfd";
/** the phone screen is 440 x 956 points; frame=1 keeps 54 points on top and 34 below for the system bars */
const SCREEN = { w: 440, h: 956, radius: 55, top: 54, bottom: 34 };

type Shot = (typeof SHOTS)[number];
type Size = { store: string; name: string; width: number; height: number };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fileUrl = (path: string) => pathToFileURL(path).href;

function botSvg(body: string, fill: string, px: number, eyes = C.cloud) {
  const s = stillSvgPaths(body, { scale: 1 });
  return { w: s.G * px, h: s.G * px, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${s.G * px}" height="${s.G * px}" viewBox="0 0 ${s.G} ${s.G}" shape-rendering="crispEdges"><path d="${s.body}" fill="${fill}"/><path d="${s.eyes}" fill="${eyes}"/></svg>` };
}

/** a full-bleed pixel sky drawn on a grid 660 points wide (the banner's cell size), stretched to the canvas */
function skySvg(kind: "meadow" | "madani", width: number, height: number) {
  const W = 660;
  const H = Math.round((W * height) / width);
  const rows = Math.floor(H / 8);
  const s = scene(W, H, { cell: 8, seed: kind === "madani" ? 23 : 41 });
  const fray = { fray: [0, 1, 1, 1, 2, 2, 3, 4], stray: 0.16 };
  const ground = rows - Math.round(rows * 0.16);
  if (kind === "meadow") {
    s.sky([[C.sky0, 0], [C.sky1, Math.round(rows * 0.3)], [C.sky2, Math.round(rows * 0.58)], [C.sky3, Math.round(rows * 0.7)], [C.canvas, Math.round(rows * 0.78)]], fray);
    s.cloud(W - 120, Math.round(rows * 0.36), 12, C.pink);
    s.cloud(90, Math.round(rows * 0.52), 9, C.lemon);
  } else {
    const MADANI = ["#2e2c86", "#4744e2", "#7a5ae8", "#b896f2", "#ffc4dd", "#ffe3ee"];
    s.sky(MADANI.map((fill, i) => [fill, Math.round(rows * [0, 0.34, 0.5, 0.62, 0.72, 0.78][i]!)] as [string, number]), fray);
    for (let i = 0; i < 70; i++) {
      const x = Math.floor((0.7 + s.rand() * 0.3) * (W / 4)) * 4;
      const y = Math.floor(s.rand() * (rows * 0.3 * 2)) * 4;
      s.rect(x, y, 4, 4, s.rand() < 0.3 ? C.lemon : C.cloud);
    }
    s.cloud(W - 110, Math.round(rows * 0.46), 10, C.lilac);
  }
  s.ground(ground, { flowers: 10, speckle: 0.05 });
  return s.svg().replace(/width="\d+" height="\d+"/, `width="${width}" height="${height}" preserveAspectRatio="none"`);
}

function statusBar(dark: boolean) {
  const ink = dark ? "#f5f5f7" : "#101014";
  // iOS draws these glyphs in its own system font; the shapes follow its proportions at 440 points
  return `<svg class="status" viewBox="0 0 440 54" xmlns="http://www.w3.org/2000/svg">
    <text x="62" y="35" font-family="Status" font-size="17" font-weight="600" fill="${ink}" text-anchor="middle">9:41</text>
    <g fill="${ink}" transform="translate(326 23)">
      <rect x="0" y="7" width="3.2" height="4.4" rx="1"/><rect x="4.8" y="5" width="3.2" height="6.4" rx="1"/>
      <rect x="9.6" y="2.6" width="3.2" height="8.8" rx="1"/><rect x="14.4" y="0" width="3.2" height="11.4" rx="1"/>
    </g>
    <g fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" transform="translate(354 23.4)">
      <path d="M1 4.2a11 11 0 0 1 14.6 0"/><path d="M3.9 7.1a6.8 6.8 0 0 1 8.8 0"/>
    </g>
    <circle cx="362.3" cy="33.2" r="1.7" fill="${ink}"/>
    <g transform="translate(378 22.6)">
      <rect x="0.6" y="0.6" width="24" height="11.6" rx="3.6" fill="none" stroke="${ink}" stroke-opacity="0.4" stroke-width="1.2"/>
      <rect x="2.6" y="2.6" width="20" height="7.6" rx="2" fill="${ink}"/>
      <path d="M26.4 4.4v4a2 2 0 0 0 0-4z" fill="${ink}" fill-opacity="0.45"/>
    </g>
  </svg>`;
}

/** where the text, the phone and the art go on a canvas, in canvas pixels */
function layout(size: Size) {
  const W = size.width, H = size.height;
  const tall = H / W > 2;
  const u = W / (tall ? 1320 : 1080);
  const margin = (tall ? 120 : 84) * u;
  const textTop = (tall ? 210 : 104) * u;
  const headline = (tall ? 112 : 82) * u;
  const line = (tall ? 44 : 33) * u;
  const phoneTop = (tall ? 820 : 560) * u;
  const phoneBottom = H - (tall ? 120 : 64) * u;
  const bezel = (tall ? 22 : 15) * u;
  const screenH = phoneBottom - phoneTop - 2 * bezel;
  const screenW = (screenH * SCREEN.w) / SCREEN.h;
  const phoneW = screenW + 2 * bezel;
  return { W, H, u, margin, textTop, headline, line, phone: { x: (W - phoneW) / 2, y: phoneTop, w: phoneW, h: phoneBottom - phoneTop, bezel, screenW, screenH, pt: screenW / SCREEN.w } };
}

function shotHtml(shot: Shot, size: Size) {
  const L = layout(size);
  const { phone: P, u } = L;
  const sky = shot.bg !== "white";
  const textInk = sky ? "#ffffff" : INK;
  const lineInk = sky ? "rgba(255,255,255,0.92)" : "#62626c";
  const screen = join(raw, `${shot.screen}.png`);
  const bots = (shot.art.bots ?? []).map(([body, colour, at, scale = 1]: [string, keyof typeof C, number, number?]) => {
    const px = P.w * 0.0118 * scale;
    const b = botSvg(body, C[colour] ?? colour, px);
    const x = P.x + P.w * at - b.w / 2;
    // the floor sits a hair into the bezel so the bot reads as standing on the phone
    const y = P.y - b.h + P.bezel * 0.35;
    return `<div class="art" style="left:${x}px;top:${y}px;width:${b.w}px;height:${b.h}px">${b.svg}</div>`;
  }).join("");
  const prop = shot.art.prop ? (() => {
    const [file, at] = shot.art.prop as [string, number];
    const h = P.w * 0.2;
    return `<img class="prop" src="${fileUrl(join(here, "art", `${file}.webp`))}" style="left:${P.x + P.w * at}px;top:${P.y + P.bezel * 0.35 - h}px;height:${h}px;transform:translateX(-50%)" alt="">`;
  })() : "";
  const shadow = sky ? "rgba(6,58,110,0.28)" : "rgba(27,27,31,0.16)";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Display"; src: url("${fileUrl(join(fonts, "general-sans-semibold.ttf"))}"); font-weight: 600; }
@font-face { font-family: "Body"; src: url("${fileUrl(join(fonts, "general-sans-medium.ttf"))}"); font-weight: 500; }
@font-face { font-family: "Status"; src: url("${fileUrl(join(fonts, "general-sans-semibold.ttf"))}"); font-weight: 600; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${L.W}px; height: ${L.H}px; overflow: hidden; background: ${PAPER}; }
.sky { position: absolute; inset: 0; }
.sky svg { display: block; width: 100%; height: 100%; }
.text { position: absolute; left: ${L.margin}px; top: ${L.textTop}px; right: ${L.margin}px; }
h1 { font: 600 ${L.headline}px/1.1 "Display"; letter-spacing: -0.025em; color: ${textInk}; white-space: pre-line;  }
p { font: 500 ${L.line}px/1.4 "Body"; color: ${lineInk}; margin-top: ${30 * u}px; max-width: ${(L.H / L.W > 2 ? 900 : 800) * u}px; text-wrap: pretty; }
.prop { position: absolute; z-index: 3; width: auto; }
.art { position: absolute; z-index: 3; }
.art svg { display: block; width: 100%; height: 100%; }
.phone { position: absolute; left: ${P.x}px; top: ${P.y}px; width: ${P.w}px; height: ${P.h}px; border-radius: ${(SCREEN.radius * P.pt) + P.bezel}px;
  background: ${INK}; box-shadow: 0 0 0 ${Math.max(1, 2 * u)}px #3a3a44 inset, 0 ${50 * u}px ${110 * u}px ${shadow}, 0 ${10 * u}px ${24 * u}px rgba(27,27,31,0.10); z-index: 2; }
.screen { position: absolute; left: ${P.bezel}px; top: ${P.bezel}px; width: ${P.screenW}px; height: ${P.screenH}px; border-radius: ${SCREEN.radius * P.pt}px; overflow: hidden; background: #000; }
.screen img { display: block; width: 100%; height: 100%; }
.status { position: absolute; left: 0; top: 0; width: 100%; height: ${SCREEN.top * P.pt}px; }
.island { position: absolute; left: 50%; top: ${11 * P.pt}px; width: ${126 * P.pt}px; height: ${37 * P.pt}px; margin-left: ${-63 * P.pt}px; border-radius: ${19 * P.pt}px; background: #050506; }
.home { position: absolute; left: 50%; bottom: ${8 * P.pt}px; width: ${144 * P.pt}px; height: ${5 * P.pt}px; margin-left: ${-72 * P.pt}px; border-radius: 99px; background: ${shot.dark ? "rgba(255,255,255,0.86)" : "rgba(16,16,20,0.9)"}; }
</style></head><body>
${sky ? `<div class="sky">${skySvg(shot.bg as "meadow" | "madani", L.W, L.H)}</div>` : ""}
<div class="text"><h1>${esc(shot.headline)}</h1>${shot.line ? `<p>${esc(shot.line)}</p>` : ""}</div>
${prop}
<div class="phone"><div class="screen"><img src="${fileUrl(screen)}" alt="">${statusBar(shot.dark)}<div class="island"></div><div class="home"></div></div></div>
${bots}
</body></html>`;
}

function featureHtml() {
  const W = 1024, H = 500;
  const s = scene(512, 250, { cell: 8, seed: 41 });
  s.sky([[C.sky0, 0], [C.sky1, 12], [C.sky2, 21], [C.sky3, 23], [C.canvas, 25]], { fray: [0, 1, 1, 1, 2, 2, 3, 4], stray: 0.16 });
  s.cloud(468, 4, 9, C.pink);
  s.ground(27, { flowers: 7, speckle: 0.05 });
  s.hill(400, 27, 16, 3);
  s.bot("pip", C.blue, 400, 27 * 8 - 24, 3.4);
  s.bot("kit", C.violet, 352, 27 * 8 - 16, 2.4).bot("mochi", C.pinkBot, 452, 27 * 8 - 16, 2.4, { flip: true });
  s.bot("loaf", C.tangerine, 344, 46, 2).bot("goo", C.mint, 380, 38, 2);
  const svg = s.svg().replace(/width="512" height="250"/, `width="${W}" height="${H}"`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Display"; src: url("${fileUrl(join(fonts, "general-sans-semibold.ttf"))}"); }
@font-face { font-family: "Body"; src: url("${fileUrl(join(fonts, "general-sans-medium.ttf"))}"); }
* { margin: 0; padding: 0; } html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
svg { position: absolute; inset: 0; display: block; }
.text { position: absolute; left: 64px; top: 70px; }
h1 { font: 600 66px/1.1 "Display"; letter-spacing: -0.025em; color: #fff; white-space: pre-line; }
p { font: 500 26px/1.4 "Body"; color: rgba(255,255,255,0.94); margin-top: 18px; }
</style></head><body>${svg}<div class="text"><h1>${esc(FEATURE.headline)}</h1><p>${esc(FEATURE.line)}</p></div></body></html>`;
}

/** drops the alpha channel: App Store Connect refuses a screenshot that has one */
function opaque(png: Buffer, width: number, height: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${PAPER}"/><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString("base64")}"/></svg>`;
  return opaquePng72(new Resvg(svg).render());
}

async function main() {
  const missing = [...new Set(SHOTS.map((shot) => shot.screen))].filter((name) => !existsSync(join(raw, `${name}.png`)));
  if (missing.length) throw new Error(`run capture.ts first; missing ${missing.join(", ")} in ${raw}`);
  const profile = mkdtempSync(join(tmpdir(), "madani-store-chrome-"));
  const page = await openHeadlessChrome(profile);
  const written: Array<{ file: string; label: string; width: number; height: number }> = [];
  const render = async (html: string, width: number, height: number, file: string, label: string) => {
    const path = join(work, "page.html");
    writeFileSync(path, html);
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: fileUrl(path) });
    await page.until(`document.readyState === "complete" && document.fonts.status === "loaded" && [...document.images].every((img) => img.complete)`, 20_000);
    await delay(300);
    const png = await page.capture({ x: 0, y: 0, width, height });
    writeFileSync(file, opaque(png, width, height));
    written.push({ file, label, width, height });
    console.log(`${file} ${width}x${height}`);
  };
  try {
    await page.send("Page.enable");
    for (const size of SIZES) {
      const dir = join(store, size.store, size.name);
      mkdirSync(dir, { recursive: true });
      const shots = SHOTS.filter((shot) => (size.store === "play" ? PLAY_SHOTS : IOS_SHOTS).includes(shot.id));
      for (const shot of shots) await render(shotHtml(shot, size), size.width, size.height, join(dir, `${shot.id}.png`), `${size.store} ${size.name} ${shot.id}`);
    }
    await render(featureHtml(), 1024, 500, join(store, "play", "feature-graphic.png"), "play feature graphic");
    // Play's 512 x 512 listing icon is the app icon itself (Play rounds the corners)
    const icon = fileURLToPath(new URL("../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", import.meta.url));
    writeFileSync(join(store, "play", "icon-512.png"), opaque(readFileSync(icon), 512, 512));
    console.log(`${join(store, "play", "icon-512.png")} 512x512`);

    const tiles = written.filter((one) => one.label.startsWith("ios 6.9") || one.label.startsWith("play"));
    const sheet = `<!doctype html><html><head><style>
body { margin: 0; background: #e9e9ee; font: 500 15px system-ui; color: #444; padding: 32px; width: 2400px; }
.row { display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 36px; align-items: flex-start; }
figure { margin: 0; } figure img { display: block; height: 520px; box-shadow: 0 2px 10px rgba(0,0,0,.12); }
figure.wide img { height: 260px; } figcaption { margin-top: 6px; }
h2 { font: 600 20px system-ui; margin: 0 0 14px; color: #222; }
</style></head><body>
<h2>App Store, 6.9 inch (1320 x 2868); 6.5 inch is the same set at 1284 x 2778</h2><div class="row">${tiles.filter((t) => t.label.startsWith("ios")).map((t) => `<figure><img src="${fileUrl(t.file)}"><figcaption>${t.label.split(" ").pop()}</figcaption></figure>`).join("")}</div>
<h2>Google Play, phone (1080 x 1920) and feature graphic (1024 x 500)</h2><div class="row">${tiles.filter((t) => t.label.startsWith("play phone")).map((t) => `<figure><img src="${fileUrl(t.file)}"><figcaption>${t.label.split(" ").pop()}</figcaption></figure>`).join("")}
<figure class="wide"><img src="${fileUrl(join(store, "play", "feature-graphic.png"))}"><figcaption>feature graphic</figcaption></figure></div>
</body></html>`;
    writeFileSync(join(work, "sheet.html"), sheet);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 2464, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: fileUrl(join(work, "sheet.html")) });
    await page.until(`document.readyState === "complete" && [...document.images].every((img) => img.complete)`, 30_000);
    const height = await page.evaluate(`document.body.scrollHeight`);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 2464, height, deviceScaleFactor: 1, mobile: false });
    await delay(400);
    mkdirSync(join(sheetPath, ".."), { recursive: true });
    writeFileSync(sheetPath, await page.capture({ x: 0, y: 0, width: 2464, height }));
    console.log(sheetPath);
  } finally {
    page.close();
    await delay(500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
