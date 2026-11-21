// The rail of Clouds and its ＋ sheet in the real app, as a Cloud's page in the desktop window shows them, against a
// disposable fake-engine server; the desktop bridge's rail and add-a-Cloud answers are the preview's own fixtures.
// Run: node --experimental-strip-types scripts/verify-cloud-rail.ts [--shots <dir> [--only <view,view>] [--size <width>x<height>]]
// With --shots it photographs each view in a light and a dark skin with a headless Chrome in a throwaway profile
// (MADANI_CDP_CHROME, else the installed Google Chrome) at twice the window's size (1280x800 unless --size says) and
// exits; without, it prints the preview's address and waits. The desktop window shows no rail (electron/main.mjs); the
// rail-hidden and rail-chrome-hidden views are the window as it is now, the others the rail's page as it would draw.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlMadani } from "./control-madani.ts";
import { madaniPng } from "./testing/madani-banner.ts";
import { openHeadlessChrome } from "./testing/headless-chrome.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const at = process.argv.indexOf("--shots");
const shots = at === -1 ? null : resolve(process.argv[at + 1] ?? "");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? null : new Set((process.argv[onlyAt + 1] ?? "").split(",").filter(Boolean));
const sizeAt = process.argv.indexOf("--size");
const size = /^(\d{3,4})x(\d{3,4})$/.exec(sizeAt === -1 ? "1280x800" : process.argv[sizeAt + 1] ?? "");
if (!size) throw new Error("--size takes the window's width and height, such as 1338x870");
const [WIDTH, HEIGHT] = [Number(size[1]), Number(size[2])];
const RAIL = "[data-places-rail]";
const TOP_ROW = "[data-sidebar-top-row]";
/** Each view: its query, what must be on screen before the picture, and the window's height. */
const VIEWS: Array<{ name: string; query: string; ready: string; height?: number; banner?: true }> = [
  { name: "rail", query: "", ready: RAIL },
  { name: "rail-simple", query: "mode=simple", ready: RAIL },
  { name: "rail-hidden", query: "hidden=1", ready: TOP_ROW },
  { name: "rail-hidden-simple", query: "mode=simple&hidden=1", ready: TOP_ROW },
  { name: "rail-icons", query: "density=icons", ready: RAIL },
  { name: "rail-icons-simple", query: "mode=simple&density=icons", ready: RAIL },
  { name: "rail-chrome", query: "chrome=1", ready: TOP_ROW },
  { name: "rail-chrome-simple", query: "mode=simple&chrome=1", ready: TOP_ROW },
  { name: "rail-chrome-hidden", query: "chrome=1&hidden=1", ready: TOP_ROW },
  { name: "rail-chrome-hidden-simple", query: "mode=simple&chrome=1&hidden=1", ready: TOP_ROW },
  { name: "place-button-simple", query: "place=computer&mode=simple&frame=off", ready: "[data-sidebar-place] button" },
  { name: "place-button", query: "place=computer&frame=off", ready: "[data-sidebar-place] button" },
  { name: "general-settings-simple", query: "mode=simple&settings=general", ready: "[data-settings-block='appearance']" },
  { name: "rail-many", query: "places=many&more=1", ready: "[data-rail-more] li" },
  { name: "add-sheet", query: "sheet=add", ready: "[data-place-add='choose']" },
  { name: "add-own-server", query: "sheet=server", ready: "[data-place-add='own-server']" },
  { name: "add-buy-cloud", query: "sheet=cloud", ready: "[data-plan-buy]", height: 900 },
  { name: "add-name-colour", query: "sheet=name", ready: "[data-cloud-add='extra-name']" },
  { name: "add-setting-up", query: "sheet=cloud&adding=setting_up", ready: "[data-cloud-add='extra-starting']" },
  { name: "rail-servers", query: "places=servers&look=teal", ready: "[data-rail-server]" },
  { name: "connect-server", query: "places=servers&sheet=connect", ready: "[data-place-add='connect-server']" },
  { name: "look-settings", query: "look=teal&settings=look", ready: "[data-place-look='admin']" },
  { name: "look-settings-simple", query: "look=teal&mode=simple&settings=look", ready: "[data-place-look='admin']" },
  { name: "look-member", query: "member=1&settings=look", ready: "[data-place-look='locked']" },
  { name: "look-member-simple", query: "member=1&mode=simple&settings=look", ready: "[data-place-look='locked']" },
  { name: "rail-colour", query: "places=servers&look=teal&menu=vps", ready: "[data-rail-menu='vps']" },
  { name: "rail-colour-member", query: "member=1&menu=acme", ready: "[data-rail-menu-note]" },
  // This computer's own page on a desktop with no Cloud: plain, in a colour, its Settings, and the rail beside it.
  { name: "computer", query: "place=computer", ready: "[data-sidebar-top-row]" },
  { name: "computer-simple", query: "place=computer&mode=simple", ready: "[data-sidebar-top-row]" },
  { name: "computer-colour", query: "place=computer&look=teal", ready: "[data-place-tint]" },
  { name: "computer-colour-simple", query: "place=computer&look=teal&mode=simple", ready: "[data-place-tint]" },
  { name: "computer-settings", query: "place=computer&settings=look", ready: "[data-place-picture]" },
  { name: "computer-settings-simple", query: "place=computer&mode=simple&settings=look", ready: "[data-place-picture]" },
  { name: "computer-colour-settings", query: "place=computer&look=teal&settings=look", ready: "[data-place-look='local'] [aria-checked='true']" },
  { name: "computer-colour-settings-simple", query: "place=computer&look=teal&mode=simple&settings=look", ready: "[data-place-look='local'] [aria-checked='true']" },
  { name: "computer-rail", query: "place=computer&look=teal&rail=1", ready: "[data-rail-place='local']" },
  { name: "computer-rail-colour", query: "place=computer&look=teal&rail=1&menu=local", ready: "[data-rail-menu='local']" },
  // The workspace's banner picture, kept on the fixture server first (each view after it shows it).
  { name: "banner", query: "", ready: "[data-place-banner] img", banner: true },
  { name: "banner-simple", query: "mode=simple", ready: "[data-place-banner] img", banner: true },
  { name: "banner-settings", query: "settings=look", ready: "[data-place-picture='set']", banner: true },
  { name: "computer-banner", query: "place=computer", ready: "[data-place-banner] img", banner: true },
  { name: "computer-banner-simple", query: "place=computer&mode=simple", ready: "[data-place-banner] img", banner: true },
  { name: "computer-banner-settings", query: "place=computer&settings=look", ready: "[data-place-picture='set']", banner: true },
  { name: "computer-banner-settings-simple", query: "place=computer&mode=simple&settings=look", ready: "[data-place-picture='set']", banner: true },
];
const SKINS = [{ id: "daylight", look: "light" }, { id: "midnight", look: "dark" }];

/** The preview in a headless Chrome: navigate, wait for a selector, photograph. */
async function openChrome(profile: string) {
  const page = await openHeadlessChrome(profile);
  return {
    /** Photographs the page once `ready` shows. */
    async shoot(url: string, ready: string, file: string, height = HEIGHT): Promise<void> {
      await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: 2, mobile: false });
      await page.send("Page.navigate", { url });
      await page.until(`document.querySelector(${JSON.stringify(ready)}) && document.querySelector("[data-sidebar-bot-row], [data-sidebar-hero]")`);
      await delay(900);
      writeFileSync(file, await page.capture());
    },
    close: page.close,
  };
}

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  for (const name of ["Chief of Staff", "Research", "Inbox"]) await runControlMadani(["new-bot", "--name", name, "--url", fixture.info.url]);
  ui = await mountPreview(fixture, { entry: "/scripts/testing/rail-preview.tsx", route: "/__cloud-rail.html", title: "Isolated rail of Clouds", logLevel: "warn" });
  if (!shots) {
    console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
    await parkUntilSignal();
  } else {
    mkdirSync(shots, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "madani-rail-chrome-"));
    const chrome = await openChrome(profile);
    try {
      let banner = false;
      for (const view of VIEWS.filter((entry) => !only || only.has(entry.name))) for (const skin of SKINS) {
        if (view.banner && !banner) {
          const kept = await fetch(`${fixture.info.url}/api/workspace/banner`, { method: "PUT", headers: { "content-type": "image/png", origin: fixture.info.url }, body: new Uint8Array(madaniPng()) });
          if (!kept.ok) throw new Error(`the banner wasn't kept (${kept.status}): ${await kept.text()}`);
          banner = true;
        }
        const file = join(shots, `${view.name}-${skin.look}.png`);
        await chrome.shoot(`${ui.previewUrl}?skin=${skin.id}${view.query ? `&${view.query}` : ""}`, view.ready, file, view.height);
        console.log(file);
      }
    } finally {
      chrome.close();
      await delay(500);
      rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  await ui?.close();
  await fixture.close();
}
