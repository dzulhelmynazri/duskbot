import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatDocumentCard } from "../../shared/documents.ts";
import { BotDocuments } from "../bot-documents.ts";
import { callDocumentTool, DOCUMENT_TOOL_DEFINITIONS, DOCUMENT_TOOL_NAMES } from "../drivers/agents-document-tools.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createDocumentRoutes, DOCUMENTS_INTERNAL } from "./bot-documents.ts";
import { PASS, type RouteContext } from "./table.ts";

type Answer = { status: number; body: Record<string, unknown> };

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTempDir)); });

function harness() {
  const root = mkdtempSync(join(tmpdir(), "madani-documents-route-"));
  roots.push(root);
  const documents = new BotDocuments(root);
  const posted: Array<{ botId: string; threadId: string; text: string; card: ChatDocumentCard }> = [];
  const { internal, routes } = createDocumentRoutes({
    documents,
    bot: (id) => (id === "bot1" || id === "bot2" ? { id } : null),
    post: (botId, threadId, text, card) => { posted.push({ botId, threadId, text, card }); return `m${posted.length}`; },
  });
  const tool = async (body: unknown, botId = "bot1", threadId = "t1") => {
    let answer: Answer | null = null;
    const out = await internal({ method: "POST", path: DOCUMENTS_INTERNAL, res: {} as ServerResponse, botId, threadId, readBody: async () => body,
      json: (_res, status, payload) => { answer = { status, body: payload as Answer["body"] }; } });
    return out === PASS ? PASS : answer!;
  };
  const http = async (method: string, path: string, body?: unknown) => {
    let answer: Answer | null = null;
    const out = await routes({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://x${path}`), path, method, auth: {} as RouteContext["auth"],
      json: (_res, status, payload) => { answer = { status, body: payload as Answer["body"] }; },
      readBody: (async () => body) as unknown as RouteContext["readBody"],
    });
    return out === PASS && !answer ? PASS : answer!;
  };
  return { documents, posted, tool, http };
}

describe("the document tools' route", () => {
  it("creates a document, posts its card and tells the bot to keep its reply short", async () => {
    const { tool, posted } = harness();
    const answer = await tool({ action: "create", title: "Q3 plan", kind: "markdown", content: "# Q3\n\n- ship" });
    expect(answer).toMatchObject({ status: 200 });
    expect(String((answer as Answer).body.text)).toMatch(/Saved "Q3 plan" \(id d_[0-9a-f]{12}, version 1\)\. It shows in the chat/);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ botId: "bot1", threadId: "t1", text: 'Made the document "Q3 plan".', card: { kind: "markdown", change: "created", lines: ["Q3", "ship"] } });
  });

  it("masks a secret before it is stored", async () => {
    const { tool, documents } = harness();
    const answer = await tool({ action: "create", title: "Keys", kind: "markdown", content: "key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" }) as Answer;
    expect(String(answer.body.text)).toContain("masked");
    const stored = documents.get("bot1", String(answer.body.id))!;
    expect(stored.content).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("updates, lists and reads only the calling bot's documents", async () => {
    const { tool, posted } = harness();
    const made = await tool({ action: "create", title: "Leads", kind: "sheet", content: "name\nAda" }) as Answer;
    const id = String(made.body.id);
    const updated = await tool({ action: "update", id, content: "name\nAda\nLin" }) as Answer;
    expect(updated.body.text).toContain("version 2");
    expect(posted.at(-1)!.card).toMatchObject({ change: "updated", rows: 2, version: 2 });
    expect(String(((await tool({ action: "list" })) as Answer).body.text)).toContain(`${id} | sheet | Leads | v2, 2 rows x 1 columns`);
    expect(String(((await tool({ action: "list", id })) as Answer).body.text)).toContain("--- content ---\nname\nAda\nLin");
    expect(await tool({ action: "list", id }, "bot2")).toMatchObject({ status: 404 });
    expect(await tool({ action: "update", id, content: "x" }, "bot2")).toMatchObject({ status: 404 });
    expect(await tool({ action: "update", id })).toMatchObject({ status: 400 });
  });

  it("calls the route with the tool's action", async () => {
    const calls: unknown[] = [];
    const context = { client: { apiResponse: async (_path: string, init: { body: string }) => { calls.push(JSON.parse(init.body)); return { ok: true, body: { text: "ok" } }; } } };
    expect(DOCUMENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...DOCUMENT_TOOL_NAMES]);
    await callDocumentTool("update_document", { id: "d_000000000000", action: "create" }, context as never);
    expect(calls).toEqual([{ id: "d_000000000000", action: "update" }]);
  });
});

describe("the panel's document routes", () => {
  it("lists, reads, edits, restores and deletes", async () => {
    const { tool, http } = harness();
    const id = String(((await tool({ action: "create", title: "Notes", kind: "markdown", content: "one" })) as Answer).body.id);
    expect(((await http("GET", "/api/bots/bot1/documents")) as Answer).body.documents).toHaveLength(1);
    expect(await http("GET", `/api/bots/bot1/documents/${id}`)).toMatchObject({ status: 200, body: { content: "one" } });
    expect(await http("PATCH", `/api/bots/bot1/documents/${id}`, { content: "two", expectedVersion: 1 })).toMatchObject({ status: 200, body: { version: 2, by: "person" } });
    expect(await http("PATCH", `/api/bots/bot1/documents/${id}`, { content: "three", expectedVersion: 1 })).toMatchObject({ status: 409 });
    expect(await http("POST", `/api/bots/bot1/documents/${id}/restore`, { version: 1 })).toMatchObject({ status: 200, body: { content: "one", version: 3 } });
    expect(await http("GET", `/api/bots/bot2/documents/${id}`)).toMatchObject({ status: 404 });
    expect(await http("GET", `/api/bots/nobody/documents`)).toMatchObject({ status: 404 });
    expect(await http("DELETE", `/api/bots/bot1/documents/${id}`)).toMatchObject({ status: 200 });
    expect(await http("GET", `/api/bots/bot1/documents/${id}`)).toMatchObject({ status: 404 });
    expect(await http("GET", "/api/bots/bot1/memory")).toBe(PASS);
  });
});
