import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";
import type { BackupTask, TeamBackup } from "../shared/team-backup.ts";
import type { WireBot, WireGroup, WireMessage } from "../shared/wire.ts";

type SnapshotBot = WireBot & { messages: WireMessage[]; previewMessages?: WireMessage[] };
type SnapshotGroup = WireGroup & { messages: WireMessage[]; previewMessages?: WireMessage[] };

function history(key: string): BackupTask {
  const messages = Array.from({ length: 220 }, (_, index) => ({
    id: `${key}-${index}`, role: index % 2 ? "bot" as const : "user" as const,
    text: `${key} line ${index}: ${"fixture conversation ".repeat(50)}`, at: index + 1,
    parentId: index ? `${key}-${index - 1}` : null,
  }));
  return { key, title: key, createdAt: 1, activeLeafId: messages.at(-1)!.id, messages };
}

it("sends full history only for the selected conversation and preserves on-demand bot, group and sibling histories", async () => {
  const fixture = await launchVerificationServer({});
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    expect(response.ok, text.slice(0, 300)).toBe(true);
    return { body: JSON.parse(text), bytes: Buffer.byteLength(text) };
  };
  try {
    const backup: TeamBackup = {
      format: "madani.backup", version: 1, name: "Startup fixture", exportedAt: 1, warnings: [], routines: [],
      bots: Array.from({ length: 13 }, (_, index) => ({
        key: `bot-${index}`, name: `Fixture ${index}`, title: "", description: "", color: "green", chiefOfStaff: false,
        hidden: false, playbooks: [], activeTask: `bot-${index}-main`, tasks: [history(`bot-${index}-main`), history(`bot-${index}-sibling`)],
      })),
      groups: [{ key: "group", name: "Fixture room", memberIds: ["bot-0", "bot-1"], dm: false, bulletin: "",
        defaultResponder: { kind: "mentions" }, activeTask: "room-main", tasks: [history("room-main"), history("room-sibling")] }],
    };
    const imported = (await request("/api/teams/import", "POST", backup)).body as { bots: SnapshotBot[]; groups: SnapshotGroup[] };
    expect(imported.bots).toHaveLength(13);
    const selected = imported.bots[5]!;
    const full = await request("/api/bots?messages=200");
    const slim = await request(`/api/bots?messages=200&selected=${selected.id}`);
    const fullBots = full.body.bots as SnapshotBot[];
    const slimBots = slim.body.bots as SnapshotBot[];
    expect(slim.body.loadedThreads).toEqual([selected.threadId]);
    expect(slimBots.find((bot) => bot.id === selected.id)!.messages).toEqual(fullBots.find((bot) => bot.id === selected.id)!.messages);
    expect(slimBots.filter((bot) => bot.id !== selected.id).every((bot) => (bot.messages?.length ?? 0) <= 1)).toBe(true);
    expect(slimBots.every((bot) => (bot.previewMessages?.length ?? 0) <= 4)).toBe(true);
    expect(slim.body.groups.every((group: SnapshotGroup) => group.messages.length <= 1)).toBe(true);
    expect(slim.body.groups.every((group: SnapshotGroup) => (group.previewMessages?.length ?? 0) <= 4)).toBe(true);
    expect(slim.bytes).toBeLessThan(full.bytes / 4);

    const other = imported.bots[2]!;
    const lazy = (await request(`/api/threads/${other.threadId}/messages?limit=200`)).body;
    expect(lazy.messages).toEqual(fullBots.find((bot) => bot.id === other.id)!.messages);
    expect(lazy.hasMore).toBe(true);
    const older = (await request(`/api/threads/${other.threadId}/messages?limit=200&before=${lazy.messages[0].id}`)).body;
    expect(older.messages).toHaveLength(20);
    expect(older.hasMore).toBe(false);

    const group = imported.groups[0]!;
    const room = (await request(`/api/bots?messages=200&selected=${group.id}`)).body;
    expect(room.loadedThreads).toEqual([group.threadId]);
    expect(room.groups[0].messages).toEqual(full.body.groups[0].messages);
    expect(room.bots.every((bot: SnapshotBot) => bot.messages.length <= 1)).toBe(true);
    const sibling = other.tasks!.find((task) => task.threadId !== other.threadId)!;
    const switched = (await request(`/api/bots/${other.id}/tasks/${sibling.threadId}?messages=200`, "POST", {})).body.bot;
    expect(switched.threadId).toBe(sibling.threadId);
    expect(switched.messages).toHaveLength(200);
    const afterSwitch = (await request(`/api/bots?messages=200&selected=${other.id}`)).body;
    expect(afterSwitch.loadedThreads).toEqual([sibling.threadId]);
    expect(afterSwitch.bots.find((bot: WireBot) => bot.id === other.id).messages).toEqual(switched.messages);

    await runControlMadani(["send", "--bot", selected.id, "--task", selected.threadId, "--text", "Startup fixture live reply", "--url", fixture.info.url]);
    const settled = await runControlMadani(["wait", "--bot", selected.id, "--task", selected.threadId, "--timeout", "15", "--url", fixture.info.url]) as { status: string };
    expect(settled.status).toBe("settled");
    const afterReply = (await request(`/api/bots?messages=200&selected=${selected.id}`)).body;
    expect(afterReply.bots.find((bot: WireBot) => bot.id === selected.id).messages.some((message: { text?: string }) => message.text === "Startup fixture live reply")).toBe(true);
    const inactive = (await request(`/api/bots?messages=200&selected=${other.id}`)).body.bots.find((bot: WireBot) => bot.id === selected.id) as SnapshotBot;
    expect(inactive.messages).toHaveLength(1);
    expect(inactive.previewMessages?.some((message) => message.text === "hello from fake claude")).toBe(true);
    evidence.push({ fullBytes: full.bytes, selectiveBytes: slim.bytes, reductionPercent: Math.round((1 - slim.bytes / full.bytes) * 100), selected: selected.id,
      selectedMessages: 200, otherMessagesAtMost: 1, previewMessagesAtMost: 4, sibling: sibling.threadId, settled });
  } finally {
    writeFileSync(`${fixture.info.logPath}.selective-snapshot.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.info(`Selective snapshot evidence: ${fixture.info.logPath}.selective-snapshot.json`);
    await fixture.close();
  }
}, 60_000);
