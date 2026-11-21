import { describe, expect, it } from "vitest";
import { appLinkFromUniversal, pairSignIn, MOBILE_LINK_VERSION, mobileLinkUrl, mobileOpenLink, parseMobileOpenLink, parseMobilePairingLink, parseSignInLink, universalPairLink, universalSignInLink, type MobileLinkPayload } from "./mobile-link.ts";
import { phonePairingLink } from "./pairing-link.ts";

const token = `omb_pair_${"a".repeat(43)}`;
const payload: MobileLinkPayload = {
  v: MOBILE_LINK_VERSION,
  workspace: { name: "My VPS", environmentId: "env_1", kind: "vps" },
  grant: { id: "g1", secret: "s3cret", expiresAt: 1_900_000_000_000 },
  via: [
    { kind: "https", url: "https://vps.example.com" },
    { kind: "relay", base: "https://link.madani.bot", channel: "abcdefghij", token: "tok_1", key: "k".repeat(43) },
  ],
};

describe("mobile pairing link adapter", () => {
  it("reads a v2 link into the phone's view", () => {
    expect(parseMobilePairingLink(mobileLinkUrl(payload))).toMatchObject({
      v: 2, transport: "https", origin: "https://vps.example.com", credential: "s3cret", name: "My VPS", environmentId: "env_1",
      relay: { base: "https://link.madani.bot", channel: "abcdefghij", token: "tok_1" }, grantId: "g1", workspaceKind: "vps",
    });
  });

  it("reads a relay-only v2 link", () => {
    const link = mobileLinkUrl({ ...payload, via: [payload.via[1]!] });
    expect(parseMobilePairingLink(link)).toMatchObject({ transport: "relay", relay: { channel: "abcdefghij" } });
    expect(parseMobilePairingLink(link)?.origin).toBeUndefined();
  });

  it("still reads an older server or companion link", () => {
    expect(parseMobilePairingLink(phonePairingLink({ address: "https://vps.example.com", token, name: "Old" })!)).toMatchObject({ v: 1, transport: "https", origin: "https://vps.example.com", credential: token });
    expect(parseMobilePairingLink(phonePairingLink({ address: "192.168.1.4", port: 8810, token, code: "123456" })!)).toMatchObject({ transport: "companion", origin: "http://192.168.1.4:8810", code: "123456" });
  });

  it("refuses malformed links", () => {
    expect(parseMobilePairingLink("madanibot://pair?token=short&address=https://a.b")).toBeNull();
    expect(parseMobilePairingLink(`madanibot://pair?token=${token}`)).toBeNull();
    expect(parseMobilePairingLink("madanibot://pair?m=notjson")).toBeNull();
  });

  it("reads a universal link as the app link it stands for", () => {
    const open = mobileOpenLink({ botId: "nova", threadId: "t-1" });
    expect(appLinkFromUniversal(`https://madani.bot/m/open?${open.split("?")[1]}`)).toBe(open);
    expect(appLinkFromUniversal(`https://madani.bot/m/open#${open.split("?")[1]}`)).toBe(open);
    const pair = mobileLinkUrl(payload);
    expect(parseMobilePairingLink(appLinkFromUniversal(`https://madani.bot/m/pair#${pair.split("?")[1]}`)!)).toMatchObject({ v: 2, credential: "s3cret" });
  });

  it("a pairing secret is only taken from the part of a universal link no web server sees", () => {
    const pair = mobileLinkUrl(payload);
    expect(appLinkFromUniversal(`https://madani.bot/m/pair?${pair.split("?")[1]}`)).toBeNull();
  });

  it("the desktop's one qr: an https link that pairs in the app and carries the typed code for the store page, all after the #", () => {
    const link = universalPairLink(mobileLinkUrl(payload), "ABCD-EFGH-JKLM");
    expect(link.startsWith("https://madani.bot/m/pair#m=")).toBe(true);
    expect(link.endsWith("&c=ABCDEFGHJKLM")).toBe(true);
    expect(new URL(link).search).toBe("");
    expect(parseMobilePairingLink(appLinkFromUniversal(link)!)).toMatchObject({ v: 2, credential: "s3cret" });
    expect(universalPairLink(mobileLinkUrl(payload), null)).not.toContain("c=");
  });

  it("a madani cloud's qr opens the app's log in with the email filled in", () => {
    const link = universalSignInLink("a+b@example.test");
    expect(link).toBe("https://madani.bot/m/signin#email=a%2Bb%40example.test");
    expect(appLinkFromUniversal(link)).toBe("madanibot://signin?email=a%2Bb%40example.test");
    expect(parseSignInLink(link)).toEqual({ email: "a+b@example.test" });
    expect(parseSignInLink("madanibot://signin")).toEqual({ email: "" });
    // the code's account service rides along, so a phone on the other one can follow it
    expect(universalSignInLink("a@b.test", "ABCD-EFGH", "https://preview.madani.bot")).toBe("https://madani.bot/m/signin#c=ABCDEFGH&email=a%40b.test&s=preview");
    expect(parseSignInLink(universalSignInLink("a@b.test", "ABCD-EFGH", "https://preview.madani.bot"))).toEqual({ email: "a@b.test", code: "ABCDEFGH", service: "preview" });
    expect(parseSignInLink(universalSignInLink("a@b.test", "ABCD-EFGH", "https://madani.bot"))).toMatchObject({ service: "production" });
    expect(universalSignInLink("a@b.test", null, "http://127.0.0.1:9000")).toBe("https://madani.bot/m/signin#email=a%40b.test");
    expect(parseSignInLink("madanibot://signin?s=elsewhere")).toEqual({ email: "" });
    expect(parseSignInLink(universalSignInLink(null))).toEqual({ email: "" });
    expect(parseSignInLink("madanibot://signin?email=not-an-email")).toEqual({ email: "" });
    expect(appLinkFromUniversal("https://madani.bot/m/signin?email=a@b.c"), "the email stays where no server sees it").toBeNull();
    expect(parseSignInLink("madanibot://pair?m=x")).toBeNull();
    expect(parseSignInLink("https://evil.example/m/signin#email=a@b.c")).toBeNull();
  });

  it("a signed-in desktop's pairing qr carries the account's sign-in beside the pairing", () => {
    const link = universalPairLink("madanibot://pair?m=abc", "ABCD-EFGH-JKLM", { code: "WXYZ-QRST", email: "o@b.test", serviceOrigin: "https://madani.bot" });
    expect(link).toBe("https://madani.bot/m/pair#m=abc&c=ABCDEFGHJKLM&a=WXYZQRST&ae=o%40b.test&as=production");
    expect(pairSignIn(link)).toEqual({ code: "WXYZQRST", email: "o@b.test", service: "production" });
    const real = universalPairLink(mobileLinkUrl(payload), null, { code: "WXYZQRST", email: "o@b.test" });
    expect(parseMobilePairingLink(appLinkFromUniversal(real)!), "apps that predate it still pair").toEqual(parseMobilePairingLink(mobileLinkUrl(payload)));
    expect(parseMobilePairingLink(mobileLinkUrl(payload))).not.toBeNull();
    expect(pairSignIn(universalPairLink("madanibot://pair?m=abc", null))).toBeNull();
  });

  it("a madani cloud's qr names the cloud it was drawn on, and only a madani cloud's own address", () => {
    const cloud = "https://d0123456789abcdef0123.madani.bot";
    const link = universalSignInLink("a@b.test", "ABCD-EFGH", "https://madani.bot", cloud);
    expect(parseSignInLink(link)).toEqual({ email: "a@b.test", code: "ABCDEFGH", service: "production", cloud });
    expect(universalSignInLink("a@b.test", null, null, "https://evil.example")).toBe("https://madani.bot/m/signin#email=a%40b.test");
    expect(parseSignInLink(`madanibot://signin?email=a@b.test&o=${encodeURIComponent("https://evil.example")}`)).toEqual({ email: "a@b.test" });
  });

  it("a madani cloud's qr with a desktop's code carries it beside the email, after the # where no server sees it", () => {
    const link = universalSignInLink("a@example.test", "ABCD-EFGH");
    expect(link).toBe("https://madani.bot/m/signin#c=ABCDEFGH&email=a%40example.test");
    expect(parseSignInLink(link)).toEqual({ email: "a@example.test", code: "ABCDEFGH" });
    expect(parseSignInLink("madanibot://signin?c=abcdefgh")).toEqual({ email: "", code: "ABCDEFGH" });
    expect(parseSignInLink("madanibot://signin?c=ABCD1234"), "never a code with digits").toEqual({ email: "" });
    expect(parseSignInLink("madanibot://signin?c=ABCDEFGHJKLM"), "nor a computer's 12").toEqual({ email: "" });
  });

  it("leaves every other address alone", () => {
    for (const link of ["https://madani.bot/", "https://madani.bot/pricing", "https://madani.bot/m/buy?x=1", "https://evil.example/m/open?bot=a", "http://madani.bot/m/open?bot=a", "https://user@madani.bot/m/open?bot=a", "madanibot://open?bot=a", "not a link"]) {
      expect(appLinkFromUniversal(link)).toBeNull();
    }
  });

  it("round-trips an open link", () => {
    const target = { environmentId: "env_1", botId: "nova", threadId: "t-1", view: "computer" as const };
    expect(parseMobileOpenLink(mobileOpenLink(target))).toEqual(target);
    expect(parseMobileOpenLink("madanibot://open?view=nope&bot=a b")).toEqual({});
  });
});
