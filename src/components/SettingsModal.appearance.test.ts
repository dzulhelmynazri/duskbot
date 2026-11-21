import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { SendKey } from "@/lib/send-key";
import { en, locales } from "@/locales";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { SettingsModal } from "./SettingsModal";
import { themeOptions } from "./ThemeRow";

const fixture = vi.hoisted(() => ({
  section: "appearance" as AppSettingsSection,
  showRunCard: true,
  setShowRunCard: vi.fn(),
  toolsLayout: "rows" as "rows" | "toolbar",
  setSidebarToolsLayout: vi.fn(),
  notificationSounds: true,
  setNotificationSounds: vi.fn(),
  sendKey: "enter" as SendKey,
  setSendKey: vi.fn(),
  colorUserBubbles: false,
  setColorUserBubbles: vi.fn(),
  advancedMode: false,
  api: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
}));
// The Cloud account card reads the host platform (what a saved sign-in still locked asks for).
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" } } }) }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: [], bots: [] }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/run-card-preferences", () => ({
  useShowRunCard: () => fixture.showRunCard,
  setShowRunCard: fixture.setShowRunCard,
}));
vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarToolsLayout: () => fixture.toolsLayout,
  setSidebarToolsLayout: fixture.setSidebarToolsLayout,
}));
vi.mock("@/lib/notification-preferences", () => ({
  useNotificationSounds: () => fixture.notificationSounds,
  setNotificationSounds: fixture.setNotificationSounds,
  useFinishedNotifications: () => true,
  setFinishedNotifications: vi.fn(),
}));
vi.mock("@/lib/send-key", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/send-key")>(),
  useSendKey: () => fixture.sendKey,
  setSendKey: fixture.setSendKey,
}));
vi.mock("@/lib/user-bubble-preference", () => ({
  useColorUserBubbles: () => fixture.colorUserBubbles,
  setColorUserBubbles: fixture.setColorUserBubbles,
}));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("./PeopleSection", () => ({ PeopleSection: () => null }));
vi.mock("./LocalComputerSection", () => ({ LocalComputerSection: () => null }));
vi.mock("./SettingsPrimitives", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SettingsPrimitives")>();
  return {
    ...original,
    Switch: (props: ComponentProps<typeof Switch>) => {
      fixture.switches.push(props);
      return createElement(original.Switch, props);
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "appearance";
  fixture.showRunCard = true;
  fixture.toolsLayout = "rows";
  fixture.notificationSounds = true;
  fixture.sendKey = "enter";
  fixture.colorUserBubbles = false;
  fixture.advancedMode = false;
  fixture.switches = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));

// a select's shown value: a chip's label, or the checked segment of a segmented pill
const trigger = (html: string, label: string) => html.match(new RegExp(`role="combobox" aria-label="${label}"[^>]*>(?:<[^>]+>)*([^<]+)<`))?.[1]
  ?? html.match(new RegExp(`role="radiogroup" aria-label="${label}".*?role="radio" aria-checked="true"[^>]*>([^<]+)<`))?.[1];

describe("Settings → General → Appearance", () => {
  it("draws Grok's Appearance card: Theme, Accent and Language, with no Advanced mode switch", () => {
    fixture.section = "general";
    const html = render();
    expect(trigger(html, "Theme")).toBeTruthy();
    expect(trigger(html, "Your message color")).toBe("Neutral");
    expect(trigger(html, "Language")).toBeTruthy();
    expect(html).not.toContain('aria-label="advanced mode"');
  });

  it("shows the bot's colour as the Accent once chosen", () => {
    fixture.section = "general";
    fixture.colorUserBubbles = true;
    expect(trigger(render(), "Your message color")).toBe("Bot color");
  });

  it("keeps the app language reachable from a paired remote client", () => {
    fixture.section = "general";
    vi.stubGlobal("window", { madaniDesktop: { remoteClient: { active: true } } });
    const html = render();
    expect(html).toContain('aria-label="Language"');
    expect(html).not.toContain('aria-label="advanced mode"');
  });

  it("has no Advanced mode switch in Builder Controls: there is one layout", () => {
    fixture.section = "builder";
    expect(render()).not.toContain('aria-label="advanced mode"');
  });

  it("folds the old Looks page into Appearance: the skins sit in the Theme select, with nothing about pins, fonts, widths or tool calls", () => {
    expect(themeOptions().map((option) => option.label)).toEqual(expect.arrayContaining(["Follow system", "Light", "Dark", "Midnight", "Halloween"]));
    expect(themeOptions().map((option) => option.label)).not.toContain("grok dark");
    for (const section of ["general", "looks"] as const) {
      fixture.section = section;
      const html = render();
      expect(trigger(html, "Theme")).toBeTruthy();
      for (const gone of ['aria-label="Skin"', "Pinned bots as circles", "Universal pins", "Show tool calls in chat", "Chat width", 'aria-label="Font"', "Show threads", "Show the run card"]) {
        expect(html, gone).not.toContain(gone);
      }
    }
  });

  it("has no Settings switch for a rail of places", () => {
    fixture.section = "general";
    expect(render()).not.toContain("Show your computers");
  });

  it("names every switch by the words its row shows, so voice control can say them", () => {
    fixture.section = "general";
    const html = render();
    const names = fixture.switches.map((props) => props["aria-label"]!);
    expect(names).toContain("Quick updates while working");
    expect(names.filter((name) => !html.includes(`>${name}<`))).toEqual([]);
  });

  it.each([true, false])("mutes notification sounds on this computer only when the switch is %s", (enabled) => {
    fixture.section = "general";
    fixture.notificationSounds = enabled;
    const html = render();
    expect(html).toContain("Play sound for notifications");
    const toggle = fixture.switches.find((props) => props["aria-label"] === "Play sound for notifications")!;
    expect(toggle.checked).toBe(enabled);
    toggle.onClick!({} as never);
    expect(fixture.setNotificationSounds).toHaveBeenCalledWith(!enabled);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("has no choice of sidebar density: the sidebar's edge is dragged instead", () => {
    fixture.section = "general";
    const html = render();
    expect(html).not.toContain("Sidebar density");
    expect(html).not.toContain(">Avatars only<");
  });

  it("drops the tools layout row, which only the removed Advanced mode read", () => {
    fixture.section = "general";
    expect(render()).not.toContain("Tools layout");
  });

  it.each([
    ["enter", "Enter"],
    ["shift-enter", "Shift+Enter"],
    ["mod-enter", "Ctrl+Enter"],
  ] as const)("shows the saved send key (%s) in System, on this device only", (sendKey, label) => {
    fixture.section = "general";
    fixture.sendKey = sendKey;
    const html = render();
    expect(html).toContain("Send messages with");
    expect(trigger(html, "Send messages with")).toBe(label);
    expect(fixture.setSendKey).not.toHaveBeenCalled();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("asks Japanese speakers in Japanese", () => {
    setLocale("ja");
    fixture.section = "general";
    fixture.sendKey = "shift-enter";
    const html = render();
    expect(html).toContain("メッセージの送信キー");
    expect(html).toContain(">Shift+Enter<");
  });

  it("lands the old experiments link on apps and tools, with skill learning there and no developer switches", () => {
    fixture.section = "builder";
    const html = render();
    expect(html).toContain("Apps and tools");
    expect(html).toContain("What bots learn");
    for (const gone of ["Experimental features", "New browser", "event log"]) expect(html, gone).not.toContain(gone);
    for (const gone of ["Group turn time limit", "Tasks at once per bot", "MCP tool call", "Automatic recovery"]) expect(html, gone).not.toContain(gone);
    fixture.section = "general";
    const general = render();
    for (const text of ["Automatic recovery", "Experimental features"]) expect(general, text).not.toContain(text);
  });

  it("keeps the local look reachable remotely without exposing server settings", () => {
    fixture.section = "looks";
    vi.stubGlobal("window", { madaniDesktop: { remoteClient: { active: true } } });
    const html = render();
    expect(html).toContain('aria-label="Theme"');
    expect(html).not.toContain('data-settings-page="updates"');
    expect(html).not.toContain('data-settings-page="permissions"');
  });

  it("offers full backups in Privacy and Data", () => {
    fixture.section = "backups";
    const html = render();
    expect(html).toContain("Export full backup");
    expect(html).toContain('type="file" accept=".madanibackup,.ombbackup"');
  });

  it("renders Appearance in Japanese", () => {
    setLocale("ja");
    fixture.section = "looks";
    const html = render();
    for (const key of ["settings.section.appearance", "settings.language.title"] as const) {
      expect(locales.ja[key], key).toBeTruthy();
      expect(locales.ja[key], key).not.toBe(en[key]);
      expect(html, key).toContain(locales.ja[key]!);
    }
  });

  it("uses English fallback for new keys in an incomplete language pack", () => {
    locales.zz = {};
    try {
      setLocale("zz");
      fixture.section = "looks";
      const html = render();
      expect(html).toContain("How it looks");
      expect(html).toContain('aria-label="Theme"');
      expect(html).not.toContain("settings.theme");
      expect(html).not.toContain("settings.section");
    } finally {
      delete locales.zz;
      setLocale("en");
    }
  });

  it("offers desktop connections on Computer, open, without exposing the list remotely", () => {
    fixture.section = "desktopWorkspaces";
    vi.stubGlobal("window", { madaniDesktop: { environments: {} } });
    // connect from elsewhere says what it is for; servers are added from Computer's own list
    const local = render();
    expect(local).toContain("Use your bots from your phone or another computer.");
    expect(local).not.toContain("Your servers");
    fixture.section = "computer";
    vi.stubGlobal("window", { madaniDesktop: { workspaces: {} } });
    expect(render()).not.toContain('data-settings-block="desktopWorkspaces"');
  });

  it("offers optional Organisation settings only through the local desktop bridge", () => {
    fixture.section = "organization";
    vi.stubGlobal("window", { madaniDesktop: { organization: {} } });
    expect(render()).toContain('data-panel-page="organization"');
    vi.stubGlobal("window", {});
    expect(render()).not.toContain('data-panel-page="organization"');
    vi.stubGlobal("window", { madaniDesktop: { organization: {}, remoteClient: { active: true } } });
    expect(render()).not.toContain('data-panel-page="organization"');
  });

  it("offers personal Cloud in Usage and Billing, only through the local desktop bridge", () => {
    fixture.section = "cloudAccount";
    vi.stubGlobal("window", { madaniDesktop: { cloudAccount: {} } });
    expect(render()).toContain('data-settings-block="cloudAccount"');
    vi.stubGlobal("window", {});
    expect(render()).not.toContain('data-settings-block="cloudAccount"');
  });
});
