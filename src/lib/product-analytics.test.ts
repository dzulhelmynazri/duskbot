// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_FEATURES as SERVER_FEATURES, cleanProps } from "../../apps/dashboard/server/analytics/events";

type Client = typeof import("./product-analytics");
type Payload = { install: string; session: string; platform: string; version: string; events: { name: string; at: number; props: Record<string, string | number | boolean> }[] };
let client: Client;
const fetcher = vi.fn<typeof fetch>();
const config = { origin: "https://accounts.example", token: null, platform: "darwin", version: "1.2.3", kind: "desktop", force: true } as const;
const watchWindow = () => vi.spyOn(window, "addEventListener");
const watchDocument = () => vi.spyOn(document, "addEventListener");
let windowEvents: ReturnType<typeof watchWindow>;
let documentEvents: ReturnType<typeof watchDocument>;
const bodies = (): Payload[] => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Payload);
/** the env signal every app start sends is checked on its own; the other tests read around it */
const isEnv = (event: { name: string; props?: Record<string, unknown> }) => event.name === "app_action" && event.props?.name === "env";
const events = () => bodies().flatMap(body => body.events).filter(event => !isEnv(event));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.resetModules();
  // a new desktop install: the switch has never been touched, which counts as on
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  fetcher.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  windowEvents = watchWindow();
  documentEvents = watchDocument();
  client = await import("./product-analytics");
});

afterEach(() => {
  for (const [name, handler, options] of windowEvents.mock.calls) window.removeEventListener(name, handler as EventListener, options);
  for (const [name, handler, options] of documentEvents.mock.calls) document.removeEventListener(name, handler as EventListener, options);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("product analytics", () => {
  it("on a new desktop install sends without being asked, and off stops everything at once", async () => {
    const relay = { send: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    client.configure({ ...config, origin: null, relay });
    expect(client.usageAnalyticsEnabled(), "not set counts as on").toBe(true);
    client.feature("bot_created");
    await client.flush();
    expect(relay.send).toHaveBeenCalledTimes(1);

    client.setUsageAnalytics(false);
    expect(relay.clear, "what main still holds goes too").toHaveBeenCalled();
    client.feature("bot_created");
    client.action("reply_reaction", { emoji: "love" });
    client.screen("/bots/123");
    client.messageSent();
    client.replyReceived(10);
    await client.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event("pagehide"));
    await client.flush();
    expect(client.usageAnalyticsEnabled()).toBe(false);
    expect(relay.send, "nothing after off").toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("switching usage sharing off sends that one event once, then nothing at all", async () => {
    client.configure(config);
    client.feature("bot_created");
    client.usageSharingChanged(false, "settings");
    await vi.advanceTimersByTimeAsync(0);
    expect(events(), "the queued event is dropped; only the off event goes").toEqual([{ name: "app_action", at: 1_800_000_000_000, props: { name: "usage_sharing", on: false, where: "settings" } }]);
    const sends = fetcher.mock.calls.length;
    client.feature("bot_created");
    client.action("usage_sharing", { on: false, where: "settings" });
    client.screen("/bots");
    client.messageSent();
    await client.flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    window.dispatchEvent(new Event("pagehide"));
    await client.flush();
    client.usageSharingChanged(false, "settings");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls.length, "nothing after the off event, not even a second off").toBe(sends);
  });

  it("the off event goes through the desktop relay's one-shot path and switching back on counts where", async () => {
    const relay = { send: vi.fn(async (_batch: Payload) => {}), clear: vi.fn(async () => {}), last: vi.fn(async (_batch: Payload) => true) };
    client.configure({ ...config, origin: null, relay });
    await client.flush();
    relay.send.mockClear();
    client.usageSharingChanged(false, "first_run");
    expect(relay.clear).toHaveBeenCalled();
    expect(relay.last).toHaveBeenCalledTimes(1);
    expect(relay.last.mock.calls[0]![0]).toMatchObject({ events: [{ name: "app_action", props: { name: "usage_sharing", on: false, where: "first_run" } }] });
    await client.flush();
    expect(relay.send).not.toHaveBeenCalled();
    client.usageSharingChanged(true, "first_run");
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.send.mock.calls.flatMap(([batch]) => batch.events).map(event => event.props)).toContainEqual({ name: "usage_sharing", on: true, where: "first_run" });
  });

  it("the phone app sends nothing unless its switch was turned on", async () => {
    client.configure({ ...config, kind: "mobile" });
    client.feature("bot_created");
    client.messageSent();
    await client.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.usageAnalyticsEnabled()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(localStorage.getItem("madani-install-id")).toBeNull();
  });

  it("keeps only valid action extras, counts eight valid extras and requires a word name", async () => {
    client.configure(config);
    client.action("reply_reaction", {
      name: "overridden", "bad-key": "yes", bad_value: "private words", url: "https://private.example", upper: "UPPER",
      emoji: "love", on: true, off: false, count: 0, limit: 1e12 - 1, code: "word_123", kind: "reply", ms: 12,
      ninth: "dropped", nested: { private: true },
    });
    client.action("counts", { negative: -1, decimal: 1.5, infinite: Infinity, nan: NaN, unsafe: Number.MAX_SAFE_INTEGER + 1,
      huge: 1e12 + 1, nil: null, absent: undefined, list: [], "key1": "bad", ["k".repeat(21)]: "bad", ["k".repeat(20)]: "a".repeat(40), long: "a".repeat(41) });
    for (const name of ["", "UPPER", "private words", "https://private.example", "a".repeat(41)]) client.action(name, { on: true });
    client.track("app_action", { on: true });
    await client.flush();
    expect(events().filter(event => event.name === "app_action").map(event => event.props)).toEqual([
      { name: "reply_reaction", emoji: "love", on: true, off: false, count: 0, limit: 1e12 - 1, code: "word_123", kind: "reply", ms: 12 },
      { name: "counts", ["k".repeat(20)]: "a".repeat(40) },
    ]);
  });

  it("accepts only integer feedback scores from one to five and a word moment", async () => {
    client.configure(config);
    for (const score of [1, 2, 3, 4, 5]) client.feedback(score, "after_reply");
    for (const score of [0, 6, -1, 2.5, NaN, Infinity]) client.feedback(score, "after_reply");
    for (const moment of ["", "UPPER", "private words", "https://private.example", "a".repeat(41)]) client.feedback(3, moment);
    client.track("app_feedback", { score: "5", moment: "after_reply" });
    client.track("app_feedback", { score: true, moment: "after_reply" });
    client.track("app_feedback", { score: 4, moment: "settings", text: "private words" });
    await client.flush();
    expect(events().filter(event => event.name === "app_feedback").map(event => event.props)).toEqual([
      ...[1, 2, 3, 4, 5].map(score => ({ score, moment: "after_reply" })), { score: 4, moment: "settings" },
    ]);
  });

  it("forwards legacy tracking through action cleaning and counts team imports", async () => {
    const analytics = await import("./analytics");
    client.configure(config);
    analytics.track("cloud_card_action", { action: "signin", queued: false, text: "private words" });
    analytics.track("team_imported", { members: 3, source: "organization" });
    analytics.track("cloud_setup_started");
    await client.flush();
    expect(events().slice(1).map(({ name, props }) => ({ name, props }))).toEqual([
      { name: "app_action", props: { name: "cloud_card_action", action: "signin", queued: false } },
      { name: "app_action", props: { name: "team_imported", members: 3, source: "organization" } },
      { name: "app_feature", props: { feature: "team_imported" } },
      { name: "app_action", props: { name: "cloud_setup_started" } },
    ]);
    analytics.setEmailGateDone("skipped");
    expect(analytics.emailGateDone()).toBe(true);
    client.setUsageAnalytics(false);
    analytics.track("team_imported", { members: 5 });
    client.feedback(5, "settings");
    await client.flush();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("counts a started call while keeping its instance id local", async () => {
    const { callStarted } = await import("./product-events");
    client.configure(config);
    callStarted([{ instanceId: "private_instance_id", driverKind: "codex" }], "private_instance_id", "live");
    await client.flush();
    expect(events().slice(1).map(({ name, props }) => ({ name, props }))).toEqual([
      { name: "app_feature", props: { feature: "call_started" } },
      { name: "app_action", props: { name: "call_started", driver: "codex", mode: "live" } },
    ]);
  });

  it("counts config saves once after success without sending their contents", async () => {
    const { api } = await import("@/state/api");
    client.configure(config);
    await api("/api/config");
    await api("/api/config", { method: "PUT", body: JSON.stringify({ computerName: "private name" }) });
    await api("/api/config", { method: "PATCH", body: JSON.stringify({ profile: { aboutMe: "private text" } }) });
    fetcher.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    await expect(api("/api/config", { method: "PUT", body: "{}" })).rejects.toThrow();
    await api("/api/bots/example", { method: "PATCH", body: "{}" });
    fetcher.mockClear();
    await client.flush();
    expect(events().filter(event => event.name === "app_feature").map(event => event.props)).toEqual([
      { feature: "settings_changed" }, { feature: "settings_changed" },
    ]);
    expect(JSON.stringify(bodies())).not.toContain("private");
  });

  it("persists a random install id and makes a fresh session for each launch", async () => {
    client.configure(config);
    await client.flush();
    const first = bodies()[0];
    expect(first.install).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.session).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(localStorage.getItem("madani-install-id")).toBe(first.install);
    vi.resetModules();
    const next = await import("./product-analytics");
    next.configure(config);
    await next.flush();
    expect(bodies()[1].install).toBe(first.install);
    expect(bodies()[1].session).not.toBe(first.session);
  });

  it("hands batches to the desktop's main process instead of posting, and clears it on opt-out", async () => {
    const relay = { send: vi.fn(async () => true), clear: vi.fn(async () => undefined) };
    client.configure({ ...config, origin: null, relay });
    client.feature("bot_created");
    await client.flush();
    expect(fetcher).not.toHaveBeenCalled();
    const [batch] = relay.send.mock.calls[0] as unknown as [Payload];
    expect(batch.install).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(batch.events.filter(event => !isEnv(event)).map(event => event.name)).toEqual(["app_open", "app_feature"]);
    expect(batch).not.toHaveProperty("token");
    client.setUsageAnalytics(false);
    expect(relay.clear).toHaveBeenCalledOnce();
  });

  it("keeps a batch the main process refused for one more try", async () => {
    const relay = { send: vi.fn().mockRejectedValueOnce(new Error("not local")).mockResolvedValue(true), clear: vi.fn(async () => undefined) };
    client.configure({ ...config, origin: null, relay });
    await client.flush();
    await client.flush();
    expect(relay.send).toHaveBeenCalledTimes(2);
    expect((relay.send.mock.calls[1] as unknown as [Payload])[0].events.filter(event => !isEnv(event)).map(event => event.name)).toEqual(["app_open"]);
  });

  it("replaces a malformed persisted install id", async () => {
    localStorage.setItem("madani-install-id", "person@example.com");
    client.configure(config);
    await client.flush();
    expect(bodies()[0].install).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("queues before the origin is known and opens only once", async () => {
    client.configure({ ...config, origin: null });
    client.feature("bot_created");
    await client.flush();
    expect(fetcher).not.toHaveBeenCalled();
    client.configure(config);
    client.configure({ ...config, token: "omc_fixture" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events().map(event => event.name)).toEqual(["app_feature", "app_open"]);
  });

  it("sends batches of at most 50", async () => {
    client.configure(config);
    for (let i = 0; i < 121; ++i) client.feature("search_used");
    await client.flush();
    expect(bodies().map(body => body.events.length)).toEqual([50, 50, 23]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("sends the env signal once per start with only its catalogue's words and numbers", async () => {
    client.configure(config);
    await client.flush();
    const env = bodies().flatMap(body => body.events).filter(isEnv);
    expect(env).toHaveLength(1);
    expect(Object.keys(env[0]!.props).sort()).toEqual(["arch", "hour", "locale", "name", "notifications", "os", "screen", "skin", "theme"]);
    for (const value of Object.values(env[0]!.props)) expect(typeof value === "number" || /^[a-z0-9_]{1,32}$/.test(String(value))).toBe(true);
  });

  it("drops the oldest events beyond the 200 event bound", async () => {
    client.configure({ ...config, origin: null });
    for (let i = 0; i < 205; ++i) client.error("test", `event_${i}`);
    client.configure(config);
    await client.flush();
    // 200 kept: the newest errors, app_open and the env signal (left out of events())
    expect(events()).toHaveLength(199);
    expect(events()[0].props.code).toBe("event_7");
  });

  it("folds ids, removes query strings and dedupes consecutive folded screens", async () => {
    client.configure(config);
    for (const id of ["123", "a1b", "abcdefghijklmnopqrstuvwxyz", "ws_letters", "acct_letters", "bot_letters", "cface"]) client.screen(`/bots/${id}?q=private#private`);
    client.screen("/rooms/987");
    client.screen("/bots/456");
    client.screen("https://person.example/private");
    client.screen("//person.example/private");
    client.screen("/%invalid");
    client.screen("/calls");
    await client.flush();
    expect(events().filter(event => event.name === "app_screen").map(event => event.props.screen)).toEqual(["/bots/:id", "/rooms/:id", "/bots/:id", "/calls"]);
  });

  it("aggregates counts and rounds the median reply latency", async () => {
    client.configure(config);
    for (let i = 0; i < 5; ++i) client.messageSent();
    for (const ms of [901, 101, 301, 201]) client.replyReceived(ms);
    client.replyReceived(NaN);
    client.replyReceived(-1);
    await client.flush();
    expect(events().filter(event => event.name === "app_messages")).toEqual([{ name: "app_messages", at: Date.now(), props: { sent: 5, replies: 4, latencyMs: 251 } }]);
    await client.flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.replyReceived(12.7);
    await client.flush();
    expect(events().at(-1)?.props).toEqual({ sent: 0, replies: 1, latencyMs: 13 });
  });

  it("measures only matched messages and uses the first streamed reply once", async () => {
    client.configure(config);
    client.noteMessageSent("send-a");
    client.noteMessageSent("send-a");
    client.noteAcceptedMessage("send-a", "message-a");
    vi.setSystemTime(Date.now() + 120);
    client.noteReplyTurn("turn-a");
    vi.setSystemTime(Date.now() + 800);
    client.noteReplyTurn("turn-a", "message-a");
    client.noteReplyTurn("turn-a", "message-a");
    client.noteReplyTurn("unrelated", "another-message");
    await client.flush();
    expect(events().at(-1)?.props).toEqual({ sent: 1, replies: 1, latencyMs: 120 });
  });

  it("clears queued events and aggregates on opt-out and blocks further tracking", async () => {
    client.configure(config);
    client.messageSent();
    client.feature("bot_created");
    client.setUsageAnalytics(false);
    expect(localStorage.getItem("madani-usage-analytics")).toBe("off");
    expect(client.usageAnalyticsEnabled()).toBe(false);
    client.feature("room_created");
    client.replyReceived(100);
    window.dispatchEvent(new Event("pagehide"));
    await client.flush();
    expect(fetcher).not.toHaveBeenCalled();
    client.setUsageAnalytics(true);
    client.feature("search_used");
    await client.flush();
    expect(events().map(event => event.name)).toEqual(["app_feature"]);
  });

  it("honors persisted opt-out and disables tests unless forced", async () => {
    client.configure({ ...config, force: false });
    client.feature("bot_created");
    await client.flush();
    expect(fetcher).not.toHaveBeenCalled();
    localStorage.setItem("madani-usage-analytics", "off");
    client.configure(config);
    await client.flush();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("adds a bearer header only while the configured token is set", async () => {
    client.configure(config);
    await client.flush();
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ "content-type": "application/json" });
    client.configure({ ...config, token: "omc_fixture" });
    client.feature("search_used");
    await client.flush();
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer omc_fixture" });
    client.configure(config);
    client.feature("chat_opened");
    await client.flush();
    expect(fetcher.mock.calls[2][1]?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(bodies())).not.toContain("omc_fixture");
  });

  it("sends the keepalive contract on hidden and closes on pagehide", async () => {
    client.configure(config);
    vi.setSystemTime(Date.now() + 1234);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(fetcher.mock.calls[0][0]).toBe("https://accounts.example/v1/app/events");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", keepalive: true, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(Object.keys(bodies()[0]).sort()).toEqual(["events", "install", "platform", "session", "version"]);
    expect(bodies()[0]).toMatchObject({ platform: "darwin", version: "1.2.3" });
    expect(events().filter(event => event.name === "app_close")).toEqual([{ name: "app_close", at: Date.now(), props: { ms: 1234 } }]);
    expect(events()[0]).toMatchObject({ name: "app_open", props: { kind: "desktop", platform: "darwin", appVersion: "1.2.3" } });
  });

  it("never throws when fetch rejects and retries only on the next flush", async () => {
    fetcher.mockRejectedValue(new Error("private network details"));
    client.configure(config);
    await expect(client.flush()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not restore an in-flight failed batch after opting out and back in", async () => {
    let reject!: (cause: Error) => void;
    fetcher.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    client.configure(config);
    const sending = client.flush();
    client.setUsageAnalytics(false);
    client.setUsageAnalytics(true);
    reject(new Error("offline"));
    await sending;
    await client.flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports window failures without their messages or stacks and drops extra props", async () => {
    client.configure(config);
    window.dispatchEvent(new ErrorEvent("error", { message: "private message", error: new Error("private stack") }));
    window.dispatchEvent(new Event("unhandledrejection"));
    client.track("app_feature", { feature: "file_uploaded", fileName: "secret.txt", email: "person@example.com", token: "private" });
    client.track("unknown", { text: "private prompt" });
    client.error("private message", "bad-code");
    client.feature("unknown" as "bot_created");
    await client.flush();
    expect(events().map(event => event.props)).toEqual([
      { kind: "desktop", platform: "darwin", appVersion: "1.2.3" },
      { kind: "window", code: "error" }, { kind: "window", code: "rejection" }, { feature: "file_uploaded" },
    ]);
    expect(JSON.stringify(bodies())).not.toMatch(/private|secret|person@example/);
  });

  it("counts observed routine runs once and ignores runs still queued or missed", async () => {
    client.configure(config);
    client.noteRoutineRun("run-a", "queued");
    client.noteRoutineRun("run-a", "running");
    client.noteRoutineRun("run-a", "completed");
    client.noteRoutineRun("run-b", "missed");
    await client.flush();
    expect(events().filter(event => event.name === "app_feature")).toHaveLength(1);
  });

  it("reports only final pairing failures with a coarse code", async () => {
    client.configure(config);
    await expect(client.observePairing(async () => "ok")).resolves.toBe("ok");
    const refused = { code: "expired", message: "private pairing code" };
    await expect(client.observePairing(async () => { throw refused; })).rejects.toBe(refused);
    await client.flush();
    expect(events().filter(event => event.name === "app_pair_failed")).toEqual([{ name: "app_pair_failed", at: Date.now(), props: { reason: "expired_code" } }]);
  });

  it("without storage is on for the desktop app, and off sticks for the session", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    client.configure(config);
    client.feature("bot_created");
    await expect(client.flush()).resolves.toBeUndefined();
    expect(bodies()[0].install).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const sent = fetcher.mock.calls.length;
    client.setUsageAnalytics(false);
    client.feature("bot_created");
    await client.flush();
    expect(client.usageAnalyticsEnabled()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(sent);
  });


  it("says which API route a refused request went to, with every id folded and the server keeping it", async () => {
    client.configure(config);
    client.requestRefused(409, { error: "This bot is busy." }, "http://127.0.0.1:8799/api/bots/26b45283-a96f-49c7-81d0-be937b384e29/messages?x=private");
    client.requestRefused(403, { error: "forbidden" }, "https://relay.example/w/ws_abcdefgh123/api/presence/active");
    client.requestRefused(409, {}, "");
    client.requestRefused(404, {}, "http://127.0.0.1/api/bots");
    await client.flush();
    const refused = events().map(event => event.props);
    expect(refused).toEqual([
      { kind: "desktop", platform: "darwin", appVersion: "1.2.3" },
      { name: "refused", by: "request", status: 409, code: "none", route: "bots_id_messages" },
      { name: "refused", by: "request", status: 403, code: "forbidden", route: "presence_active" },
      { name: "refused", by: "request", status: 409, code: "none" },
    ]);
    for (const event of events()) expect(cleanProps(event.name as Parameters<typeof cleanProps>[0], event.props)).toEqual(event.props);
    expect(JSON.stringify(bodies())).not.toMatch(/26b45283|private|ws_abc/);
  });

  it("keeps the feature catalog and event properties compatible with the server", async () => {
    expect(client.APP_FEATURES).toEqual(SERVER_FEATURES);
    client.configure(config);
    client.screen("/bots/123");
    client.feature("bot_created");
    client.error("window", "error");
    client.pairFailed("expired_code");
    client.action("reply_reaction", { emoji: "yes", on: true, count: 1e12 - 1 });
    client.feedback(5, "after_reply");
    client.messageSent();
    client.replyReceived(123);
    await client.flush();
    for (const event of events()) expect(cleanProps(event.name as Parameters<typeof cleanProps>[0], event.props)).toEqual(event.props);
  });
});
