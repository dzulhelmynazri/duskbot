import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A person's message with a picture, enough newer messages that it has left the engine's context, then a reply to it. */
async function replyToOldPicture(url: string, created: { id: string; threadId?: string; activeTaskId?: string }, wait: () => Promise<void>) {
  const bot = { id: created.id, threadId: created.threadId ?? created.activeTaskId! };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const uploaded = await fetch(`${url}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(PNG) });
  expect(uploaded.status).toBe(201);
  const { path } = await uploaded.json() as { path: string };
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `My receipt\n\n<attached-image path="${path}" name="receipt.png" />` });
  await wait();
  for (let index = 0; index < 3; index += 1) {
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `Later message ${index}` });
    await wait();
  }
  const { messages } = await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`);
  const pictured = messages.find((message: any) => message.role === "user" && message.text?.startsWith("My receipt"));
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "What was the total on this?", replyToId: pictured.id });
  await wait();
}

it("a reply to an old picture carries the picture to the Claude engine as an image", async () => {
  const fixture = await launchVerificationServer();
  const env = { MADANI_URL: fixture.info.url };
  try {
    const { bot } = await runControlMadani(["new-bot", "--name", "Reply picture fixture"], { env }) as any;
    await replyToOldPicture(fixture.info.url, bot, async () => {
      await runControlMadani(["wait", "--bot", bot.id, "--timeout", "30"], { env });
    });
    const content = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt.message.content;
    expect(Array.isArray(content), JSON.stringify(content).slice(0, 400)).toBe(true);
    const text = content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
    expect(text).toContain("What was the total on this?");
    expect(text).toContain("The quoted message's attachments");
    expect(text).not.toContain("<attached-image");
    expect(content.filter((block: any) => block.type === "image")).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
    ]);
  } finally {
    await fixture.close();
  }
}, 90_000);

it("a reply to an old picture carries the picture to an OpenAI-compatible engine in the reply's own message", async () => {
  const requests: any[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    if (req.method === "GET") { res.statusCode = 404; res.end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fixture reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Fixture provider has no port");
  const fixture = await launchVerificationServer();
  const env = { MADANI_URL: fixture.info.url };
  try {
    const put = (method: string, path: string, body: unknown) => fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await put("PUT", "/api/config", { openaiCompat: { url: `http://127.0.0.1:${address.port}/v1`, key: "synthetic-fixture-key", model: "fixture-model" } })).ok).toBe(true);
    expect((await put("PATCH", "/api/instances/openaiCompat", { tools: false })).ok).toBe(true);
    const { bot } = await runControlMadani(["new-bot", "--name", "Reply picture compat"], { env }) as any;
    await runControlMadani(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"], { env });
    await replyToOldPicture(fixture.info.url, bot, async () => {
      expect((await runControlMadani(["wait", "--bot", bot.id, "--timeout", "20"], { env }) as any).status).toBe("settled");
    });
    const last = requests.at(-1).messages.at(-1);
    expect(last.role).toBe("user");
    const parts = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
    expect(JSON.stringify(parts)).toContain("What was the total on this?");
    expect(parts.filter((part: any) => part.type === "image_url")).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
    ]);
  } finally {
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 90_000);
