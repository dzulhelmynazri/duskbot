// A room keeps the folder it started in; once that folder is gone, a member's turn runs in its own folder instead of failing.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";

it("work handed into a room whose folder was deleted still runs, in the member's own folder, and the room lets go of it", async () => {
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
    const lead = (await cli("new-bot", "--name", "Sam")).bot;
    const cliff = (await cli("new-bot", "--name", "Cliff")).bot;
    const codexModel = (await cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options[0].id;
    await cli("set-model", "--bot", cliff.id, "--instance", "codex", "--model", codexModel);
    // Cliff's own folder is fine: a direct message would run there.
    const own = join(dataDir, "cliff-own");
    mkdirSync(own);
    await api("PATCH", `/api/bots/${cliff.id}`, { cwd: own });

    const site = join(dataDir, "site");
    mkdirSync(site);
    const { group: room } = await api("POST", "/api/groups", {
      name: "Launch room", memberIds: [lead.id, cliff.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    await api("PATCH", `/api/groups/${room.id}`, { cwd: site });
    rmSync(site, { recursive: true });

    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [lead.id]: { steps: [{ arguments: { group_id: room.id, bot_ids: [cliff.id], message: "Draft the launch post.", request_key: "launch" } }], reply: "Assigned", resumeReply: "Done" },
    }));
    await api("POST", `/api/bots/${lead.id}/messages`, { text: "Get Cliff drafting in the launch room." });

    const pins = async () => { const g = (await api("GET", "/api/bots?messages=0")).groups.find((entry: any) => entry.id === room.id); return [g.pinnedCwd, ...(g.tasks ?? []).map((task: any) => task.pinnedCwd)]; };
    const lines = async () => (await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).messages as any[];
    await expect.poll(async () => (await lines()).some((m) => m.role === "bot" && m.from?.botId === cliff.id && m.kind === "text"), { timeout: 40_000 }).toBe(true);
    expect((await lines()).filter((m) => m.kind === "activity" && m.tool?.ok === false && m.from?.botId === cliff.id)).toEqual([]);
    expect(await pins()).not.toContain(site);
    expect(await pins()).toContain(null);
  } finally {
    await session.close();
  }
}, 120_000);
