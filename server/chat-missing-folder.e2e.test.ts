// A chat whose picked folder is gone keeps working in its own folder instead of failing the turn.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";

it("a message to a bot whose folder was deleted still gets a reply, from the chat's own folder", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, { scripted: true }, ["codex"]);
  const { url, dataDir } = session.info;
  const cli = (...args: string[]) => runControlMadani([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.ok, `${method} ${path} ${response.status}: ${JSON.stringify(value)}`).toBe(true);
    return value;
  };
  try {
    const created = (await cli("new-bot", "--name", "Cliff")).bot;
    const bot = (await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === created.id);
    const codexModel = (await cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options[0].id;
    await cli("set-model", "--bot", bot.id, "--instance", "codex", "--model", codexModel);
    const site = join(dataDir, "client-site");
    mkdirSync(site);
    await api("PATCH", `/api/bots/${bot.id}`, { cwd: site });
    rmSync(site, { recursive: true });

    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Draft the launch post." });
    const lines = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages as any[];
    await expect.poll(async () => (await lines()).some((m) => m.role === "bot" && m.kind === "text"), { timeout: 40_000 }).toBe(true);
    expect((await lines()).filter((m) => m.kind === "activity" && m.tool?.ok === false)).toEqual([]);
    const task = (await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === bot.threadId);
    expect(task.cwd.split(/[\\/]/).slice(-3)).toEqual(["task-workspaces", bot.id, bot.threadId]);
  } finally {
    await session.close();
  }
}, 120_000);
