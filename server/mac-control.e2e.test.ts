// A linked VPS's bot works on the owner's Mac: a fixture server, the Mac app's own host and executor (electron/) signed in
// with an admin session as the linked app is, and a scripted engine calling the device server's mac_ tools.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createMacControlHost } from "../electron/mac-control.mjs";
import { createMacExecutor, macLogFile } from "../electron/mac-control-tools.mjs";
import { launchVerificationServer } from "../scripts/control-madani.ts";
import { MAC_OFFLINE_TEXT } from "./mac-control/instructions.ts";

it("a VPS bot runs a command and writes a file on the linked Mac, hears when it is offline, and loses the tools when switched off", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "madani-mac-e2e-"));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "madani-mac-e2e-home-")));
  const calls = join(scratch, "calls.json");
  const script = (list: unknown[]) => writeFileSync(calls, JSON.stringify(list));
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_TOOL_CALLS_FILE: calls });
  const base = fixture.info.url;
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(expected);
    return result;
  };
  const host = { current: null as ReturnType<typeof createMacControlHost> | null };
  try {
    const opened = await api("POST", "/api/auth/pairing", { label: "Mac app", scopes: ["admin", "client"] });
    const { token } = await api("POST", "/api/auth/pair", { code: opened.code, label: "Sid's MacBook" });
    expect(typeof token).toBe("string");
    host.current = createMacControlHost({
      fetch: (input: string, init?: RequestInit) => fetch(input, { ...init, headers: { ...init?.headers as Record<string, string>, authorization: `Bearer ${token}` } }),
      name: () => "Sid's MacBook", execute: createMacExecutor({ home, shell: "/bin/sh" }) as (job: unknown, io: { download(path: string): Promise<Response> }) => Promise<unknown>,
    });
    host.current.follow(base);
    await expect.poll(async () => (await api("GET", "/api/mac")).online, { timeout: 10_000 }).toBe(true);
    expect(await api("GET", "/api/mac")).toMatchObject({ available: true, enabled: true, name: "Sid's MacBook" });

    const nova = (await api("POST", "/api/bots", { name: "Nova" }, 201)).bot;
    const idle = () => expect.poll(async () => (await api("GET", "/api/bots")).bots.every((bot: any) => !bot.busy), { timeout: 60_000 }).toBe(true);
    const results = async () => (await api("GET", `/api/threads/${nova.threadId}/messages`)).messages
      .filter((message: any) => message.kind === "activity" || message.tool).map((message: any) => message.tool).filter(Boolean);
    let sends = 0;
    const ask = async (text: string) => {
      await api("POST", `/api/bots/${nova.id}/messages`, { threadId: nova.threadId, text, sendId: `mac-e2e-send-${String(++sends).padStart(4, "0")}` }, 202);
      await expect.poll(() => JSON.stringify(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt ?? "").includes(text), { timeout: 30_000 }).toBe(true);
      await idle();
      return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    };

    script([
      { server: "device", name: "mac_exec", input: { command: "echo made on $(hostname -s >/dev/null && echo the mac) in $PWD" } },
      { server: "device", name: "mac_write_file", input: { path: "~/Downloads/Nova/note.txt", content: "from the cloud\n" } },
    ]);
    const first = await ask("Save a note on my MacBook");
    expect(Object.keys(first.mcpConfig.mcpServers)).toContain("device");
    expect(JSON.stringify(first.systemPrompt ?? first.prompt)).toContain("never say you have no access to their Mac");
    expect(readFileSync(join(home, "Downloads/Nova/note.txt"), "utf8")).toBe("from the cloud\n");
    const log = readFileSync(macLogFile(home), "utf8");
    expect(log).toMatch(/ Nova mac_exec echo made on .* -> ok\n/);
    expect(log).toMatch(/ Nova mac_write_file ~\/Downloads\/Nova\/note\.txt -> ok\n/);
    await expect.poll(async () => (await results()).map((tool: any) => `${tool.name}:${tool.ok}`), { timeout: 10_000 })
      .toEqual(expect.arrayContaining(["mac_exec:true", "mac_write_file:true"]));
    const shown = JSON.stringify(await api("GET", `/api/threads/${nova.threadId}/messages`));
    expect(shown).toContain(`made on the mac in ${home}`);

    host.current.close();
    await expect.poll(async () => (await api("GET", "/api/mac")).online, { timeout: 15_000 }).toBe(false);
    script([{ server: "device", name: "mac_exec", input: { command: "ls" } }]);
    await ask("List my home folder on the Mac");
    expect(JSON.stringify(await api("GET", `/api/threads/${nova.threadId}/messages`))).toContain(MAC_OFFLINE_TEXT);

    await api("PATCH", `/api/bots/${nova.id}`, { macControl: false });
    script([]);
    const off = await ask("Anything on my Mac?");
    expect(Object.keys(off.mcpConfig?.mcpServers ?? {})).not.toContain("device");
    expect(JSON.stringify(off.systemPrompt ?? off.prompt)).not.toContain("mcp__device__mac_exec");
  } finally {
    host.current?.close();
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 180_000);
