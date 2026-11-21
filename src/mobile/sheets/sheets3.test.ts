import { describe, expect, it } from "vitest";
import type { AppEntry } from "@/components/connect-apps/catalog";
import type { NotificationLogEntry } from "../../../shared/notification";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppFace, CATEGORY_SHOWN, connectedApps, connectPageFor, groupApps } from "./ConnectorsSheet";
import { stackByOwner } from "./NotificationsSheet";
import { searchSnippetText } from "./SearchSheet";
import { readableWorkspace, settingsIdentity } from "./SettingsSheet";
import { vaultView } from "./VaultSheet";
import { recedeStyle } from "../Sheet";

const app = (id: string, categories: AppEntry["categories"], kind: AppEntry["kind"] = "composio"): AppEntry => ({ id, kind, label: id, description: "", categories, icon: {} });

describe("connected apps", () => {
  it("knows what is connected, each app once", () => {
    const entries = [app("gmail", ["communication"]), app("slack", ["communication"]), app("zoho", ["productivity"]), app("misc", [])];
    expect(connectedApps(entries, new Set(["zoho", "gmail"])).map((entry) => entry.id)).toEqual(["gmail", "zoho"]);
    expect(connectedApps(entries, new Set())).toEqual([]);
  });

  const entries = [
    app("gmail", ["communication"]),
    app("slack", ["communication"]),
    app("zoho", ["productivity"]),
    app("zulip", ["communication"]),
    ...Array.from({ length: 8 }, (_, i) => app(`tool${i}`, ["data"])),
    app("misc", []),
  ];

  it("leads with what's connected, then the popular apps to add, then categories, each app once", () => {
    const groups = groupApps(entries, new Set(["zoho"]));
    expect(groups.map((group) => group.key)).toEqual(["connected", "popular", "communication", "data", "other"]);
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(["zoho"]);
    expect(groups[1].entries.map((entry) => entry.id)).toEqual(["gmail", "slack"]);
    const ids = groups.flatMap((group) => group.entries.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows a category's first few until it is expanded, and files apps with no category under other", () => {
    const data = groupApps(entries, new Set()).find((group) => group.key === "data")!;
    expect(data.entries).toHaveLength(CATEGORY_SHOWN);
    expect(data.total).toBe(8);
    expect(groupApps(entries, new Set(), new Set(["data"])).find((group) => group.key === "data")!.entries).toHaveLength(8);
    expect(groupApps(entries, new Set()).find((group) => group.key === "other")!.entries.map((entry) => entry.id)).toEqual(["misc"]);
  });

  it("opens an app's own page to connect or manage it; a server of your own opens the custom server page", () => {
    expect(connectPageFor(app("gmail", []))).toEqual({ kind: "detail", id: "gmail" });
    expect(connectPageFor(app("mcp:mine", [], "custom"))).toEqual({ kind: "detail", id: "custom-mcp" });
  });
});

describe("settings header", () => {
  it("never shows a host and port, a URL or an IP as the subtitle", () => {
    for (const value of ["127.0.0.1:5331", "localhost", "192.168.1.4", "http://studio.local:8799", "[::1]:8799", "studio.local:8799"]) {
      expect(readableWorkspace(value)).toBeNull();
    }
    expect(readableWorkspace("Studio Mac")).toBe("Studio Mac");
  });

  it("prefers the account email, then the madani cloud, then the computer it is connected to, then a plain phrase", () => {
    expect(settingsIdentity({ name: "Sam", identity: { kind: "account", email: "sam@example.com", session: false } })).toEqual({ title: "Sam", subtitle: "sam@example.com" });
    expect(settingsIdentity({ identity: { kind: "account", email: "sam@example.com", session: true } }).title).toBe("sam");
    expect(settingsIdentity({ identity: { kind: "cloud", name: "my cloud" } }).subtitle).toBe("my cloud");
    expect(settingsIdentity({ identity: { kind: "computer", name: "Studio Mac" } }).subtitle).toBe("Connected to Studio Mac");
    const plain = settingsIdentity({ identity: { kind: "computer", name: "127.0.0.1:5331" } });
    expect(plain.subtitle).not.toMatch(/\d+\.\d+|:\d+/);
    expect(settingsIdentity({ identity: { kind: "none" } }).subtitle).toBe("On your computer");
  });
});

describe("vault loading", () => {
  it("shows the skeleton only before the first answer, so a reload never jumps", () => {
    expect(vaultView({ loaded: false, loading: true, error: false, count: 0 })).toBe("skeleton");
    expect(vaultView({ loaded: true, loading: true, error: false, count: 3 })).toBe("list");
    expect(vaultView({ loaded: true, loading: false, error: false, count: 0 })).toBe("empty");
    expect(vaultView({ loaded: false, loading: false, error: true, count: 0 })).toBe("error");
  });
});

describe("notifications", () => {
  const note = (id: string, botId: string, at: number, read = true): NotificationLogEntry => ({ id, botId, threadId: `t-${botId}`, title: `${botId} finished`, body: "", at, read } as NotificationLogEntry);

  it("stacks a bot's notes into one row, newest on top, unread if any is", () => {
    const stacks = stackByOwner([note("a", "tally", 1), note("b", "tally", 3, false), note("c", "rivet", 2)]);
    expect(stacks.map((stack) => [stack.latest.id, stack.entries.length, stack.unread])).toEqual([["b", 2, true], ["c", 1, false]]);
  });
});

describe("search snippets", () => {
  it("drops markdown marks, including unbalanced ones", () => {
    expect(searchSnippetText("the **launch** note**")).toBe("the launch note");
  });
});

describe("page behind a sheet", () => {
  it("steps back as the sheet rises and is untouched when closed", () => {
    expect(recedeStyle(0)).toBeNull();
    expect(recedeStyle(1)?.transform).toContain("scale(0.9300)");
    expect(recedeStyle(1)?.borderRadius).toBe("14.0px");
  });
});

describe("connected apps tile", () => {
  const face = (icon: AppEntry["icon"]) => renderToStaticMarkup(createElement(AppFace, { entry: { label: "GitHub", icon } }));

  it("draws only the logo when the app has one, never its initial under it", () => {
    const html = face({ image: "data:image/svg+xml,logo", padded: true });
    expect(html).toContain("<img");
    expect(html).not.toMatch(/>G</);
  });

  it("draws the initial only when there is no logo", () => {
    const html = face({});
    expect(html).not.toContain("<img");
    expect(html.match(/>G</g)).toHaveLength(1);
  });
});
