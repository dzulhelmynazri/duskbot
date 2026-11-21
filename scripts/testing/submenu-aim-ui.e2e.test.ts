// The account menu's Support submenu stays open while the pointer crosses the row below on its way to the submenu, and
// closes when the pointer heads away. Pointer paths are only provable in a browser.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { CHROME_PATH, openHeadlessChrome, type HeadlessPage } from "./headless-chrome.ts";
import { mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.MADANI_UI_E2E === "1" || existsSync(CHROME_PATH);
if (!enabled) console.info("skipping submenu aim UI e2e: no Chrome at MADANI_CDP_CHROME");

(enabled ? it : it.skip)("keeps the Support submenu open on a diagonal path and closes it on a straight one", async () => {
  const profile = mkdtempSync(join(tmpdir(), "madani-submenu-chrome-"));
  let ui: MountedPreview | undefined;
  let page: HeadlessPage | undefined;
  try {
    ui = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, { entry: "/scripts/testing/submenu-aim-preview.tsx", route: "/__submenu-aim.html", title: "Isolated submenu aim", logLevel: "warn" });
    page = await openHeadlessChrome(profile);
    const { send, evaluate, until } = page;
    await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: ui.previewUrl });
    await until(`document.querySelector('button[aria-haspopup="menu"]')`);

    const mouse = (x: number, y: number) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    const box = (selector: string) => evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`) as Promise<{ left: number; right: number; top: number; bottom: number; x: number; y: number }>;
    const subOpen = () => evaluate(`Boolean(document.querySelector('[data-sidebar-popover-submenu]'))`) as Promise<boolean>;
    const row = (key: string) => `[data-sidebar-popover-menu] [data-menu-key="${key}"]`;
    const walk = async (from: { x: number; y: number }, to: { x: number; y: number }, steps = 14, pause = 20) => {
      for (let step = 1; step <= steps; step++) {
        await mouse(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
        await delay(pause);
      }
    };
    const openSupport = async () => {
      await mouse(5, 5);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
      await until(`!document.querySelector('[data-sidebar-popover-menu]')`);
      const trigger = await box('button[aria-haspopup="menu"]');
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: trigger.x, y: trigger.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: trigger.x, y: trigger.y, button: "left", clickCount: 1 });
      await until(`document.querySelector('${row("support")}')`);
      await delay(300);
      const support = await box(row("support"));
      await walk({ x: support.left - 40, y: support.y }, { x: support.left + 30, y: support.y }, 4);
      await until(`document.querySelector('[data-sidebar-popover-submenu]')`);
      await delay(250);
      return { support, from: { x: support.left + 30, y: support.y } };
    };

    // down and toward the submenu's lower rows, across Settings, ending inside the submenu
    let { from } = await openSupport();
    const sub = await box("[data-sidebar-popover-submenu]");
    const target = await box(`[data-sidebar-popover-submenu] [data-menu-key="export"]`);
    await walk(from, { x: sub.left + 20, y: target.y }, 24, 40);
    await delay(500);
    expect(await subOpen(), "a diagonal path across Settings keeps the submenu").toBe(true);
    const settings = await box(row("settings"));
    expect(target.y, "the path really passed the Settings row's height").toBeGreaterThan(settings.top);

    // straight across into the 4px between the menu and the submenu, resting there
    ({ from } = await openSupport());
    const menu = await box("[data-sidebar-popover-menu]");
    const gapSub = await box("[data-sidebar-popover-submenu]");
    const gapX = (menu.right + gapSub.left) / 2;
    await walk(from, { x: gapX, y: from.y }, 8);
    await delay(500);
    expect(await subOpen(), "resting in the gap keeps the submenu").toBe(true);
    await walk({ x: gapX, y: from.y }, { x: gapSub.left + 20, y: from.y }, 4);
    await delay(300);
    expect(await subOpen(), "and it is still there once inside").toBe(true);

    // straight down away from the submenu: Settings, then Sign out
    ({ from } = await openSupport());
    const signOut = await box(row("signout"));
    await walk(from, { x: from.x, y: signOut.y }, 10);
    await delay(500);
    expect(await subOpen(), "a straight path down closes it").toBe(false);
  } finally {
    page?.close();
    await ui?.close();
    await delay(300);
    rmSync(profile, { recursive: true, force: true });
  }
}, 120_000);
