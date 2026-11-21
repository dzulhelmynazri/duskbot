// Dragging bots in the real sidebar, against a disposable fake-engine server, with real pointer input from a headless
// Chrome: a click still opens the chat, a few pixels of movement lift the row, the others slide to make room, a drop
// saves the order, Escape puts everything back, and a row can go into a department. MADANI_SIDEBAR_DRAG_STRIP=<png> also
// writes a strip of frames from the drag.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../control-madani.ts";
import { CHROME_PATH, openHeadlessChrome } from "./headless-chrome.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.MADANI_UI_E2E === "1" || existsSync(CHROME_PATH);
if (!enabled) console.info("skipping sidebar drag UI e2e: no Chrome at MADANI_CDP_CHROME");
const NAMES = ["Atlas", "Bea", "Cleo", "Dodo", "Echo"];
const strip = process.env.MADANI_SIDEBAR_DRAG_STRIP;

(enabled ? it : it.skip)("reorders bots by dragging, Discord's way", async () => {
  const fixture = await launchVerificationServer({ ...process.env, MADANI_TEST_PORTS: process.env.MADANI_TEST_PORTS ?? "19700-19790" });
  let ui: MountedPreview | undefined;
  const profile = mkdtempSync(join(tmpdir(), "madani-drag-chrome-"));
  let page: Awaited<ReturnType<typeof openHeadlessChrome>> | undefined;
  try {
    const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
    for (const name of NAMES) await runControlMadani(["new-bot", "--name", name, "--url", fixture.info.url]);
    await api("PATCH", "/api/config", { language: "en" });
    const wire = async () => (await api("GET", "/api/bots?messages=0") as { bots: Array<{ id: string; name: string; section?: string }> }).bots;
    const all = await wire();
    const ids = Object.fromEntries(NAMES.map((name) => [name, all.find((bot) => bot.name === name)!.id]));
    const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
    await api("POST", "/api/sidebar-sections", { name: "Work", botIds: [ids.Dodo, ids.Echo] });
    await api("PUT", "/api/bots/order", { botIds: [...NAMES.map((name) => ids[name]!), ...all.filter((bot) => !names[bot.id]).map((bot) => bot.id)] });
    /** our bots in the server's order, each with its department */
    const saved = async () => (await wire()).filter((bot) => names[bot.id]).map((bot) => `${names[bot.id]}${bot.section ? `@${bot.section}` : ""}`);
    /** the server keeps each list's order; where a moved bot sits among the other lists' bots does not show */
    const savedLists = async () => { const all = await saved(); return [all.filter((name) => !name.includes("@")), all.filter((name) => name.endsWith("@Work"))]; };
    expect(await saved()).toEqual(["Atlas", "Bea", "Cleo", "Dodo@Work", "Echo@Work"]);

    ui = await mountPreview(fixture, { entry: "/scripts/testing/sidebar-groups-preview.tsx", route: "/__sidebar-groups.html", title: "Isolated sidebar drag", logLevel: "warn" });
    page = await openHeadlessChrome(profile);
    const { send, evaluate, until } = page;
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
    // dragging is the person's own order; by recent activity the lists order themselves
    await send("Page.navigate", { url: `${ui.previewUrl}?skin=daylight` });
    await until(`document.querySelector('[data-sidebar-bot-row="${ids.Echo}"]')`);
    await evaluate(`localStorage.setItem("madanibot.sidebarBotOrder", "custom"); window.dispatchEvent(new Event("madani-sidebar-bot-order"))`);
    await until(`document.querySelector('[data-bot-reorder-row="${ids.Echo}"]')`);
    await delay(800);

    const centre = async (name: string) => await evaluate(`(() => { const box = document.querySelector('[data-sidebar-bot-row="${ids[name]}"]').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`) as { x: number; y: number };
    const shown = async () => await evaluate(`[...document.querySelectorAll('[data-sidebar-bot-row]')].map((row) => row.dataset.sidebarBotRow)`) as string[];
    const shownNames = async () => (await shown()).map((id) => names[id]).filter(Boolean);
    const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    const lifted = () => evaluate(`Boolean(document.querySelector('[data-bot-lifted]'))`) as Promise<boolean>;
    const moved = () => evaluate(`[...document.querySelectorAll('[data-bot-reorder-row], [data-sidebar-section-id]')].filter((node) => node.style.transform).length`) as Promise<number>;
    const frames: Buffer[] = [];
    const frame = async () => {
      if (!strip) return;
      const box = await evaluate(`(() => { const box = document.querySelector('aside[data-sidebar]').getBoundingClientRect(); return { x: box.left, y: box.top, width: box.width, height: Math.min(box.height, 520) }; })()`) as { x: number; y: number; width: number; height: number };
      frames.push(await page!.capture(box));
    };
    /** pointer down on `from`, lifted by a 6px nudge toward `to` (so the row's centre stays 6px behind the pointer), then
     * along to `to` in steps; the caller lets go */
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) => {
      await mouse("mousePressed", from.x, from.y);
      await mouse("mouseMoved", from.x, from.y + Math.sign(to.y - from.y) * 6);
      await delay(60);
      for (let step = 1; step <= steps; step++) {
        await mouse("mouseMoved", from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
        await delay(24);
      }
      await delay(260);
    };

    // a plain click opens the chat and lifts nothing
    await frame();
    const bea = await centre("Bea");
    await mouse("mousePressed", bea.x, bea.y);
    await mouse("mouseMoved", bea.x, bea.y + 2);
    expect(await lifted(), "two pixels is still a click").toBe(false);
    await mouse("mouseReleased", bea.x, bea.y + 2);
    await until(`document.querySelector('[data-sidebar-bot-row="${ids.Bea}"]').getAttribute('aria-current') === 'page'`, 10_000);
    expect(await saved()).toEqual(["Atlas", "Bea", "Cleo", "Dodo@Work", "Echo@Work"]);

    // Atlas, dragged under Cleo: it lifts, Bea and Cleo slide up, the line shows, and the drop saves the order
    const atlas = await centre("Atlas"), cleo = await centre("Cleo");
    await mouse("mousePressed", atlas.x, atlas.y);
    await mouse("mouseMoved", atlas.x, atlas.y + 6);
    await delay(120);
    expect(await lifted(), "six pixels lifts the row").toBe(true);
    await frame();
    for (let step = 1; step <= 10; step++) { await mouse("mouseMoved", atlas.x, atlas.y + 6 + ((cleo.y + 14 - atlas.y - 6) * step) / 10); await delay(24); }
    await delay(260);
    expect(await moved(), "the rows Atlas passed made room").toBeGreaterThanOrEqual(2);
    expect(await evaluate(`document.querySelector('[data-bot-drop-line]').style.opacity`)).toBe("1");
    await frame();
    await mouse("mouseReleased", atlas.x, cleo.y + 14);
    await delay(420);
    await frame();
    expect(await lifted()).toBe(false);
    expect(await moved(), "every slide is undone once the rows are in their new order").toBe(0);
    expect(await shownNames()).toEqual(["Dodo", "Echo", "Bea", "Cleo", "Atlas"]);
    await expect.poll(savedLists, { timeout: 5_000 }).toEqual([["Bea", "Cleo", "Atlas"], ["Dodo@Work", "Echo@Work"]]);
    expect(await evaluate(`document.querySelector('[data-sidebar-bot-row="${ids.Bea}"]').getAttribute('aria-current')`), "the drop opened no chat").toBe("page");

    // Escape mid-drag puts everything back and saves nothing
    const dodo = await centre("Dodo");
    await drag(await centre("Cleo"), dodo);
    expect(await moved()).toBeGreaterThan(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await delay(420);
    await mouse("mouseReleased", dodo.x, dodo.y);
    await delay(100);
    expect(await lifted()).toBe(false);
    expect(await moved()).toBe(0);
    expect(await shownNames()).toEqual(["Dodo", "Echo", "Bea", "Cleo", "Atlas"]);
    expect(await savedLists()).toEqual([["Bea", "Cleo", "Atlas"], ["Dodo@Work", "Echo@Work"]]);

    // Cleo, dragged up between Dodo and Echo, joins Work there
    const echo = await centre("Echo");
    await drag(await centre("Cleo"), { x: echo.x, y: echo.y - 14 });
    await frame();
    await mouse("mouseReleased", echo.x, echo.y - 14);
    await delay(420);
    await frame();
    await expect.poll(shownNames, { timeout: 5_000 }).toEqual(["Dodo", "Cleo", "Echo", "Bea", "Atlas"]);
    await expect.poll(savedLists, { timeout: 5_000 }).toEqual([["Bea", "Atlas"], ["Dodo@Work", "Cleo@Work", "Echo@Work"]]);

    // Alt+Down from the keyboard moves the focused row one place
    await evaluate(`document.querySelector('[data-sidebar-bot-row="${ids.Bea}"]').focus()`);
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 1 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 1 });
    await expect.poll(shownNames, { timeout: 5_000 }).toEqual(["Dodo", "Cleo", "Echo", "Atlas", "Bea"]);

    if (strip && frames.length) {
      await send("Page.navigate", { url: "about:blank" });
      await delay(200);
      await evaluate(`(() => {
        document.body.style.cssText = "margin:0;display:flex;gap:16px;padding:16px;background:#e9e9ec;width:max-content";
        for (const data of ${JSON.stringify(frames.map((png) => png.toString("base64")))}) {
          const img = new Image(); img.src = "data:image/png;base64," + data; img.style.cssText = "width:" + (img.naturalWidth || 260) + "px;border-radius:8px";
          img.onload = () => { img.style.width = img.naturalWidth / 2 + "px"; };
          document.body.append(img);
        }
        return true;
      })()`);
      await delay(500);
      const size = await evaluate(`({ width: document.body.scrollWidth, height: document.body.scrollHeight })`) as { width: number; height: number };
      await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
      writeFileSync(strip, await page.capture({ x: 0, y: 0, width: size.width, height: size.height }));
    }
  } finally {
    page?.close();
    await ui?.close();
    await fixture.close();
    await delay(300);
    rmSync(profile, { recursive: true, force: true });
  }
}, 300_000);
