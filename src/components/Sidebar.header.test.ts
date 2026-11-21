import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialDesktopCapabilities } from "@/lib/desktop";
import { setLocale } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { StoreProvider } from "@/state/store";

const fixture = vi.hoisted(() => ({
  density: "comfortable" as SidebarDensity,
  advanced: true,
  windowChrome: undefined as "mac-inset" | "win-caption" | "native" | undefined,
  windowFrame: undefined as boolean | undefined,
  hostLabel: undefined as string | undefined,
}));

vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarDensity: () => fixture.density,
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => {
    const capabilities = initialDesktopCapabilities();
    const host = { ...capabilities.host, label: fixture.hostLabel ?? capabilities.host.label };
    return { capabilities: { ...capabilities, host, windowChrome: fixture.windowChrome, windowFrame: fixture.windowFrame }, ready: true };
  },
}));

import { Sidebar } from "./Sidebar";

const render = () => renderToStaticMarkup(
  createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => {} })),
);

beforeEach(() => {
  fixture.density = "comfortable";
  fixture.advanced = true;
  fixture.windowChrome = undefined;
  fixture.windowFrame = undefined;
  fixture.hostLabel = undefined;
  vi.stubGlobal("window", { innerWidth: 1280, location: { protocol: "http:", search: "" } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("sidebar header", () => {
  const collapse = /aria-label="(Collapse sidebar to avatars|Expand sidebar)"|data-sidebar-edge-toggle/;

  it.each(["comfortable", "icons"] as const)("keeps add, no activity menu and no collapse button in Simple mode at %s density: its edge is dragged instead; open or as avatars it drops the Inbox, as grok has none", (density) => {
    fixture.advanced = false;
    fixture.density = density;
    const html = render();
    expect(html).not.toContain('aria-label="Inbox"');
    expect(html).not.toContain('aria-label="Active threads"');
    expect(html).toContain(density === "icons" ? 'aria-label="New or share"' : 'aria-label="New bot"');
    expect(html).not.toMatch(collapse);
    expect(html, "the edge that is dragged, open or as avatars, so the avatars are never a dead end").toMatch(/role="separator" aria-label="Resize sidebar"/);
  });
});

describe("sidebar top row", () => {
  const desktop = () => vi.stubGlobal("window", {
    innerWidth: 1280,
    location: { protocol: "http:", search: "" },
    madaniDesktop: { workspaces: { state: () => new Promise(() => {}), menu: () => Promise.resolve() } },
  });
  const topRow = (html: string) => {
    const start = html.indexOf("data-sidebar-top-row");
    const end = html.includes('aria-label="New or share"') ? html.indexOf('aria-label="New or share"') : html.indexOf('aria-label="New bot"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return html.slice(start, end);
  };
  const classesOf = (html: string, attribute: string) => {
    const match = new RegExp(`${attribute}(?:="[^"]*")? class="([^"]*)"`).exec(html);
    expect(match, attribute).not.toBeNull();
    return match![1].split(" ");
  };
  const order = (row: string) => ({
    lights: row.indexOf("data-traffic-light-space"),
    slot: row.indexOf("data-sidebar-top-slot"),
    spacer: row.indexOf("data-sidebar-top-spacer"),
    switcher: row.indexOf('data-workspace-switcher="inline"'),
    buttons: row.indexOf("data-sidebar-top-buttons"),
  });

  it.each(["mac-inset", "win-caption"] as const)("in Simple mode on %s keeps only the top corner: plain search and + at its right end, no drag region, no server pill, nothing on the edge", (windowChrome) => {
    fixture.advanced = false;
    fixture.windowChrome = windowChrome;
    desktop();
    const html = render();
    const row = topRow(html);
    expect(row, "the bot tiles rise into the rest of the corner: no drag region, no clicks but the buttons'").toMatch(/^data-sidebar-top-row="corner" class="[^"]*\bpointer-events-none\b[^"]*\bh-\[34px\][^"]*\bitems-start\b[^"]*">/);
    expect(classesOf(row, "data-sidebar-top-row")).toEqual(expect.arrayContaining(["justify-end", "px-1.5", "pt-1.5"]));
    expect(row).not.toContain("data-workspace-switcher");
    expect(html).not.toContain("switch server:");
    const { lights, slot, buttons } = order(row);
    expect(lights).toBe(-1);
    expect(buttons).toBeGreaterThan(slot);
    expect(classesOf(row, "data-sidebar-top-buttons")).toEqual(expect.arrayContaining(["shrink-0", "pointer-events-auto"]));
    expect(row.slice(buttons).match(/<button/g)).toHaveLength(2);
    expect(row).toMatch(/data-sidebar-search-toggle="true" aria-label="Search" aria-expanded="false" title="Search" class="[^"]*\bsize-7\b[^"]*\brounded-lg\b[^"]*\btext-ink-secondary\b/);
    expect(row, "no round box round either").not.toContain("bg-composer");
    expect(html).toMatch(/aria-label="New or share" class="[^"]*\bsize-7\b[^"]*\brounded-lg\b/);
    expect(html).not.toContain("data-sidebar-edge-toggle");
    expect(html).not.toContain('title="Active threads"');
    expect(html).not.toContain("data-sidebar-search-pill");
  });

  it("draws no window buttons in a browser, where the browser has its own", () => {
    const row = topRow(render());
    expect(row).not.toContain("bg-[#ff5f57]");
    expect(row).not.toContain("data-traffic-light-space");
    const { spacer, buttons } = order(row);
    expect(buttons).toBeGreaterThan(spacer);
  });

  it("collapses Simple mode to a narrow rail: no search and no feedback, and + above Apps and the account at the foot", () => {
    fixture.advanced = false;
    fixture.density = "icons";
    fixture.windowChrome = "mac-inset";
    desktop();
    const html = render();
    const top = html.slice(html.indexOf("data-sidebar-top-row"), html.indexOf("data-sidebar-rail-footer"));
    expect(top).not.toContain("data-traffic-light-space");
    expect(top).not.toContain("data-sidebar-top-buttons");
    expect(top).not.toContain("data-workspace-switcher");
    expect(top).not.toContain("data-sidebar-rail-top");
    expect(top).not.toContain('aria-label="New or share"');
    expect(html).not.toContain('aria-label="Search bots and messages"');
    const foot = html.slice(html.indexOf("data-sidebar-rail-footer"));
    const at = (marker: string) => {
      const index = foot.indexOf(marker);
      expect(index, marker).toBeGreaterThan(-1);
      return index;
    };
    expect(html).not.toContain("data-sidebar-edge-toggle");
    expect(foot).not.toContain('data-sidebar-spot="feedback"');
    const positions = [
      at('aria-label="New or share"'),
      at('data-sidebar-nav="apps"'),
      at("data-sidebar-account"),
    ];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(foot).toMatch(/aria-label="New or share" class="(?=[^"]*\bsize-10\b)(?=[^"]*\brounded-full\b)/);
    expect(foot).toMatch(/data-tour="nav-apps" data-sidebar-nav="apps"[^>]*aria-label="Connect apps"[^>]*class="[^"]*\bh-10\b[^"]*\bmin-w-10\b[^"]*">(<[^>]*>)*<svg [^>]*class="[^"]*\bui-icon\b[^"]*" data-icon-name="grid-plus"/);
    expect(foot).not.toContain("data-workspace-switcher");
    expect(foot).not.toContain('data-sidebar-nav="automations"');
    expect(foot).not.toContain('data-sidebar-nav="team-map"');
    expect(html).not.toContain("switch server:");
    expect(html.match(/aria-label="New or share"/g)).toHaveLength(1);
  });

});

describe("the window's rail of places", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { innerWidth: 1280, location: { protocol: "http:", search: "" }, madaniDesktop: { workspaces: { state: () => new Promise(() => {}), menu: () => Promise.resolve() } } });
  });

  it("has no button to hide or show it in any row of the sidebar, on any window or density", () => {
    for (const windowChrome of ["mac-inset", "win-caption"] as const) {
      fixture.windowChrome = windowChrome;
      for (const [advanced, density] of [[true, "comfortable"], [false, "comfortable"], [true, "icons"], [false, "icons"]] as const) {
        fixture.advanced = advanced;
        fixture.density = density;
        const html = render();
        expect(html, `${windowChrome}, ${advanced ? "advanced" : "Simple"}, ${density}`).not.toContain("data-rail-toggle");
        expect(html).not.toContain("Hide your computers");
      }
    }
  });
});

