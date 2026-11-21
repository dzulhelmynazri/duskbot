import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-madani.ts";
import type { BackupTask, TeamBackup } from "../shared/team-backup.ts";
import type { WireBot, WireGroup, WireMessage } from "../shared/wire.ts";

function history(key: string, length: number): BackupTask {
  const messages = Array.from({ length }, (_, index) => ({
    id: `${key}-${index}`, role: index % 2 ? "bot" as const : "user" as const,
    text: `${key} line ${index}: ${"fixture conversation ".repeat(20)}`, at: index + 1,
    parentId: index ? `${key}-${index - 1}` : null,
  }));
  return { key, title: key, createdAt: 1, activeLeafId: messages.at(-1)!.id, messages };
}

it("sends every conversation's newest page in one reply, and only the ones asked for", async () => {
  const fixture = await launchVerificationServer({});
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    expect(response.ok, text.slice(0, 300)).toBe(true);
    return { body: JSON.parse(text), bytes: Buffer.byteLength(text), gzipped: gzipSync(text).byteLength };
  };
  try {
    const backup: TeamBackup = {
      format: "madani.backup", version: 1, name: "Bulk fixture", exportedAt: 1, warnings: [], routines: [],
      bots: Array.from({ length: 12 }, (_, index) => ({
        key: `bot-${index}`, name: `Fixture ${index}`, title: "", description: "", color: "green", chiefOfStaff: false,
        hidden: false, playbooks: [], activeTask: `bot-${index}-main`, tasks: [history(`bot-${index}-main`, index % 2 ? 120 : 8)],
      })),
      groups: [{ key: "group", name: "Fixture room", memberIds: ["bot-0", "bot-1"], dm: false, bulletin: "",
        defaultResponder: { kind: "mentions" }, activeTask: "room-main", tasks: [history("room-main", 70)] }],
    };
    const imported = (await request("/api/teams/import", "POST", backup)).body as { bots: WireBot[]; groups: WireGroup[] };
    const bulk = await request("/api/transcripts?limit=50");
    const threads = bulk.body.threads as Array<{ threadId: string; messages: WireMessage[]; hasMore: boolean; activeLeafId: string | null }>;
    const ids = new Set(threads.map((thread) => thread.threadId));
    for (const owner of [...imported.bots, ...imported.groups]) expect(ids.has(owner.threadId!)).toBe(true);
    for (const owner of imported.bots) {
      const page = (await request(`/api/threads/${owner.threadId}/messages?limit=50`)).body;
      const thread = threads.find((candidate) => candidate.threadId === owner.threadId)!;
      expect(thread.messages).toEqual(page.messages);
      expect(thread.hasMore).toBe(page.hasMore);
      expect(thread.activeLeafId).toBe(page.activeLeafId);
    }
    const room = threads.find((thread) => thread.threadId === imported.groups[0]!.threadId)!;
    expect(room.messages).toHaveLength(50);
    expect(room.hasMore).toBe(true);

    // a bot on another of its threads: its main conversation, the one its chat opens to, comes too
    const moved = imported.bots[2]!;
    const away = (await request(`/api/bots/${moved.id}/tasks`, "POST", {})).body as { bot: WireBot };
    await request(`/api/bots/${moved.id}`, "PATCH", { mainThreadChoice: moved.threadId });
    expect(away.bot.threadId).not.toBe(moved.threadId);
    const both = (await request("/api/transcripts?limit=50")).body.threads as Array<{ threadId: string; messages: WireMessage[] }>;
    expect(both.find((thread) => thread.threadId === moved.threadId)?.messages).toHaveLength(8);
    expect(both.some((thread) => thread.threadId === away.bot.threadId)).toBe(true);

    const picked = [imported.bots[1]!.threadId!, imported.groups[0]!.threadId];
    const some = (await request(`/api/transcripts?limit=50&threads=${picked.join(",")}`)).body.threads as Array<{ threadId: string }>;
    expect(some.map((thread) => thread.threadId).sort()).toEqual([...picked].sort());
    console.info(`bulk transcripts: ${threads.length} conversations, ${bulk.bytes} bytes, ${bulk.gzipped} gzipped`);
  } finally {
    await fixture.close();
  }
}, 60_000);
