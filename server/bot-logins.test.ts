import { afterEach, describe, expect, it } from "vitest";

import { BotLogins, cardLoginPlace, cardSignInElsewhere, ONCE_LOGIN_MS, observeSignInPage } from "./bot-logins.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoginStore } from "./login-store.ts";
import type { OnePasswordLogins } from "./onepassword.ts";
import { FakeLoginPage, LOGIN_FORM } from "./testing/fake-login-page.ts";

let page: FakeLoginPage | null = null;
afterEach(() => { page?.close(); page = null; });

describe("a login saved from a sign-in card", () => {
  it("fills on the card's site, at the sign-in page open on that site", () => {
    expect(cardLoginPlace("example.com", { host: "accounts.example.com", signIn: true }, undefined))
      .toEqual({ site: "example.com", hosts: ["accounts.example.com"], exactHost: false });
    expect(cardLoginPlace("example.com", { host: "www.example.com", signIn: false }, undefined))
      .toEqual({ site: "example.com", hosts: ["example.com"], exactHost: false });
    expect(cardLoginPlace("example.com", null, undefined)).toEqual({ site: "example.com", hosts: ["example.com"], exactHost: false });
  });

  it("adds a sign-in page on another site only when the person confirmed that host", () => {
    const microsoft = { host: "login.microsoftonline.com", signIn: true };
    expect(cardSignInElsewhere("example.com", microsoft)).toBe("login.microsoftonline.com");
    expect(cardLoginPlace("example.com", microsoft, "login.microsoftonline.com"))
      .toEqual({ site: "example.com", hosts: ["example.com", "login.microsoftonline.com"], exactHost: false });
    expect(cardLoginPlace("example.com", microsoft, undefined).hosts).toEqual(["example.com"]);
    expect(cardLoginPlace("example.com", microsoft, "evil.test").hosts).toEqual(["example.com"]);
    expect(cardSignInElsewhere("example.com", { host: "evil.test", signIn: false })).toBeNull();
    expect(cardLoginPlace("example.com", { host: "evil.test", signIn: false }, "evil.test").hosts).toEqual(["example.com"]);
  });
});

describe("the bot's open page", () => {
  it("is read as its host and whether it shows a password, username or email box, only for a page a login could be filled on", async () => {
    page = new FakeLoginPage("https://login.microsoftonline.com/common/oauth2/authorize?client_id=x", LOGIN_FORM);
    expect(await observeSignInPage((args) => page!.engine(args))).toEqual({ host: "login.microsoftonline.com", signIn: true });
    page.navigate("https://login.example.net/u/login/identifier", `<form><input name="username" autocomplete="username"><button>Continue</button></form>`);
    expect(await observeSignInPage((args) => page!.engine(args))).toEqual({ host: "login.example.net", signIn: true });
    page.navigate("https://example.com/dashboard", "<h1>Hello</h1>");
    expect(await observeSignInPage((args) => page!.engine(args))).toEqual({ host: "example.com", signIn: false });
    page.navigate("http://example.com/login", LOGIN_FORM);
    expect(await observeSignInPage((args) => page!.engine(args))).toBeNull();
    expect(await observeSignInPage(async () => null)).toBeNull();
    expect(await observeSignInPage(async () => { throw new Error("The browser did not answer."); })).toBeNull();
  });
});

describe("a login given for one task only", () => {
  function logins(clock: { now: number }) {
    const store = { usableFor: () => [], sitesFor: () => [], markUsed: () => {} } as unknown as LoginStore;
    const onePassword = { candidates: () => [], sitesFor: () => [], markUsed: () => {}, fresh: async () => {} } as unknown as OnePasswordLogins;
    return new BotLogins(store, onePassword, () => clock.now);
  }

  it("fills for its bot on its site until a fill uses it, then is gone, and never for another bot", async () => {
    const clock = { now: 1_000 };
    const all = logins(clock);
    const id = all.keepOnce("b1", "the-internet.herokuapp.com", { username: "tomsmith", password: "fake-pass", totp: null });
    expect(all.has("b1", "the-internet.herokuapp.com")).toBe(true);
    expect(all.has("b2", "the-internet.herokuapp.com")).toBe(false);
    expect(all.sitesFor("b1")).toEqual([{ site: "the-internet.herokuapp.com", hosts: ["the-internet.herokuapp.com"], exactHost: false, username: "tomsmith" }]);
    const [candidate] = await all.candidates("b1", "the-internet.herokuapp.com");
    expect(candidate).toMatchObject({ id, username: "tomsmith", source: "card" });
    expect(await candidate!.secrets()).toEqual({ password: "fake-pass", totp: null });
    expect(await all.candidates("b1", "example.com")).toEqual([]);
    all.markUsed(id);
    expect(all.has("b1", "the-internet.herokuapp.com")).toBe(false);
  });

  it("goes after an hour when no fill used it", () => {
    const clock = { now: 1_000 };
    const all = logins(clock);
    all.keepOnce("b1", "example.com", { username: "me", password: "fake-pass", totp: null });
    clock.now += ONCE_LOGIN_MS;
    expect(all.sitesFor("b1")).toEqual([]);
  });
});

describe("a saved login a site refused", () => {
  const homes: string[] = [];
  afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function saved() {
    const dataDir = mkdtempSync(join(tmpdir(), "madani-bot-logins-"));
    homes.push(dataDir);
    const store = new LoginStore({ dataDir });
    const onePassword = { candidates: () => [], sitesFor: () => [], markUsed: () => {}, fresh: async () => {} } as unknown as OnePasswordLogins;
    const login = store.create({ site: "instagram.com", hosts: ["www.instagram.com"], exactHost: false, username: "me", password: "fake-old-pass",
      totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 }, source: "card", bots: ["b1"] });
    return { store, logins: new BotLogins(store, onePassword), id: login.id };
  }

  it("is removed on a clear wrong-password signal, and only its 2FA key when a code was refused", () => {
    const one = saved();
    expect(one.logins.rejected(one.id, "code", "invalid")).toEqual({ site: "instagram.com", host: "www.instagram.com", change: "removedTotp" });
    expect(one.store.list()).toMatchObject([{ hasTotp: false, username: "me" }]);
    expect(one.logins.rejected(one.id, "login", "invalid")).toMatchObject({ change: "removed" });
    expect(one.store.list()).toEqual([]);
  });

  it("is left alone on a temporary failure, marked once when unsure, and unmarked by a new password", () => {
    const one = saved();
    expect(one.logins.rejected(one.id, "login", "transient")).toBeNull();
    expect(one.store.list()[0]!.needsCheck).toBeUndefined();
    expect(one.logins.rejected(one.id, "login", "check")).toMatchObject({ change: "flagged" });
    expect(one.logins.rejected(one.id, "login", "check")).toBeNull();
    expect(one.store.list()[0]!.needsCheck).toBeTypeOf("number");
    one.store.update(one.id, { password: "fake-new-pass" });
    expect(one.store.list()[0]!.needsCheck).toBeUndefined();
  });

  it("given for one task only, is forgotten when wrong, and an unknown id changes nothing", () => {
    const one = saved();
    const once = one.logins.keepOnce("b1", "example.com", { username: "x", password: "fake-pass", totp: null });
    expect(one.logins.rejected(once, "login", "check")).toBeNull();
    expect(one.logins.rejected(once, "login", "invalid")).toMatchObject({ change: "forgotten" });
    expect(one.logins.has("b1", "example.com")).toBe(false);
    expect(one.logins.rejected("1password-item", "login", "invalid")).toBeNull();
  });
});
