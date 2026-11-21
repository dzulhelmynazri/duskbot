// fill_login on a bot's VPS desktop, against a real Chromium reached the way the box's is: a DevTools port behind an http
// address. Proves the login is typed into the page in front and submitted, and that the password crosses DevTools only as
// Input.insertText, never in a script, a tool answer or anything the bot reads.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CdpConnection } from "./browser/cdp/connection.ts";
import { tracingTransport, webSocketTransport, type SentCommand } from "./browser/cdp/transport.ts";
import { CHROME, testRoot } from "./browser/cdp/testing/real-chrome.ts";
import { FixtureServer } from "./browser/cdp/testing/fixtures.ts";
import { openBoxLoginPage } from "./box-login-page.ts";
import { createFillLoginTurn, type FillLoginTurnDeps } from "./host/fill-login-turn.ts";
import type { BotRecord } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const suite = CHROME ? describe : describe.skip;
// obvious fakes only
const PASSWORD = "fake-Desk70p!pass";
const USERNAME = "desk@example.test";

const LOGIN = `<!doctype html><title>Log in</title><form method="post" action="/session">
<input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password">
<button type="submit">Log in</button></form>`;

suite("fill_login on the VPS desktop's Chromium", () => {
  let fx: FixtureServer;
  let chrome: ChildProcess;
  let dir: string;
  let port = "";
  const sent: SentCommand[] = [];

  beforeAll(async () => {
    fx = await FixtureServer.start();
    fx.page("/login", LOGIN);
    fx.route("/session", (request) => {
      void request;
      return { status: 303, body: "", headers: { location: "/secure" } };
    });
    fx.page("/secure", `<!doctype html><title>Secure Area</title><div id="flash">You logged into a secure area!</div>`);
    dir = mkdtempSync(join(testRoot(), "madani-box-login-"));
    chrome = spawn(CHROME!, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", `--user-data-dir=${join(dir, "profile")}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
    for (let i = 0; i < 150 && !port; i++) {
      await delay(100);
      try { port = readFileSync(join(dir, "profile", "DevToolsActivePort"), "utf8").split("\n")[0]!.trim(); } catch {}
    }
    if (!port) throw new Error("Chrome did not open its DevTools port");
  }, hostTimeout(60_000));

  afterAll(async () => {
    chrome?.kill();
    await fx?.close();
    if (dir) await removeTempDir(dir);
  });

  // the person (or the bot's screen tools) opening a page in that Chromium
  async function show(url: string) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const socket = new WebSocket(list.find((target) => target.type === "page")!.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const loaded = new Promise<void>((resolve) => { socket.onmessage = (event) => { if (String(event.data).includes("Page.loadEventFired")) resolve(); }; });
    socket.send(JSON.stringify({ id: 1, method: "Page.enable" }));
    socket.send(JSON.stringify({ id: 2, method: "Page.navigate", params: { url } }));
    await Promise.race([loaded, delay(10_000)]);
    socket.close();
  }

  function turn(over: Partial<FillLoginTurnDeps> = {}) {
    const bot = { id: "b1", name: "Vaultie", browser: true } as unknown as BotRecord;
    const used: string[] = [];
    const finished: unknown[] = [];
    const deps: FillLoginTurnDeps = {
      place: () => "cloud",
      current: (b) => b,
      builtInBrowserOn: () => true,
      browserSelectable: () => false,
      moveToBrowser: () => { throw new Error("a desktop fill never moves the conversation"); },
      myChrome: () => false,
      target: async () => { throw new Error("a desktop fill never uses the host browser"); },
      claim: () => true,
      withSecretInput: (_session, _spec, fill) => fill(),
      logins: {
        sitesFor: () => [{ site: "127.0.0.1", hosts: ["127.0.0.1"], exactHost: true, username: USERNAME }],
        candidates: async (_botId, host) => host === "127.0.0.1" ? [{ id: "l1", site: "127.0.0.1", hosts: ["127.0.0.1"], exactHost: true, username: USERNAME, source: "card", secrets: async () => ({ password: PASSWORD, totp: null }) }] : [],
        markUsed: (id) => { used.push(id); },
      },
      onePasswordTrouble: () => undefined,
      loginInput: () => { throw new Error("a desktop fill never uses the host's input relay"); },
      remember: () => {},
      stepContext: () => ({ botId: "b1", botName: "Vaultie", threadId: "t1", generation: "g1", turnId: () => null, record: false }),
      desktop: async () => {
        const page = await openBoxLoginPage(`http://127.0.0.1:${port}`, {
          connect: async (ws) => new CdpConnection(tracingTransport(await webSocketTransport(ws), (command) => sent.push(command))),
        });
        if ("refusal" in page) return page;
        return { input: page.input, finish: (held) => { finished.push(held ?? null); page.close(); } };
      },
      ...over,
    };
    return { fill: createFillLoginTurn(deps).fillLoginForTurn, bot, used, finished };
  }

  it("types the saved login into the page in front, submits it, and reaches the signed-in page", async () => {
    await show(fx.url("/login"));
    sent.length = 0;
    const { fill, bot, used, finished } = turn();
    const answer = await fill(bot, { botId: "b1", threadId: "t1", generation: "g1" }, undefined, undefined);
    expect(answer.ok).toBe(true);
    expect(answer.text).toContain(`Filled the username and the password for ${USERNAME}`);
    expect(answer.text).toContain("/secure");
    expect(used).toEqual(["l1"]);
    expect(finished).toHaveLength(1);
    // the password went to the page only as typing, never inside a script or the answer
    expect(answer.text).not.toContain(PASSWORD);
    const carrying = sent.filter((command) => JSON.stringify(command.params).includes(PASSWORD));
    expect(carrying.map((command) => command.method)).toEqual(["Input.insertText"]);
    // every read ran in an isolated world, never the page's own
    const evaluations = sent.filter((command) => command.method === "Runtime.evaluate");
    expect(evaluations.length).toBeGreaterThan(0);
    expect(evaluations.every((command) => typeof command.params.contextId === "number")).toBe(true);
    expect(sent.some((command) => command.method === "Runtime.enable")).toBe(false);
  }, hostTimeout(60_000));

  it("refuses a page whose site has no saved login, without typing anything", async () => {
    await show(fx.crossSiteUrl("/login"));
    sent.length = 0;
    const { fill, bot, used } = turn();
    const answer = await fill(bot, { botId: "b1", threadId: "t1", generation: "g1" }, undefined, undefined);
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("No saved login for localhost");
    expect(answer.text).toContain('request_credential with credential_id "login"');
    expect(used).toEqual([]);
    expect(sent.some((command) => command.method.startsWith("Input."))).toBe(false);
  }, hostTimeout(60_000));
});
