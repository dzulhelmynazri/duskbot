import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createSlackApi, SlackApiError } from "./api.ts";
import { createSlackSocket, createSlackSockets, type SlackSocketDeps } from "./socket.ts";
import { startFakeSlack, type FakeSlack } from "../testing/fake-slack.ts";

function timers() {
  const entries: Array<{ ms: number; active: boolean; fire(): void; cancel(): void; callback(): void }> = [];
  return {
    entries,
    pending: () => entries.filter((entry) => entry.active),
    setTimer(callback: () => void, ms: number) {
      const entry = { ms, active: true, callback,
        fire() { if (entry.active) { entry.active = false; callback(); } },
        cancel() { entry.active = false; } };
      entries.push(entry);
      return entry;
    },
    fire(ms: number) {
      const entry = entries.find((entry) => entry.active && entry.ms === ms);
      expect(entry, `pending timer for ${ms} ms`).toBeDefined();
      entry!.fire();
    },
  };
}

let fake: FakeSlack;
let api: ReturnType<typeof createSlackApi>;
let appId: string;
let token: string;
let clock: ReturnType<typeof timers>;
let instances: WebSocket[];
let options: unknown[];
let deps: SlackSocketDeps;
let socket: ReturnType<typeof createSlackSocket>;
let managers: ReturnType<typeof createSlackSockets>[];
const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 2000, interval: 5 });

beforeEach(async () => {
  fake = await startFakeSlack();
  api = createSlackApi({ env: { MADANI_SLACK_API_URL: fake.url }, minGapMs: 0 });
  const app = await api.call<{ app_id: string }>("apps.manifest.create", fake.config.access, {
    manifest: { settings: { socket_mode_enabled: true } },
  });
  appId = app.app_id;
  token = fake.mintAppToken(appId);
  clock = timers();
  instances = [];
  options = [];
  managers = [];
  deps = {
    api, appToken: () => token, onEvent: vi.fn(), onState: vi.fn(), log: vi.fn(), random: () => 0.5,
    setTimer: clock.setTimer,
    WebSocketImpl: new Proxy(WebSocket, {
      construct(target, args) {
        options.push(args[1]);
        const ws = Reflect.construct(target, args) as WebSocket;
        instances.push(ws);
        return ws;
      },
    }),
  };
  socket = createSlackSocket(deps);
});

afterEach(async () => {
  socket.stop();
  for (const manager of managers) manager.stopAll();
  await fake.close();
  vi.restoreAllMocks();
});

async function online() {
  socket.start();
  await fake.socket.waitForConnections(appId, 1);
  await until(() => socket.state() === "online");
  return instances.at(-1)!;
}

describe("Slack Socket Mode", () => {
  it("stays offline without an app token", () => {
    deps.appToken = () => null;
    socket.start();
    expect(socket.state()).toBe("offline");
    expect(fake.callsTo("apps.connections.open")).toHaveLength(0);
    expect(instances).toHaveLength(0);
    expect(clock.pending()).toHaveLength(0);
  });

  it("connects once, waits for hello and acknowledges before calling the event handler", async () => {
    const ws = await online();
    socket.start();
    expect(deps.onState).toHaveBeenNthCalledWith(1, "connecting", undefined);
    expect(deps.onState).toHaveBeenLastCalledWith("online", undefined);
    expect(instances).toHaveLength(1);
    expect(options).toEqual([{ handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 }]);
    const send = vi.spyOn(ws, "send");
    let resolveEvent!: () => void;
    const eventPending = new Promise<void>((resolve) => { resolveEvent = resolve; });
    deps.onEvent = vi.fn((_payload, meta) => {
      expect(send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: meta.envelopeId }), expect.any(Function));
      return eventPending;
    });
    const event = { type: "message", text: "hello", channel: "D0TEST" };
    const id = fake.socket.event(appId, event, { retryAttempt: 2 });
    expect((await fake.socket.waitForAck(id)).ms).toBeLessThan(500);
    expect(deps.onEvent).toHaveBeenCalledWith(expect.objectContaining({ event, api_app_id: appId }), {
      envelopeId: id, type: "events_api", retryAttempt: 2,
    });
    resolveEvent();
  });

  it.each(["throw", "reject"])("keeps acking when onEvent will %s", async (mode) => {
    await online();
    deps.onEvent = vi.fn(() => {
      if (mode === "throw") throw new Error(token);
      return Promise.reject(new Error(token));
    });
    for (let i = 0; i < 2; i++) {
      const id = fake.socket.event(appId, { type: "message", text: String(i) });
      expect((await fake.socket.waitForAck(id)).ms).toBeLessThan(500);
    }
    expect(deps.onEvent).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenLastCalledWith("Slack event handling failed.");
    expect(socket.state()).toBe("online");
  });

  it("acks a repeated envelope twice and delivers it only once, including across reconnects", async () => {
    await online();
    const id = fake.socket.event(appId, { type: "message" });
    await fake.socket.waitForAck(id);
    fake.socket.event(appId, { type: "message" }, { envelopeId: id, retryAttempt: 1 });
    await until(() => fake.socket.acks.filter((ack) => ack.envelopeId === id).length === 2);
    expect(deps.onEvent).toHaveBeenCalledTimes(1);
    fake.socket.disconnect(appId, "refresh_requested");
    await until(() => instances.length === 2 && socket.state() === "online");
    fake.socket.event(appId, { type: "message" }, { envelopeId: id, retryAttempt: 2 });
    await until(() => fake.socket.acks.filter((ack) => ack.envelopeId === id).length === 3);
    expect(deps.onEvent).toHaveBeenCalledTimes(1);
  });

  it("bounds deduplication to the last 500 envelope ids", async () => {
    await online();
    for (let i = 0; i <= 500; i++) fake.socket.event(appId, { type: "message" }, { envelopeId: `envelope-${i}` });
    await until(() => fake.socket.acks.length === 501);
    fake.socket.event(appId, { type: "message" }, { envelopeId: "envelope-0" });
    await until(() => fake.socket.acks.length === 502);
    expect(deps.onEvent).toHaveBeenCalledTimes(502);
  });

  it.each(["refresh_requested", "warning"])("replaces the connection immediately on %s", async (reason) => {
    const old = await online();
    fake.socket.disconnect(appId, reason);
    await until(() => instances.length === 2 && socket.state() === "online");
    await fake.socket.waitForConnections(appId, 1);
    expect(old.readyState).toBe(WebSocket.CLOSED);
    expect(instances[1].url).not.toBe(old.url);
    expect(fake.callsTo("apps.connections.open")).toHaveLength(2);
    expect(fake.socket.connections(appId)).toBe(1);
    expect(clock.pending().map((entry) => entry.ms).sort()).toEqual([30_000, 60_000]);
  });

  it("stops with an error when Socket Mode is disabled", async () => {
    await online();
    fake.socket.disconnect(appId, "link_disabled");
    await until(() => socket.state() === "error" && fake.socket.connections(appId) === 0);
    expect(deps.onState).toHaveBeenLastCalledWith("error", "Socket Mode is off for this app.");
    expect(clock.pending()).toHaveLength(0);
    expect(fake.callsTo("apps.connections.open")).toHaveLength(1);
  });

  it("goes offline after a drop, retries once and resets backoff after 60 seconds online", async () => {
    await online();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const count = instances.length;
      fake.socket.drop(appId);
      await until(() => socket.state() === "offline");
      expect(clock.pending().map((entry) => entry.ms)).toEqual([delay]);
      expect(instances).toHaveLength(count);
      clock.fire(delay);
      await until(() => instances.length === count + 1 && socket.state() === "online");
    }
    clock.fire(60_000);
    fake.socket.drop(appId);
    await until(() => socket.state() === "offline");
    expect(clock.pending().map((entry) => entry.ms)).toEqual([1000]);
  });

  it.each([0, 1])("applies jitter with random=%s and supports short backoff dependencies", async (random) => {
    deps.random = () => random;
    deps.backoffBaseMs = 10;
    deps.backoffMaxMs = 15;
    socket = createSlackSocket(deps);
    await online();
    for (const base of [10, 15]) {
      fake.socket.drop(appId);
      await until(() => socket.state() === "offline");
      const delay = base * (0.8 + random * 0.4);
      expect(clock.pending().map((entry) => entry.ms)).toEqual([delay]);
      clock.fire(delay);
      await until(() => socket.state() === "online");
    }
  });

  it("refuses a revoked app token without retrying", async () => {
    fake.revokeAppToken(token);
    socket.start();
    await until(() => socket.state() === "error");
    expect(deps.onState).toHaveBeenLastCalledWith("error", "Slack refused the app-level token.");
    expect(clock.pending()).toHaveLength(0);
    expect(instances).toHaveLength(0);
    expect(fake.callsTo("apps.connections.open")).toHaveLength(1);
  });

  it.each(["invalid_auth", "not_authed", "token_revoked", "account_inactive"])("does not retry %s", async (code) => {
    fake.fail("apps.connections.open", code);
    socket.start();
    await until(() => socket.state() === "error");
    expect(deps.onState).toHaveBeenLastCalledWith("error", "Slack refused the app-level token.");
    expect(clock.pending()).toHaveLength(0);
  });

  it("retries other API failures with backoff", async () => {
    fake.fail("apps.connections.open", "internal_error");
    socket.start();
    await until(() => clock.pending().some((entry) => entry.ms === 1000));
    expect(socket.state()).toBe("offline");
    clock.fire(1000);
    await until(() => socket.state() === "online");
    expect(fake.callsTo("apps.connections.open")).toHaveLength(2);
  });

  it("never constructs a WebSocket for an unexpected address and retries later", async () => {
    const call = vi.spyOn(api, "call").mockResolvedValue({ url: "wss://evil.example/" });
    socket.start();
    await until(() => socket.state() === "error");
    expect(deps.onState).toHaveBeenLastCalledWith("error", "Slack sent an unexpected connection address.");
    expect(instances).toHaveLength(0);
    expect(clock.pending().map((entry) => entry.ms)).toEqual([1000]);
    clock.fire(1000);
    await until(() => call.mock.calls.length === 2 && socket.state() === "error");
    expect(instances).toHaveLength(0);
  });

  it("pings, accepts pongs and terminates after ten seconds without a pong", async () => {
    const ws = await online();
    const pong = once(ws, "pong");
    clock.fire(30_000);
    await pong;
    expect(clock.pending().some((entry) => entry.ms === 10_000)).toBe(false);
    const ping = vi.spyOn(ws, "ping").mockImplementation(() => {});
    const terminate = vi.spyOn(ws, "terminate");
    clock.fire(30_000);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(socket.state()).toBe("online");
    clock.fire(10_000);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(socket.state()).toBe("offline");
    expect(clock.pending().map((entry) => entry.ms)).toEqual([1000]);
    clock.fire(1000);
    await until(() => instances.length === 2 && socket.state() === "online");
  });

  it("does not extend the pong deadline with a short ping interval", async () => {
    deps.pingIntervalMs = 20;
    socket = createSlackSocket(deps);
    const ws = await online();
    const ping = vi.spyOn(ws, "ping").mockImplementation(() => {});
    clock.fire(20);
    const deadline = clock.pending().find((entry) => entry.ms === 10_000);
    clock.fire(20);
    expect(clock.pending().filter((entry) => entry.ms === 10_000)).toEqual([deadline]);
    expect(ping).toHaveBeenCalledTimes(2);
    clock.fire(10_000);
    expect(socket.state()).toBe("offline");
  });

  it("ignores bad frames and acks interactive and slash command envelopes without dispatching", async () => {
    const ws = await online();
    const send = vi.spyOn(ws, "send");
    for (const frame of ["{", "null", "[]"]) ws.emit("message", Buffer.from(frame));
    for (const type of ["interactive", "slash_commands"]) {
      ws.emit("message", Buffer.from(JSON.stringify({ type, envelope_id: type, payload: {} })));
      expect(send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: type }), expect.any(Function));
    }
    expect(deps.onEvent).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledTimes(3);
    const id = fake.socket.event(appId, { type: "message" });
    await fake.socket.waitForAck(id);
    expect(deps.onEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores late events and timers from replaced sockets", async () => {
    const old = await online();
    const oldTimers = clock.pending();
    fake.socket.disconnect(appId, "refresh_requested");
    await until(() => instances.length === 2 && socket.state() === "online");
    for (const entry of oldTimers) entry.callback();
    for (const type of ["hello", "disconnect", "events_api"]) {
      old.emit("message", Buffer.from(JSON.stringify({ type, payload: {}, ...(type === "events_api" ? { envelope_id: "late" } : {}) })));
    }
    old.emit("error", new Error(token));
    old.emit("close");
    old.emit("pong");
    expect(socket.state()).toBe("online");
    expect(deps.onEvent).not.toHaveBeenCalled();
    expect(fake.callsTo("apps.connections.open")).toHaveLength(2);
    socket.stop();
    expect(clock.pending()).toHaveLength(0);
  });

  it("closes with code 1000 and never reconnects or dispatches after stop", async () => {
    const ws = await online();
    const closed = once(ws, "close");
    socket.stop();
    expect((await closed)[0]).toBe(1000);
    for (const entry of clock.entries) entry.callback();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "events_api", envelope_id: "stopped", payload: {} })));
    ws.emit("error", new Error(token));
    expect(socket.state()).toBe("offline");
    expect(clock.pending()).toHaveLength(0);
    expect(deps.onEvent).not.toHaveBeenCalled();
    expect(fake.callsTo("apps.connections.open")).toHaveLength(1);
  });

  it("cancels pending retries and ignores API responses after stop", async () => {
    let finish!: (value: { url: string }) => void;
    vi.spyOn(api, "call").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    socket.start();
    socket.stop();
    finish({ url: "wss://wss-primary.slack.com/link/?ticket=test-ticket" });
    await Promise.resolve();
    expect(instances).toHaveLength(0);
    expect(clock.pending()).toHaveLength(0);
    vi.restoreAllMocks();
    await online();
    fake.socket.drop(appId);
    await until(() => socket.state() === "offline");
    const retry = clock.pending()[0];
    socket.stop();
    retry.callback();
    expect(clock.pending()).toHaveLength(0);
    expect(fake.callsTo("apps.connections.open")).toHaveLength(1);
  });

  it("logs only fixed sentences even when errors contain a token or connection ticket", async () => {
    const ws = await online();
    const ticket = new URL(ws.url).searchParams.get("ticket")!;
    deps.onEvent = () => { throw new Error(`${token} ${ticket} ${ws.url}`); };
    ws.emit("message", Buffer.from(`${token} ${ticket}`));
    const id = fake.socket.event(appId, { type: "message" });
    await fake.socket.waitForAck(id);
    ws.emit("error", new Error(`${token} ${ticket} ${ws.url}`));
    vi.spyOn(api, "call").mockRejectedValue(new SlackApiError(`${token} ${ticket}`));
    clock.fire(1000);
    await until(() => clock.pending().some((entry) => entry.ms === 2000));
    const lines = vi.mocked(deps.log!).mock.calls.flat();
    expect(lines).toEqual([
      "Slack sent an invalid socket message.", "Slack event handling failed.",
      "Slack socket connection failed.", "Slack socket connection failed.",
    ]);
    expect(lines.join("\n")).not.toContain(token);
    expect(lines.join("\n")).not.toContain(ticket);
    expect(lines.join("\n")).not.toContain(ws.url);
  });

  it("manages one socket per bot and deletes stopped entries", async () => {
    const make = vi.fn(() => deps);
    const manager = createSlackSockets(make);
    managers.push(manager);
    expect(manager.state("one")).toBeNull();
    manager.ensure("one");
    manager.ensure("one");
    await until(() => manager.state("one") === "online");
    expect(make).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    manager.stop("one");
    expect(manager.state("one")).toBeNull();
    await until(() => fake.socket.connections(appId) === 0);
    manager.ensure("one");
    manager.ensure("two");
    await until(() => manager.state("one") === "online" && manager.state("two") === "online");
    expect(make).toHaveBeenCalledTimes(3);
    manager.stopAll();
    expect(manager.state("one")).toBeNull();
    expect(manager.state("two")).toBeNull();
    expect(clock.pending()).toHaveLength(0);
  });
});
