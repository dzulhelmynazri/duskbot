import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { isServerPairingLink, RemoteComputerSection } from "./RemoteComputerSection";

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("self-hosted server pairing links", () => {
  it.each([
    "https://bots.example.com/pair#code=ABCD-EFGH-JKLM",
    " https://custom.example.com:8443/pair/#code=ABCD%2DEFGH%2DJKLM ",
    "https://random.trycloudflare.com/pair#code=ABCDEFGHJKLM",
  ])("accepts a complete custom HTTPS link: %s", (link) => {
    expect(isServerPairingLink(link)).toBe(true);
  });

  it.each([
    "",
    "ABCD-EFGH-JKLM",
    "http://bots.example.com/pair#code=ABCD-EFGH-JKLM",
    "https:example.com/pair#code=ABCD-EFGH-JKLM",
    "https://user:secret@bots.example.com/pair#code=ABCD-EFGH-JKLM",
    "https://bots.example.com",
    "https://bots.example.com/pair",
    "https://bots.example.com/pair#code=",
    "https://bots.example.com/pair#code=%20",
    "https://bots.example.com/pair#code=%",
    "https://bots.example.com/other#code=ABCD-EFGH-JKLM",
    "https://bots.example.com/pair?code=ABCD-EFGH-JKLM",
    "https://bots.example.com/pair?code=secret#code=ABCD-EFGH-JKLM",
    "https://bots.example.com/pair#code=ABCD EFGH JKLM",
    "https://bots.example.com\\@other.example/pair#code=ABCD-EFGH-JKLM",
    "madanibot://pair?code=123456",
  ])("rejects an incomplete, malformed, or insecure link: %s", (link) => {
    expect(isServerPairingLink(link)).toBe(false);
  });
});

describe("remote connection Settings", () => {
  const render = (madaniDesktop?: unknown) => {
    vi.stubGlobal("window", { madaniDesktop });
    setLocale("en");
    return renderToStaticMarkup(createElement(RemoteComputerSection));
  };

  it("pairs with another desktop from one row; its address and code wait in a small form", () => {
    const html = render({ remoteClient: { active: false } });
    expect(html).toContain("Pair with another desktop");
    expect(html).toContain('data-settings-open="companion-pair"');
    // no fields, paragraphs, code blocks or big buttons on the page itself
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<code");
    expect(html).not.toMatch(/<p[\s>]/);
    expect(html).not.toContain("self-hosted server");
  });

  it("leaves server connections to Your servers when only the server bridge is there", () => {
    const html = render({ environments: { addFromLink: vi.fn() } });
    expect(html).toContain("requires the installed app");
    expect(html).not.toContain("<form");
  });

  it("keeps an active companion connection on its disconnect row", () => {
    const html = render({ environments: {}, remoteClient: { active: true } });
    expect(html).toContain("Disconnect and use this computer");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<select");
  });

  it.each([undefined, { platform: "darwin" }])("hides unavailable actions on browser and remote server pages", (bridge) => {
    const html = render(bridge);
    expect(html).toContain("requires the installed app");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });
});
