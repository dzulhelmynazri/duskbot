// A madani cloud's bots on the person's Mac, both halves for real over HTTP: the cloud's /api/mac routes in cloud mode
// (sealing with a link key) and the Mac app's core (electron/cloud-mac.mjs: poller, seal, rules, executor in a scratch home).
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCloudMac } from "../../electron/cloud-mac.mjs";
import { macLogFile } from "../../electron/mac-control-tools.mjs";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createMacControl, type MacControl } from "./host.ts";

const link = generateKeyPairSync("ed25519");
const linkPublic = link.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const MAC: RequestAuth = { kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s1", tokenHash: "x".repeat(64), label: "Mac", scopes: ["admin", "client"], createdAt: 0, lastSeenAt: 0, expiresAt: Infinity } };
const turn = { botId: "nova", threadId: "t1", generation: "g1" };

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const clean of cleanups.reverse()) await clean();
  cleanups = [];
});

async function pair(mode: "auto" | "ask" | "never", answer: (reason: string) => string | null = () => null) {
  const dir = mkdtempSync(join(tmpdir(), "madani-cloud-mac-srv-"));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "madani-cloud-mac-home-")));
  const asked: Array<{ tool: string; reason: string; args: Record<string, unknown> }> = [];
  const mac: MacControl = createMacControl({
    dataDir: dir, offered: () => true, enabled: () => true, setEnabled: () => {}, ownerOrAdmin: () => true, live: () => true,
    bot: () => ({ id: "nova", name: "Nova" }), turnOwner: () => "owner", active: () => true,
    openFile: async () => { throw new Error("none"); }, computerFile: async () => { throw new Error("none"); },
    cloud: { linkKey: () => link.privateKey, approve: async (_bot, _turn, tool, args, reason) => { asked.push({ tool, reason, args }); return answer(reason); } },
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    void mac.routes({ req, res, url, path: url.pathname, method: req.method!, auth: MAC, json, readBody });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let prefs: any = { enabled: true, mode };
  const app = createCloudMac({
    fetch: (input: string, init?: RequestInit) => fetch(input, init), name: () => "Sid's MacBook", home,
    prefs: { read: () => prefs, write: (value: unknown) => { prefs = value; } },
    cloud: () => ({ origin: base, awake: true }), linkKey: async () => linkPublic,
  });
  await app.sync();
  cleanups.push(() => app.close(), () => mac.close(), () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
    () => rmSync(dir, { recursive: true, force: true }), () => rmSync(home, { recursive: true, force: true }));
  await expect.poll(() => mac.status().online, { timeout: 10_000 }).toBe(true);
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = await mac.call({ name, arguments: args }, turn, () => {});
    return { text: result.content.map((part) => ("text" in part ? part.text : "")).join(""), error: result.isError === true };
  };
  return { mac, app, home, asked, run, base };
}

describe("cloud bots use this Mac", () => {
  it("Auto: ordinary work just runs on the Mac, a risky command asks first, and No stops it", async () => {
    let allow = true;
    const { mac, home, asked, run } = await pair("auto", () => (allow ? null : "The person said no."));
    expect(mac.status()).toMatchObject({ available: true, online: true, name: "Sid's MacBook", cloud: { mode: "auto", limited: false } });
    expect(mac.tools(turn).map((tool) => tool.name)).toEqual(["mac_exec", "mac_read_file", "mac_write_file", "mac_list", "mac_open", "mac_download"]);
    expect(mac.promptPart({ id: "nova", name: "Nova" }, turn).text).toContain("risky actions");

    const made = await run("mac_exec", { command: "mkdir -p site/build && echo made in $PWD" });
    expect(made).toMatchObject({ error: false, text: expect.stringContaining(`exit code 0\nmade in ${home}`) });
    expect(await run("mac_write_file", { path: "~/site/note.txt", content: "from the cloud\n" })).toMatchObject({ error: false });
    expect(readFileSync(join(home, "site/note.txt"), "utf8")).toBe("from the cloud\n");
    expect((await run("mac_read_file", { path: "~/site/note.txt" })).text).toContain("from the cloud");
    expect(asked).toEqual([]);

    allow = false;
    expect(await run("mac_exec", { command: "rm -rf site/build", cwd: "~" })).toEqual({ error: true, text: "The person said no." });
    expect(asked).toMatchObject([{ tool: "mac_exec", reason: "deletes many files" }]);
    expect(existsSync(join(home, "site/build"))).toBe(true);
    allow = true;
    expect(await run("mac_exec", { command: "rm -rf site/build", cwd: "~" })).toMatchObject({ error: false });
    expect(existsSync(join(home, "site/build"))).toBe(false);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.args.cwd).toBe("~");

    const log = readFileSync(macLogFile(home), "utf8");
    expect(log).toMatch(/ cloud Nova mac_exec mkdir -p site\/build .* -> ok\n/);
    expect(log).toMatch(/ cloud Nova mac_exec rm -rf site\/build \(in ~\) \(allowed in chat\) -> ok\n/);
    expect(log).not.toContain("from the cloud");
  }, 60_000);

  it("Ask before every action asks for a plain command too; Never ask never does", async () => {
    const asking = await pair("ask");
    expect(await asking.run("mac_exec", { command: "echo hi" })).toMatchObject({ error: false, text: expect.stringContaining("hi") });
    expect(asking.asked).toMatchObject([{ tool: "mac_exec", reason: "asks before every action" }]);
    expect(await asking.run("mac_list", {})).toMatchObject({ error: false });
    expect(asking.asked).toHaveLength(1);

    const never = await pair("never");
    mkdirSync(join(never.home, "build"));
    expect(await never.run("mac_exec", { command: "rm -rf build" })).toMatchObject({ error: false });
    expect(never.asked).toEqual([]);
  }, 60_000);

  it("the Mac refuses a risky job the cloud sent without a card, and turning the switch off makes the cloud forget it", async () => {
    const { mac, app, home, asked, run } = await pair("never");
    mkdirSync(join(home, "keep"));
    await app.setMode("auto");
    // the cloud still believes "never" until the Mac's next poll: the Mac holds the line itself
    expect(await run("mac_exec", { command: "rm -rf keep" })).toMatchObject({ error: true, text: expect.stringContaining("must allow it on a card first") });
    expect(existsSync(join(home, "keep"))).toBe(true);
    expect(asked).toEqual([]);
    expect(readFileSync(macLogFile(home), "utf8")).toMatch(/ cloud Nova mac_exec rm -rf keep -> refused: /);

    await app.setEnabled(false);
    await expect.poll(() => mac.status().available, { timeout: 10_000 }).toBe(false);
    expect((await run("mac_exec", { command: "ls" })).text).toMatch(/offline/);
  }, 60_000);
});
