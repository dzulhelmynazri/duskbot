import { mkdtemp, symlink, truncate, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASS } from "../routes/table.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { startFakeSlack, type FakeSlack } from "../testing/fake-slack.ts";
import { createSlackApi } from "./api.ts";
import { createSlackToolRoutes, type SlackToolContext } from "./tools.ts";

const fakes: FakeSlack[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

async function fixture() {
  const fake = await startFakeSlack();
  fakes.push(fake);
  const tmpDir = await mkdtemp(join(tmpdir(), "madani-slack-tools-"));
  dirs.push(tmpDir);
  const api = createSlackApi({ env: { MADANI_SLACK_API_URL: fake.url }, minGapMs: 0, maxRetries: 0 });
  const redirect = "http://127.0.0.1:3210/callback";
  const app = await api.call<{ app_id: string }>("apps.manifest.create", fake.config.access, {
    manifest: { features: { bot_user: { display_name: "Helper" } }, oauth_config: { redirect_urls: [redirect] } },
  });
  const credentials = fake.apps.get(app.app_id)!.credentials;
  const installed = await api.call<{ access_token: string; bot_user_id: string; team: { id: string } }>("oauth.v2.access", null,
    { client_id: credentials.client_id, client_secret: credentials.client_secret, code: fake.mintCode(app.app_id), redirect_uri: redirect });
  const record = { botToken: installed.access_token, botUserId: installed.bot_user_id, teamId: installed.team.id, handle: "helper" };
  const link = vi.fn((_botId: string): typeof record | null => record);
  const events: string[] = [];
  const markOutside = vi.fn((threadId: string) => { events.push(`outside:${threadId}`); });
  const log = vi.fn();
  const route = createSlackToolRoutes({ api, link, markOutside, log });
  async function request(name: string, raw: unknown = {}, overrides: Partial<SlackToolContext> = {}) {
    let status = 0, body: { text?: string; error?: string; ok?: boolean } = {};
    const json: SlackToolContext["json"] = (_res, code, data) => {
      events.push("answer"); status = code; body = data as typeof body;
      expect(JSON.stringify(data).includes(record.botToken)).toBe(false);
    };
    const requireActive = vi.fn(() => { events.push("active"); });
    const ctx: SlackToolContext = { method: "POST", path: `/api/internal/slack/${name}`, res: {} as ServerResponse, json,
      botId: "bot", threadId: "thread", folders: async () => ({ roots: [tmpDir], vmWorkspace: null }),
      readBody: async () => { events.push("body"); return raw; }, requireActive, ...overrides };
    const result = await route(ctx);
    return { status, body, result, requireActive, data: () => JSON.parse(body.text!) };
  }
  return { fake, api, tmpDir, link, markOutside, events, request, log, record };
}

describe("the bot's own Slack tool routes", () => {
  it("passes other methods, paths and unknown tool names without reading a body", async () => {
    const f = await fixture();
    const readBody = vi.fn();
    for (const overrides of [{ method: "GET" }, { path: "/api/other" }, {}]) {
      expect((await f.request("slack_unknown", {}, { readBody, ...overrides })).result).toBe(PASS);
    }
    expect(readBody).not.toHaveBeenCalled();
  });

  it("posts by channel name and id as the bot, caching channel names", async () => {
    const f = await fixture();
    const named = await f.request("slack_post", { channel: "#general", text: "**Hello** & welcome" });
    expect(named.status).toBe(200);
    expect(named.data()).toEqual({ channel: "C0GENERAL", ts: f.fake.posted[0]!.ts });
    await f.request("slack_post", { channel: "general", text: "again" });
    const direct = await f.request("slack_post", { channel: "C0PRIVATE", text: "in thread", thread_ts: "1700000000.000001" });
    expect(direct.status).toBe(200);
    expect(f.fake.posted.map((post) => [post.channel, post.text, post.thread_ts])).toEqual([
      ["C0GENERAL", "*Hello* &amp; welcome", undefined], ["C0GENERAL", "again", undefined], ["C0PRIVATE", "in thread", "1700000000.000001"],
    ]);
    expect(f.fake.callsTo("conversations.list")).toHaveLength(1);
    expect(f.fake.callsTo("conversations.list")[0]!.params).toMatchObject({ types: "public_channel,private_channel", exclude_archived: "true" });
    expect(f.fake.callsTo("chat.postMessage").every((call) => call.token === f.record.botToken && call.params.mrkdwn === "true")).toBe(true);
    expect(f.link).toHaveBeenCalledWith("bot");
  });

  it("splits long text and queues each post in order, returning the first timestamp", async () => {
    const f = await fixture();
    const queued = vi.spyOn(f.api, "queued");
    const text = "a".repeat(3900) + "b".repeat(3900) + "c".repeat(500);
    const result = await f.request("slack_post", { channel: "C0123", text });
    expect(result.status).toBe(200);
    expect(f.fake.posted.map((post) => post.text)).toEqual(["a".repeat(3900), "b".repeat(3900), "c".repeat(500)]);
    expect(result.data().ts).toBe(f.fake.posted[0]!.ts);
    expect(queued.mock.calls.map(([key]) => key)).toEqual(["C0123", "C0123", "C0123"]);
    expect(f.fake.callsTo("conversations.list")).toHaveLength(0);
  });

  it("replies using the thread timestamp from a link, or its message timestamp", async () => {
    const f = await fixture();
    const result = await f.request("slack_reply", { link: "https://example.slack.com/archives/C0123/p1700000000123456?thread_ts=1699999999.654321&cid=C0123", text: "reply" });
    expect(result.status).toBe(200);
    expect(f.fake.posted[0]).toMatchObject({ channel: "C0123", thread_ts: "1699999999.654321", text: "reply" });
    await f.request("slack_reply", { link: "https://example.slack.com/archives/C0123/p1700000000123456", text: "reply" });
    expect(f.fake.posted[1]).toMatchObject({ thread_ts: "1700000000.123456" });
  });

  it.each([
    "not a link", "http://example.slack.com/archives/C0123/p1700000000123456", "https://example.slack.com.evil.test/archives/C0123/p1700000000123456",
    "https://example.slack.com/archives/C0123/p123", "https://example.slack.com/archives/C0123/p1700000000123456?thread_ts=bad",
    "https://name:password@example.slack.com/archives/C0123/p1700000000123456",
  ])("refuses an invalid message link: %s", async (link) => {
    const f = await fixture();
    const result = await f.request("slack_reply", { link, text: "reply" });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("Use a Slack message link (Copy link on the message).");
    expect(f.fake.posted).toHaveLength(0);
  });

  it("reacts with a normalized emoji and treats already_reacted as success", async () => {
    const f = await fixture();
    for (const emoji of [":eyes:", "eyes"]) {
      const result = await f.request("slack_react", { channel: "#general", ts: "1700000000.123456", emoji });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
    }
    expect(f.fake.reactions.map((reaction) => reaction.name)).toEqual(["eyes", "eyes"]);
    expect((await f.request("slack_react", { channel: "C0123", ts: "1700000000.123456", emoji: "bad emoji" })).status).toBe(400);
    expect(f.fake.reactions).toHaveLength(2);
  });

  it("uploads a working-folder file with no upload auth header and completes it in a thread", async () => {
    const f = await fixture();
    await writeFile(join(f.tmpDir, "report.txt"), "hello file");
    const result = await f.request("slack_upload", { path: "report.txt", channel: "#general", thread_ts: "1700000000.123456", comment: "Here it is." });
    expect(result.status).toBe(200);
    expect(f.fake.uploads).toHaveLength(1);
    expect(f.fake.uploads[0]).toMatchObject({ filename: "report.txt", bytes: Buffer.from("hello file"), authorization: null });
    expect(f.fake.completed[0]).toMatchObject({ channel_id: "C0GENERAL", thread_ts: "1700000000.123456", initial_comment: "Here it is.",
      files: [{ id: f.fake.uploads[0]!.fileId, title: "report.txt" }] });
    expect(result.data()).toEqual({ channel: "C0GENERAL", file_id: f.fake.uploads[0]!.fileId });
  });

  it("refuses files outside the bot folder, including symlinks, and files over 25 MB", async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "madani-slack-outside-"));
    dirs.push(outside);
    const path = join(outside, "private.txt");
    await writeFile(path, "private");
    await symlink(path, join(f.tmpDir, "escape.txt"));
    for (const file of [path, "escape.txt"]) {
      const result = await f.request("slack_upload", { path: file, channel: "C0123" });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("Only files in your working folder");
    }
    const large = join(f.tmpDir, "large.bin");
    await writeFile(large, "");
    await truncate(large, 25 * 1024 * 1024 + 1);
    expect((await f.request("slack_upload", { path: large, channel: "C0123" })).body.error).toMatch(/exceeds|at most 25 MB/);
    expect(f.fake.uploads).toHaveLength(0);
    expect(f.fake.callsTo("files.getUploadURLExternal")).toHaveLength(0);
  });

  it("reads history and threads, resolves names and mentions, and marks outside before answering", async () => {
    const f = await fixture();
    f.fake.seedMessages("C0GENERAL", [
      { ts: "1700000000.000001", user: "U0ALICE", text: "hello <@U0BOB> &amp; <https://example.test|Example>", reply_count: 1 },
      { ts: "1700000000.000002", user: "U0BOB", text: "reply", thread_ts: "1700000000.000001" },
    ]);
    const history = await f.request("slack_read", { channel: "#general" });
    expect(history.status).toBe(200);
    expect(history.data()).toEqual({ channel: "C0GENERAL", messages: [
      { ts: "1700000000.000002", user: "U0BOB", name: "Bob", text: "reply", thread_ts: "1700000000.000001" },
      { ts: "1700000000.000001", user: "U0ALICE", name: "Alice", text: "hello @Bob & Example (https://example.test)", reply_count: 1 },
    ] });
    expect(f.events.indexOf("outside:thread")).toBeLessThan(f.events.indexOf("answer"));
    expect(f.events.slice(0, 2)).toEqual(["body", "active"]);
    expect(f.events.slice(-2)).toEqual(["active", "answer"]);
    f.events.length = 0;
    const thread = await f.request("slack_read", { channel: "C0GENERAL", thread_ts: "1700000000.000001", limit: 1 });
    expect(thread.data().messages).toHaveLength(1);
    expect(thread.data().messages[0].name).toBe("Alice");
    expect(f.fake.callsTo("conversations.history")[0]!.params.limit).toBe("20");
    expect(f.fake.callsTo("conversations.replies")[0]!.params).toEqual({ channel: "C0GENERAL", ts: "1700000000.000001", limit: "1" });
    expect(f.fake.callsTo("users.info")).toHaveLength(2);
    expect(f.markOutside).toHaveBeenCalledTimes(2);
    expect(f.events.indexOf("outside:thread")).toBeLessThan(f.events.indexOf("answer"));
  });

  it("lists paged channels, expires the cache after five minutes and marks the result outside", async () => {
    const f = await fixture();
    for (let i = 0; i < 200; i++) f.fake.addChannel({ id: `C0EXTRA${i}`, name: `extra-${i}`, is_member: false });
    const listed = await f.request("slack_channels");
    expect(listed.status).toBe(200);
    expect(listed.data()).toHaveLength(202);
    expect(listed.data()[0]).toEqual({ id: "C0GENERAL", name: "general", private: false, member: true });
    expect(listed.data()[1]).toEqual({ id: "C0PRIVATE", name: "secret-room", private: true, member: true });
    expect(f.fake.callsTo("conversations.list")).toHaveLength(2);
    expect(f.markOutside).toHaveBeenCalledWith("thread");
    await f.request("slack_channels");
    expect(f.fake.callsTo("conversations.list")).toHaveLength(2);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
    await f.request("slack_channels");
    expect(f.fake.callsTo("conversations.list")).toHaveLength(4);
  });

  it("sends DMs by user id and email through conversations.open", async () => {
    const f = await fixture();
    for (const user of ["U0ALICE", "alice@example.test"]) {
      const result = await f.request("slack_dm", { user, text: "**hi**" });
      expect(result.status).toBe(200);
      expect(result.data().channel).toBe("D0ALICE");
    }
    expect(f.fake.callsTo("users.lookupByEmail")).toHaveLength(1);
    expect(f.fake.callsTo("conversations.open").map((call) => call.params)).toEqual([{ users: "U0ALICE" }, { users: "U0ALICE" }]);
    expect(f.fake.posted.map((post) => post.text)).toEqual(["*hi*", "*hi*"]);
    expect((await f.request("slack_dm", { user: "not a user", text: "hi" })).status).toBe(400);
  });

  it("returns 409 when unlinked and names an invisible channel in a 404", async () => {
    const f = await fixture();
    f.link.mockReturnValueOnce(null);
    const missing = await f.request("slack_channels");
    expect(missing.status).toBe(409);
    expect(missing.body.error).toBe("This bot isn't connected to Slack. Ask the person to add it in the bot's Slack settings.");
    expect(missing.requireActive).toHaveBeenCalledTimes(2);
    const unknown = await f.request("slack_post", { channel: "#invisible", text: "hi" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("No channel named #invisible that this bot can see.");
    expect(f.fake.posted).toHaveLength(0);
  });

  it.each([
    ["not_in_channel", "/invite @helper"], ["channel_not_found", "Slack can't find that channel."],
    ["ratelimited", "Slack is rate limiting this bot; try again in a minute."],
    ["missing_scope", "This bot's Slack app lacks a permission for that. Remove it from Slack and add it again."],
    ["invalid_auth", "Slack refused that: invalid_auth"],
  ])("renders %s as a friendly refusal", async (error, message) => {
    const f = await fixture();
    f.fake.fail("chat.postMessage", error);
    const result = await f.request("slack_post", { channel: "C0123", text: "hello" });
    expect(result.status).toBe(error === "ratelimited" ? 429 : 400);
    expect(result.body.error).toContain(message);
  });

  it("never includes the bot token in a refusal, read, path or log", async () => {
    const f = await fixture();
    f.fake.fail("chat.postMessage", f.record.botToken);
    const error = await f.request("slack_post", { channel: "C0123", text: "hi" });
    expect(error.status).toBe(400);
    await f.request("slack_upload", { path: f.record.botToken, channel: "C0123" });
    await f.request("slack_post", { channel: `#${f.record.botToken}`, text: "hi" });
    f.fake.seedMessages("C0123", [{ ts: "1700000000.123456", text: f.record.botToken }]);
    await f.request("slack_read", { channel: "C0123" });
    expect(JSON.stringify(f.log.mock.calls).includes(f.record.botToken)).toBe(false);
  });

  it("validates exact fields and caps, refusing body-supplied bot identity", async () => {
    const f = await fixture();
    for (const [tool, args] of [
      ["slack_channels", { botId: "other-bot" }], ["slack_post", { channel: "C0123", text: "x".repeat(40_001) }],
      ["slack_read", { channel: "C0123", limit: 101 }], ["slack_read", { channel: "C0123", limit: 0 }],
      ["slack_read", { channel: "C0123", limit: 1.5 }], ["slack_post", { channel: "C0123", text: "hi", thread_ts: "bad" }],
    ] as const) expect((await f.request(tool, args)).status).toBe(400);
    expect(f.fake.callsTo("chat.postMessage")).toHaveLength(0);
    expect(f.fake.callsTo("conversations.history")).toHaveLength(0);
  });

  it("checks activity after the body and again before returning content", async () => {
    const f = await fixture();
    const json = vi.fn();
    const stopped = new Error("Fixture turn ended.");
    await expect(f.request("slack_channels", {}, { requireActive: () => { throw stopped; }, json })).rejects.toBe(stopped);
    expect(f.fake.callsTo("conversations.list")).toHaveLength(0);
    const requireActive = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw stopped; });
    await expect(f.request("slack_channels", {}, { requireActive, json })).rejects.toBe(stopped);
    expect(requireActive).toHaveBeenCalledTimes(2);
    expect(json).not.toHaveBeenCalled();
  });
});
