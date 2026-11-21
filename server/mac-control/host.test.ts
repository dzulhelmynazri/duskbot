import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAC_TOOL_NAMES } from "../../shared/mac-control.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createMacControl, macHostSession, type MacControl } from "./host.ts";
import { MAC_OFFLINE_TEXT } from "./instructions.ts";

const session = (over: Partial<SessionRecord> = {}, scopes: Array<"admin" | "client"> = ["admin", "client"]): RequestAuth =>
  ({ kind: "session", via: "bearer", scopes, session: { id: "s1", tokenHash: "x".repeat(64), label: "Mac", scopes, createdAt: 0, lastSeenAt: 0, expiresAt: Infinity, ...over } });
const MAC = session();
const turn = { botId: "nova", threadId: "t1", generation: "g1" };

let dir: string, server: Server, base: string, mac: MacControl;
let bots: Record<string, { id: string; name: string; macControl?: boolean }>;
let enabled: boolean, owner: string | null, auths: Record<string, RequestAuth>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "madani-mac-host-"));
  bots = { nova: { id: "nova", name: "Nova" } };
  enabled = true;
  owner = "owner";
  auths = { mac: MAC, phone: session({ cookieOnly: true }), member: session({ teamRole: "member" }), guest: session({}, ["client"]), loopback: { kind: "loopback", scopes: ["admin", "client"] } };
  mac = createMacControl({
    dataDir: dir, offered: () => true, enabled: () => enabled, setEnabled: (on) => { enabled = on; },
    ownerOrAdmin: (auth) => auth.kind === "loopback" || auth.scopes.includes("admin"), live: () => true,
    bot: (id) => bots[id], turnOwner: () => owner, active: () => true,
    openFile: async (_turn, source) => ({ name: source.split("/").pop()!, bytes: 5, open: () => Readable.from([Buffer.from("hello")]) }),
    computerFile: async () => { throw new Error("there is no such file on your cloud computer"); },
  });
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    void mac.routes({ req, res, url, path: url.pathname, method: req.method!, auth: auths[String(req.headers["x-as"])]!, json, readBody });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  mac.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const as = (who: string, path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { "x-as": who, "content-type": "application/json", ...init.headers } });

/** the Mac app: polls once, runs the job with `answer`, posts the outcome; resolves with the job it saw */
async function macTakesOne(answer: (job: any) => unknown) {
  for (;;) {
    const { job } = await (await as("mac", "/api/mac/self/jobs?name=Sid%27s%20MacBook")).json() as { job: any };
    if (!job) continue;
    const posted = await as("mac", `/api/mac/self/jobs/${job.id}/result`, { method: "POST", body: JSON.stringify(answer(job)) });
    expect(posted.status).toBe(200);
    return job;
  }
}

describe("the owner's Mac", () => {
  it("only the owner's own app session may take jobs", async () => {
    for (const who of ["phone", "member", "guest", "loopback"]) {
      expect((await as(who, "/api/mac/self/jobs")).status, who).toBe(403);
    }
    expect(macHostSession(MAC)).toBe(true);
    expect(macHostSession(session({ moveIn: "nova" }))).toBe(false);
  });

  it("offers no tools until a Mac has served this server, then only to the owner's turns of bots allowed it", async () => {
    expect(mac.tools(turn)).toEqual([]);
    expect(mac.status()).toMatchObject({ available: false, online: false });
    const poll = as("mac", "/api/mac/self/jobs?name=Sid%27s%20MacBook");
    await expect.poll(() => mac.status().online).toBe(true);
    expect(mac.status()).toMatchObject({ available: true, enabled: true, name: "Sid's MacBook" });
    expect(mac.tools(turn).map((tool) => tool.name)).toEqual([...MAC_TOOL_NAMES]);
    expect(mac.promptPart(bots.nova!, turn).text).toContain("never say you have no access to their Mac");

    bots.nova!.macControl = false;
    expect(mac.tools(turn)).toEqual([]);
    expect(mac.mounts(bots.nova!, turn)).toBe(false);
    expect((await mac.call({ name: "mac_exec", arguments: { command: "ls" } }, turn, () => {})).content[0]).toMatchObject({ text: expect.stringContaining("switched off for this bot") });
    bots.nova!.macControl = undefined;
    enabled = false;
    expect(mac.tools(turn)).toEqual([]);
    enabled = true;
    owner = null;
    expect(mac.tools(turn)).toEqual([]);
    expect((await mac.call({ name: "mac_exec", arguments: { command: "ls" } }, turn, () => {})).content[0]).toMatchObject({ text: expect.stringContaining("only the owner's own turns") });
    mac.close();
    await poll;
  });

  it("a call runs on the Mac and returns its answer; the file of a save comes from this server", async () => {
    const first = as("mac", "/api/mac/self/jobs");
    await expect.poll(() => mac.status().online).toBe(true);
    const called = mac.call({ name: "mac_exec", arguments: { command: "echo hi" } }, turn, () => {});
    const job = await (async () => { const { job } = await (await first).json() as { job: any }; return job; })();
    expect(job).toMatchObject({ tool: "mac_exec", arguments: { command: "echo hi" }, bot: { id: "nova", name: "Nova" } });
    await as("mac", `/api/mac/self/jobs/${job.id}/result`, { method: "POST", body: JSON.stringify({ ok: true, result: { text: "exit code 0\nhi\n" } }) });
    expect(await called).toEqual({ content: [{ type: "text", text: "exit code 0\nhi\n" }] });

    const saved = mac.call({ name: "mac_save_from_cloud", arguments: { source: "out/report.txt" } }, turn, () => {});
    let body = "";
    const seen = await macTakesOne((delivered) => ({ ok: true, result: { text: `saved to ~/Downloads/Nova/${delivered.download.name}` } }));
    expect(seen.download).toEqual({ path: `/api/mac/self/jobs/${seen.id}/file`, name: "report.txt", bytes: 5 });
    expect((await saved).content[0]).toEqual({ type: "text", text: "saved to ~/Downloads/Nova/report.txt" });
    const late = await as("mac", seen.download.path);
    body = await late.text();
    expect(late.status, body).toBe(404);

    const fromComputer = await mac.call({ name: "mac_save_from_cloud", arguments: { source: "x.txt", from: "computer" } }, turn, () => {});
    expect(fromComputer).toMatchObject({ isError: true, content: [{ text: "Could not read x.txt: there is no such file on your cloud computer" }] });
  });

  it("an offline Mac answers in one line, and a bad call never reaches it", async () => {
    const poll = as("mac", "/api/mac/self/jobs");
    await expect.poll(() => mac.status().online).toBe(true);
    mac.close();
    await poll;
    expect(await mac.call({ name: "mac_exec", arguments: { command: "ls" } }, turn, () => {})).toEqual({ content: [{ type: "text", text: MAC_OFFLINE_TEXT }], isError: true });
    expect((await mac.call({ name: "mac_exec", arguments: {} }, turn, () => {})).content[0]).toMatchObject({ text: expect.stringContaining("command") });
  });

  it("the Settings switch is the owner's", async () => {
    expect((await as("guest", "/api/mac", { method: "PUT", body: JSON.stringify({ enabled: false }) })).status).toBe(403);
    const put = await as("mac", "/api/mac", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    expect(await put.json()).toMatchObject({ enabled: false, available: false });
    expect(enabled).toBe(false);
  });
});
