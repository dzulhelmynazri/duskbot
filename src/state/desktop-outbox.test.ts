import { describe, expect, it } from "vitest";
import type { Action } from "./store";
import { createOutbox } from "./outbox-queue";
import { desktopOutboxKey, storagePrefs } from "./desktop-outbox";

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
}

const send = { kind: "bot" as const, ownerId: "echo", threadId: "main", sendId: "s1", text: "plan my week", at: 1_000 };

describe("the desktop's unsent messages", () => {
  it("keep a send whose answer never came, and send it again once with the same sendId when the connection is back", async () => {
    const storage = memoryStorage();
    const outbox = createOutbox(storagePrefs(storage), desktopOutboxKey("http://127.0.0.1:5199"), () => 2_000);
    await outbox.ready;
    outbox.hold(send);
    expect(outbox.keep("s1"), "the bubble stays as sending").toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.map.get("madanibot.outbox.v1:http://127.0.0.1:5199"), "and survives a restart").toContain("\"sendId\":\"s1\"");

    const sent: Action[] = [];
    await outbox.flush((action) => { sent.push(action); outbox.hold(send); });
    expect(sent).toEqual([{ type: "send", botId: "echo", threadId: "main", text: "plan my week", sendId: "s1" }]);
    outbox.release("s1");
    expect(outbox.pending()).toEqual([]);
  });

  it("are kept per server, so one workspace's messages never go to another", () => {
    expect(desktopOutboxKey("http://127.0.0.1:5199")).not.toBe(desktopOutboxKey("https://preview.madani.bot"));
  });

  it("stay in memory when storage refuses", async () => {
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); } };
    const prefs = storagePrefs(refusing);
    await expect(prefs.set("k", "v")).resolves.toBeUndefined();
    await expect(prefs.get("k")).resolves.toBeNull();
  });
});
