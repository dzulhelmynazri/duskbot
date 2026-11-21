// Slack bots end to end on a real fixture server with the fake engine, against an in-process fake Slack: a workspace
// connects, a bot gets its own app, installs, comes online over Socket Mode, answers a DM and a channel mention in
// threads, ignores a redelivered event, takes a file in, sends one out, maps a reaction, uses its slack_* tools, and
// never lets a token reach a log, a transcript or the engine.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runControlMadani } from "../scripts/control-madani.ts";
import { startFakeSlack, type FakeSlack } from "./testing/fake-slack.ts";
import { launchRestartableServer, type RestartableServer } from "./testing/restartable-server.ts";

const REPLY = "**Done.** See [the docs](https://example.test/docs).";
const SLACK_REPLY = "*Done.* See <https://example.test/docs|the docs>.";
// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==", "base64");

describe("Slack bots on a fixture server", () => {
  let fake: FakeSlack;
  let server: RestartableServer;
  let scratch: string;
  let botId = "";
  let appId = "";
  let botUser = "";
  const callsFile = () => join(scratch, "tool-calls.json");
  const saved: Record<string, string | undefined> = {};
  const env = (key: string, value: string) => { saved[key] = process.env[key]; process.env[key] = value; };

  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${server.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const tasks = async () => (((await api("GET", "/api/bots?messages=0")).bots as any[]).find((bot) => bot.id === botId)?.tasks ?? []) as Array<{ threadId: string; title: string }>;
  const thread = async (title: string) => (await tasks()).find((task) => task.title === title)?.threadId;
  const messages = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages ?? []) as any[];
  const secrets = () => [fake.config.access, fake.config.refresh, ...[...fake.apps.values()].flatMap((app) => [app.credentials.client_secret, app.credentials.signing_secret])];

  beforeAll(async () => {
    fake = await startFakeSlack();
    scratch = join(process.env.TMPDIR ?? "/tmp", `madani-slack-e2e-${process.pid}-${Date.now()}`);
    mkdirSync(scratch, { recursive: true });
    env("MADANI_SLACK_API_URL", fake.url);
    env("MADANI_SAVED_SECRETS_KEY_FILE", join(scratch, "keys", "saved-secrets.key"));
    env("FAKE_CLAUDE_REPLIES", JSON.stringify(Array.from({ length: 40 }, () => REPLY)));
    env("FAKE_CLAUDE_REPLY_STATE", join(scratch, "reply-state"));
    env("FAKE_CLAUDE_TOOL_CALLS_FILE", callsFile());
    server = await launchRestartableServer();
  }, 90_000);

  afterAll(async () => {
    await server?.close();
    await fake?.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  it("connects the workspace with the pasted pair and stores the rotated one", async () => {
    expect((await api("GET", "/api/slack/workspace"))).toMatchObject({ state: "not_connected", ready: true });
    const pasted = { accessToken: fake.config.access, refreshToken: fake.config.refresh };
    const status = await api("PUT", "/api/slack/workspace", pasted);
    expect(status).toMatchObject({ version: 1, state: "connected", teamId: "T0FAKE", teamName: "Fake Team", apps: 0 });
    expect(fake.config.rotations).toBe(1);
    expect(JSON.stringify(status)).not.toContain(pasted.accessToken);
    // the pasted refresh token was spent by the first rotation
    expect(fake.config.refresh).not.toBe(pasted.refreshToken);
  });

  it("provisions an app from the bot, installs it through OAuth and brings it online with the app-level token", async () => {
    botId = ((await runControlMadani(["new-bot", "--name", "Nova", "--url", server.url])) as { bot: { id: string } }).bot.id;
    expect(await api("GET", `/api/slack/bots/${botId}`)).toMatchObject({ state: "not_linked" });
    const provisioned = await api("POST", `/api/slack/bots/${botId}/provision`);
    expect(provisioned.status.state).toBe("provisioned");
    appId = provisioned.status.appId;
    const app = fake.apps.get(appId)!;
    expect(app.manifest).toMatchObject({ display_information: { name: "Nova" }, settings: { socket_mode_enabled: true } });
    const authorize = new URL(provisioned.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe("https://slack.com/oauth/v2/authorize");
    const state = authorize.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    await api("POST", "/api/slack/oauth", { code: fake.mintCode(appId), state: "0".repeat(64) }, 400);
    const installed = await api("POST", "/api/slack/oauth", { code: fake.mintCode(appId), state });
    expect(installed.status).toMatchObject({ state: "installed", teamName: "Fake Team", appTokenUrl: `https://api.slack.com/apps/${appId}/general` });
    botUser = installed.status.botUserId;
    await api("POST", "/api/slack/oauth", { code: fake.mintCode(appId), state }, 400);

    await api("POST", `/api/slack/bots/${botId}/app-token`, { token: "not-an-app-token" }, 400);
    const online = await api("POST", `/api/slack/bots/${botId}/app-token`, { token: fake.mintAppToken(appId) });
    expect(online.status).toMatchObject({ state: "online", handle: "Nova" });
    expect(online.status.openUrl).toMatch(/^https:\/\/slack\.com\/app_redirect\?/);
    expect((await api("GET", "/api/slack/workspace")).apps).toBe(1);
  }, 60_000);

  it("answers a DM in its thread, with the eyes reaction while it works, and ignores a redelivery", async () => {
    const event = { type: "message", channel_type: "im", channel: "D0ALICE", user: "U0ALICE", text: "Hello *there*", ts: "1700000001.000100" };
    const envelope = fake.socket.event(appId, event);
    expect((await fake.socket.waitForAck(envelope)).ms).toBeLessThan(3_000);
    await fake.waitForReaction((one) => one.op === "add" && one.name === "eyes" && one.timestamp === event.ts, 15_000);
    const post = await fake.waitForPost((one) => one.channel === "D0ALICE" && one.thread_ts === event.ts, 60_000);
    expect(post.text).toBe(SLACK_REPLY);
    await fake.waitForReaction((one) => one.op === "remove" && one.name === "eyes" && one.timestamp === event.ts, 15_000);

    const threadId = await thread("Slack · @Alice");
    expect(threadId).toBeTruthy();
    // a Slack conversation asks before acting, whatever the bot's own default: people there are not this app's people
    expect((await tasks()).find((task) => task.threadId === threadId)).toMatchObject({ approvalMode: "ask" });
    const line = (await messages(threadId!)).find((message) => message.role === "user");
    expect(line).toMatchObject({ relayed: true, sender: { name: "Alice" } });
    expect(line.text).toContain("Hello *there*");

    const posts = fake.posted.length;
    await fake.socket.waitForAck(fake.socket.event(appId, event, { retryAttempt: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(fake.posted.length).toBe(posts);
    expect((await messages(threadId!)).filter((message) => message.role === "user")).toHaveLength(1);
  }, 90_000);

  it("maps a channel mention to its own conversation and replies in the Slack thread", async () => {
    const event = { type: "app_mention", channel: "C0GENERAL", user: "U0BOB", text: `<@${botUser}> what's new?`, ts: "1700000002.000100" };
    fake.socket.event(appId, event);
    const post = await fake.waitForPost((one) => one.channel === "C0GENERAL" && one.thread_ts === event.ts, 60_000);
    expect(post.text).toBe(SLACK_REPLY);
    const threadId = await thread("Slack · #general");
    expect(threadId).toBeTruthy();
    const line = (await messages(threadId!)).find((message) => message.role === "user");
    expect(line.text).toContain("what's new?");
    expect(line.text).not.toContain(botUser);
  }, 90_000);

  it("brings a file in as an attachment and maps a reaction on its reply", async () => {
    const file = fake.addFile({ name: "dot.png", mime: "image/png", bytes: PNG });
    const event = { type: "message", channel_type: "im", channel: "D0ALICE", user: "U0ALICE", text: "look at this", ts: "1700000003.000100", subtype: "file_share", files: [file] };
    fake.socket.event(appId, event);
    const post = await fake.waitForPost((one) => one.channel === "D0ALICE" && one.thread_ts === event.ts, 60_000);
    expect(fake.downloads.some((download) => download.fileId === file.id)).toBe(true);
    const threadId = (await thread("Slack · @Alice"))!;
    const line = (await messages(threadId)).filter((message) => message.role === "user").at(-1);
    expect(line.text).toMatch(/<attached-image path="[^"]+" name="dot.png" \/>/);

    fake.socket.event(appId, { type: "reaction_added", user: "U0ALICE", reaction: "+1", item_user: botUser, item: { type: "message", channel: "D0ALICE", ts: post.ts } });
    await expect.poll(async () => (await messages(threadId)).some((message) => message.role === "bot" && message.reactions?.some((one: any) => one.emoji === "👍")), { timeout: 15_000 }).toBe(true);
  }, 90_000);

  it("uses its slack_* tools in a turn and sends a file out into the thread", async () => {
    const dump = JSON.parse(readFileSync(join(server.dataDir, "fake-claude-dump.json"), "utf8")) as { cwd: string; env: Record<string, string>; mcpConfig: any };
    const agents = dump.mcpConfig?.mcpServers?.agents;
    expect(agents?.env?.MADANI_SLACK).toBe("1");
    writeFileSync(join(dump.cwd, "report.txt"), "quarterly numbers");
    writeFileSync(callsFile(), JSON.stringify([
      { name: "slack_post", server: "agents", input: { channel: "#general", text: "**Morning**, team" } },
      { name: "slack_read", server: "agents", input: { channel: "C0GENERAL", limit: 5 } },
      { name: "slack_react", server: "agents", input: { channel: "C0GENERAL", ts: "1700000002.000100", emoji: ":tada:" } },
      { name: "slack_upload", server: "agents", input: { path: join(dump.cwd, "report.txt"), channel: "C0GENERAL", thread_ts: "1700000002.000100" } },
      { name: "attach_file", server: "agents", input: { path: join(dump.cwd, "report.txt") } },
    ]));
    try {
      const event = { type: "message", channel_type: "im", channel: "D0ALICE", user: "U0ALICE", text: "post the morning note", ts: "1700000004.000100" };
      fake.socket.event(appId, event);
      await fake.waitForPost((one) => one.channel === "D0ALICE" && one.thread_ts === event.ts, 90_000);
      expect(fake.posted.some((one) => one.channel === "C0GENERAL" && one.text === "*Morning*, team" && !one.thread_ts)).toBe(true);
      expect(fake.reactions.some((one) => one.op === "add" && one.name === "tada" && one.timestamp === "1700000002.000100")).toBe(true);
      expect(fake.completed.some((one: any) => one.channel_id === "C0GENERAL" && one.thread_ts === "1700000002.000100")).toBe(true);
      await expect.poll(() => fake.completed.some((one: any) => one.channel_id === "D0ALICE" && one.thread_ts === event.ts), { timeout: 15_000 }).toBe(true);
      expect(fake.uploads.every((upload) => upload.authorization === null)).toBe(true);
      expect(fake.uploads.some((upload) => upload.bytes.toString() === "quarterly numbers")).toBe(true);
    } finally {
      rmSync(callsFile(), { force: true });
    }
  }, 120_000);

  it("goes offline when Slack drops the socket and comes back", async () => {
    fake.socket.drop(appId);
    await expect.poll(async () => (await api("GET", `/api/slack/bots/${botId}`)).state, { timeout: 10_000 }).toBe("offline");
    await fake.socket.waitForConnection(appId, 20_000);
    await expect.poll(async () => (await api("GET", `/api/slack/bots/${botId}`)).state, { timeout: 20_000 }).toBe("online");
  }, 60_000);

  it("keeps every token out of logs, transcripts and the engine", async () => {
    const values = [...secrets(), ...fake.calls.map((call) => call.token).filter((token): token is string => Boolean(token))];
    const unique = [...new Set(values)].filter((value) => value.length >= 12);
    expect(unique.length).toBeGreaterThan(4);
    const log = readFileSync(server.logPath, "utf8");
    const dump = readFileSync(join(server.dataDir, "fake-claude-dump.json"), "utf8");
    // every file the server wrote, databases included, but the encrypted store that holds the tokens
    const transcripts = readdirSync(server.dataDir, { recursive: true }).map(String)
      .filter((name) => !name.startsWith("slack-secrets.json.enc") && name !== "fake-claude-dump.json")
      .map((name) => { try { const path = join(server.dataDir, name); return statSync(path).isFile() && statSync(path).size < 50_000_000 ? readFileSync(path, "latin1") : ""; } catch { return ""; } }).join("\n");
    for (const value of unique) {
      expect(log.includes(value), "server log").toBe(false);
      expect(dump.includes(value), "engine launch").toBe(false);
      expect(transcripts.includes(value), "data folder").toBe(false);
    }
  });

  it("removes the bot from Slack: the app is deleted and the token revoked", async () => {
    const removed = await api("DELETE", `/api/slack/bots/${botId}`);
    expect(removed.state).toBe("not_linked");
    expect(fake.apps.has(appId)).toBe(false);
    expect(fake.callsTo("auth.revoke")).toHaveLength(1);
  }, 30_000);
});
