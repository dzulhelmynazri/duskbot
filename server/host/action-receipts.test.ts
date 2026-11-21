import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { claimedActions, connectorActionKind, createActionReceipts, toolEvidence, type ActionKind } from "./action-receipts.ts";

type Body = RuntimeEvent extends infer E ? E extends RuntimeEvent ? Omit<E, "eventId" | "provider" | "threadId" | "createdAt"> : never : never;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), "madani-receipts-"));
  dirs.push(dataDir);
  const marks: Array<{ threadId: string; turnId?: string; kinds: ActionKind[] }> = [];
  const receipts = createActionReceipts({ dataDir, botOf: (threadId) => (threadId === "room" ? null : "bot-1"), mark: (threadId, turnId, kinds) => { marks.push({ threadId, turnId, kinds }); return true; } });
  const send = (body: Body & { itemId?: string; turnId?: string }) => receipts.onEvent({ eventId: "e", provider: "fake", threadId: "t1", createdAt: "", ...body } as RuntimeEvent);
  return { dataDir, marks, receipts, send };
}

describe("claimedActions", () => {
  it.each<[string, ActionKind[]]>([
    ["Done. I sent the email to Priya.", ["send"]],
    ["Sent! It went to all three of them.", ["send"]],
    ["The invite has been sent and the table is booked.", ["send", "book"]],
    ["I've saved the report to Documents/q3.md.", ["file"]],
    ["I downloaded the PDF.", ["download"]],
    ["I ordered the blue one.", ["buy"]],
    ["I drafted a reply for you to send.", []],
    ["Should I send it now?", []],
    ["I couldn't send it: Gmail is not connected.", []],
    ["I'll book it once you confirm.", []],
    ["You sent this yesterday.", []],
  ])("%s", (text, kinds) => {
    expect(claimedActions(text).sort()).toEqual([...kinds].sort());
  });
});

describe("evidence", () => {
  it("reads what a tool call did from its title and command", () => {
    expect(toolEvidence("agent_browser_click", undefined)).toBe("browser");
    expect(toolEvidence("Bash", "curl -L -o report.pdf https://example.com/r.pdf")).toBe("download");
    expect(toolEvidence("Bash", "echo hi > notes.txt")).toBe("file");
    expect(toolEvidence("Bash", "ls -la")).toBe("shell");
    expect(toolEvidence("Write", undefined)).toBe("file");
    expect(toolEvidence("Read", undefined)).toBeNull();
    expect(connectorActionKind("GMAIL_SEND_EMAIL")).toBe("send");
    expect(connectorActionKind("GOOGLECALENDAR_CREATE_EVENT")).toBe("book");
    expect(connectorActionKind("GOOGLEDRIVE_UPLOAD_FILE")).toBe("file");
  });
});

describe("action receipts", () => {
  it("drops receipt months that ended more than 30 days ago, so the folder cannot grow forever", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "madani-receipts-"));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, "receipts"));
    for (const name of ["2026-01.jsonl", "2026-09.jsonl", "notes.txt"]) writeFileSync(join(dataDir, "receipts", name), "{}\n");
    const receipts = createActionReceipts({ dataDir, botOf: () => "bot-1", mark: () => true, now: () => Date.parse("2026-11-12T00:00:00Z") });
    receipts.record("t1", "GMAIL_SEND_EMAIL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readdirSync(join(dataDir, "receipts")).sort()).toEqual(["2026-11.jsonl", "notes.txt"]);
  });

  it("marks a reply that claims a send its turn has no receipt for", () => {
    const h = harness();
    h.send({ type: "turn.started", turnId: "turn-1" });
    h.send({ type: "item.completed", itemType: "assistant_text", text: "Done. I sent the email to Priya." });
    h.send({ type: "turn.completed", ok: true, turnId: "turn-1" });
    expect(h.marks).toEqual([{ threadId: "t1", turnId: "turn-1", kinds: ["send"] }]);
  });

  it("leaves a reply alone when the relay carried the send, and writes the receipt with the tool name only", async () => {
    const h = harness();
    h.send({ type: "turn.started", turnId: "turn-2" });
    h.receipts.relayed("t1", ["GMAIL_SEND_EMAIL"], 200, new TextEncoder().encode('{"result":{"content":[{"type":"text","text":"{\\"successful\\":true}"}]}}'));
    h.send({ type: "item.completed", itemType: "assistant_text", text: "Sent it to Priya." });
    h.send({ type: "turn.completed", ok: true });
    expect(h.marks).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const file = readdirSync(join(h.dataDir, "receipts"))[0]!;
    expect(JSON.parse(readFileSync(join(h.dataDir, "receipts", file), "utf8").trim())).toMatchObject({ botId: "bot-1", threadId: "t1", kind: "send", what: "GMAIL_SEND_EMAIL" });
  });

  it("gives no receipt for a relayed call the app refused, and counts a browser step as a send's proof", () => {
    const h = harness();
    h.send({ type: "turn.started" });
    h.receipts.relayed("t1", ["GMAIL_SEND_EMAIL"], 200, new TextEncoder().encode('{"successful": false}'));
    h.send({ type: "item.completed", itemType: "assistant_text", text: "I sent it." });
    h.send({ type: "turn.completed", ok: true });
    expect(h.marks).toHaveLength(1);

    h.send({ type: "turn.started" });
    h.send({ type: "item.started", itemType: "tool", itemId: "c1", title: "agent_browser_click" });
    h.send({ type: "item.completed", itemType: "tool", itemId: "c1", ok: true });
    h.send({ type: "item.completed", itemType: "assistant_text", text: "I sent it." });
    h.send({ type: "turn.completed", ok: true });
    expect(h.marks).toHaveLength(1);
  });
});
