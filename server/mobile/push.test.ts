import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type ClientHttp2Session, type Http2Server, type IncomingHttpHeaders, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPushSender, pushRelayBase, type PushMessage } from "./push.ts";

const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const message: PushMessage = {
  id: "message-1", kind: "reply", title: "body text", botId: "bot-1", botName: "Maus",
  threadId: "thread-1", groupId: "group-1",
};
const data = { id: "message-1", kind: "reply", botId: "bot-1", threadId: "thread-1", groupId: "group-1" };
let directory: string;
let apnsEnv: NodeJS.ProcessEnv;
let fcmEnv: NodeJS.ProcessEnv;
const timestamp = 1_800_000_000_000;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "madani-push-"));
  const apnsFile = join(directory, "apns.p8");
  const accountFile = join(directory, "account.json");
  writeFileSync(apnsFile, ec.privateKey.export({ format: "pem", type: "pkcs8" }));
  writeFileSync(accountFile, JSON.stringify({
    project_id: "fixture-project", client_email: "push@fixture.example", token_uri: "https://oauth.example/token",
    private_key: rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  }));
  apnsEnv = { MADANI_APNS_KEY_FILE: apnsFile, MADANI_APNS_KEY_ID: "key-id", MADANI_APNS_TEAM_ID: "team-id", MADANI_APNS_TOPIC: "com.example.madani" };
  fcmEnv = { MADANI_FCM_SERVICE_ACCOUNT_FILE: accountFile, MADANI_FCM_HOST: "https://fcm.example" };
});
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

function checkJwt(value: string, algorithm: "ES256" | "RS256") {
  const [header, claims, signature] = value.split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString()).alg).toBe(algorithm);
  expect(verify("sha256", Buffer.from(`${header}.${claims}`), {
    key: algorithm === "ES256" ? ec.publicKey : rsa.publicKey, dsaEncoding: "ieee-p1363",
  }, Buffer.from(signature, "base64url"))).toBe(true);
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    claims: JSON.parse(Buffer.from(claims, "base64url").toString()),
  };
}

describe("APNs push", () => {
  let server: Http2Server;
  let origin: string;
  let status: number;
  let response: object;
  let received: Array<{ headers: IncomingHttpHeaders; body: string }>;
  let sessions: Set<ServerHttp2Session>;
  let clients: ClientHttp2Session[];
  let clock: number;
  const target = { service: "apns" as const, token: "fixture-device" };

  beforeEach(async () => {
    status = 200;
    response = {};
    received = [];
    sessions = new Set();
    clients = [];
    clock = timestamp;
    server = createServer();
    server.on("session", (session) => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => { body += chunk; });
      stream.on("end", () => {
        received.push({ headers, body });
        stream.respond({ ":status": status });
        stream.end(JSON.stringify(response));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not listen");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    for (const client of clients) client.destroy();
    for (const session of sessions) session.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  function sender() {
    return createPushSender({ ...apnsEnv, MADANI_APNS_HOST: origin }, {
      now: () => clock,
      http2Connect: ((...args: Parameters<typeof connect>) => {
        const client = connect(...args);
        clients.push(client);
        return client;
      }) as typeof connect,
    });
  }

  it("sends a signed alert with metadata and reuses its connection", async () => {
    const push = sender();
    expect(push.configured).toEqual(["apns"]);
    expect(await push.send(target, message)).toBe("sent");
    expect(await push.send(target, message)).toBe("sent");
    expect(clients).toHaveLength(1);
    const { headers, body } = received[0];
    expect(headers).toMatchObject({
      ":method": "POST", ":path": "/3/device/fixture-device", "apns-topic": "com.example.madani",
      "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "thread-1",
    });
    const authorization = String(headers.authorization);
    expect(authorization.startsWith("bearer ")).toBe(true);
    const decoded = checkJwt(authorization.slice(7), "ES256");
    expect(decoded.header).toEqual({ alg: "ES256", kid: "key-id" });
    expect(decoded.claims).toEqual({ iss: "team-id", iat: timestamp / 1000 });
    expect(received[1].headers.authorization === headers.authorization).toBe(true);
    expect(body.includes("body text")).toBe(false);
    expect(JSON.parse(body)).toEqual({
      aps: { alert: { title: "Maus", body: "New message" }, sound: "default", "thread-id": "thread-1" }, madani: data,
    });
  });

  it("gives an approval its buttons and its ask id", async () => {
    expect(await sender().send(target, { ...message, kind: "approval", requestId: "req-1", groupId: undefined })).toBe("sent");
    const body = JSON.parse(received[0].body);
    expect(body.aps.category).toBe("madani.approval");
    expect(body.madani.requestId).toBe("req-1");
  });

  it("sends a Live Activity push on the liveactivity topic", async () => {
    const state = { phase: "working" as const, steps: 1, startedAt: 1_799_999_000, step: "web" as const };
    expect(await sender().sendActivity!(target, { event: "update", state, timestamp: 1_800_000_000, priority: 5 })).toBe("sent");
    expect(received[0].headers).toMatchObject({ "apns-topic": "com.example.madani.push-type.liveactivity", "apns-push-type": "liveactivity", "apns-priority": "5" });
    expect(received[0].headers["apns-collapse-id"]).toBeUndefined();
    expect(JSON.parse(received[0].body)).toEqual({ aps: { timestamp: 1_800_000_000, event: "update", "content-state": state } });
  });

  it.each([
    [410, {}, "gone"], [500, {}, "failed"], [400, { reason: "BadDeviceToken" }, "gone"],
    [400, { reason: "DeviceTokenNotForTopic" }, "gone"], [400, { reason: "BadTopic" }, "failed"],
    [403, { reason: "BadDeviceToken" }, "failed"],
  ] as const)("maps status %s and reason %j to %s", async (code, body, outcome) => {
    status = code;
    response = body;
    expect(await sender().send(target, message)).toBe(outcome);
  });

  it("refreshes the provider token at 50 minutes", async () => {
    const push = sender();
    await push.send(target, message);
    clock += 50 * 60_000 - 1;
    await push.send(target, message);
    expect(received[0].headers.authorization === received[1].headers.authorization).toBe(true);
    clock += 1;
    await push.send(target, message);
    const decoded = checkJwt(String(received[2].headers.authorization).slice(7), "ES256");
    expect(decoded.claims.iat).toBe(clock / 1000);
  });

  it("truncates the collapse id at a utf8 boundary and omits absent group ids", async () => {
    const threadId = "a".repeat(61) + "😀😀";
    expect(await sender().send(target, { ...message, threadId, groupId: undefined })).toBe("sent");
    expect(received[0].headers["apns-collapse-id"]).toBe("a".repeat(61));
    expect(JSON.parse(received[0].body).aps["thread-id"]).toBe(threadId);
    expect(JSON.parse(received[0].body).madani).not.toHaveProperty("groupId");
  });

  it("reconnects after goaway", async () => {
    const push = sender();
    await push.send(target, message);
    const goaway = new Promise<void>((resolve) => clients[0].once("goaway", () => resolve()));
    for (const session of sessions) session.goaway();
    await goaway;
    expect(await push.send(target, message)).toBe("sent");
    expect(clients).toHaveLength(2);
  });

  it("reconnects after a closed connection", async () => {
    const push = sender();
    await push.send(target, message);
    const closed = new Promise<void>((resolve) => clients[0].once("close", resolve));
    clients[0].destroy();
    await closed;
    expect(await push.send(target, message)).toBe("sent");
    expect(clients).toHaveLength(2);
  });

  it("selects the sandbox and production origins", async () => {
    const origins: string[] = [];
    const push = createPushSender(apnsEnv, {
      http2Connect: ((authority: string) => {
        origins.push(authority);
        const client = connect(origin);
        clients.push(client);
        return client;
      }) as typeof connect,
    });
    expect(await push.send({ ...target, environment: "sandbox" }, message)).toBe("sent");
    expect(await push.send(target, message)).toBe("sent");
    expect(origins).toEqual(["https://api.sandbox.push.apple.com", "https://api.push.apple.com"]);
  });

  it("returns failed on connection errors", async () => {
    const push = createPushSender(apnsEnv, { http2Connect: () => { throw new Error("offline"); } });
    expect(await push.send(target, message)).toBe("failed");
  });

  it("fails and cancels a stalled stream after 10 seconds", async () => {
    server.removeAllListeners("stream");
    server.on("stream", (stream) => { stream.resume(); });
    const push = sender();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = push.send(target, message);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await outcome).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FCM push", () => {
  const target = { service: "fcm" as const, token: "fixture-registration" };
  let requests: Array<{ url: string; init: RequestInit }>;
  let status: number;
  let response: object;
  let clock: number;
  let tokenStatus: number;
  let fetch: typeof globalThis.fetch;

  beforeEach(() => {
    requests = [];
    status = 200;
    tokenStatus = 200;
    response = {};
    clock = timestamp;
    fetch = async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return String(url) === "https://oauth.example/token"
        ? new Response(JSON.stringify({ access_token: "fixture-access", expires_in: 3600 }), { status: tokenStatus })
        : new Response(JSON.stringify(response), { status });
    };
  });
  function sender() { return createPushSender(fcmEnv, { fetch, now: () => clock }); }

  it("exchanges a signed assertion, caches the access token and sends metadata", async () => {
    const push = sender();
    expect(push.configured).toEqual(["fcm"]);
    expect(await push.send(target, message)).toBe("sent");
    expect(await push.send(target, message)).toBe("sent");
    expect(requests).toHaveLength(3);
    const exchange = requests[0];
    expect(exchange.url).toBe("https://oauth.example/token");
    expect(exchange.init.method).toBe("POST");
    expect(exchange.init.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    const form = new URLSearchParams(String(exchange.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const decoded = checkJwt(form.get("assertion")!, "RS256");
    expect(decoded.claims).toEqual({
      iss: "push@fixture.example", scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth.example/token", iat: timestamp / 1000, exp: timestamp / 1000 + 3600,
    });
    const sent = requests[1];
    expect(sent.url).toBe("https://fcm.example/v1/projects/fixture-project/messages:send");
    expect(sent.init.method).toBe("POST");
    expect(sent.init.headers).toEqual({ authorization: "Bearer fixture-access", "content-type": "application/json" });
    const body = String(sent.init.body);
    expect(body.includes("body text")).toBe(false);
    expect(JSON.parse(body)).toEqual({ message: {
      token: target.token, notification: { title: "Maus", body: "New message" }, data,
      android: { collapse_key: "thread-1", priority: "high" },
    } });
    expect(Object.values(JSON.parse(body).message.data).every((value) => typeof value === "string")).toBe(true);
  });

  it("refreshes five minutes before expiry", async () => {
    const push = sender();
    await push.send(target, message);
    clock += 55 * 60_000 - 1;
    await push.send(target, message);
    expect(requests.filter((request) => request.url.includes("oauth"))).toHaveLength(1);
    clock += 1;
    await push.send(target, message);
    expect(requests.filter((request) => request.url.includes("oauth"))).toHaveLength(2);
  });

  it("shares a token exchange between concurrent sends", async () => {
    const push = sender();
    expect(await Promise.all([push.send(target, message), push.send(target, message)])).toEqual(["sent", "sent"]);
    expect(requests.filter((request) => request.url.includes("oauth"))).toHaveLength(1);
  });

  it.each([
    [404, {}, "gone"],
    [400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is invalid" } }, "gone"],
    [400, { error: { status: "INVALID_ARGUMENT", message: "Invalid notification field" } }, "failed"],
    [403, { error: { details: [{ errorCode: "UNREGISTERED" }] } }, "gone"],
    [500, { error: { status: "INTERNAL" } }, "failed"],
    [401, { error: { status: "UNAUTHENTICATED" } }, "failed"],
  ] as const)("maps status %s and error %j to %s", async (code, body, outcome) => {
    status = code;
    response = body;
    expect(await sender().send(target, message)).toBe(outcome);
  });

  it("fails a rejected token exchange and retries on the next send", async () => {
    tokenStatus = 500;
    const push = sender();
    expect(await push.send(target, message)).toBe("failed");
    expect(requests).toHaveLength(1);
    tokenStatus = 200;
    expect(await push.send(target, message)).toBe("sent");
  });

  it("returns failed on network errors", async () => {
    const push = createPushSender(fcmEnv, { fetch: async () => { throw new Error("offline"); } });
    expect(await push.send(target, message)).toBe("failed");
  });

  it("uses the default origin and omits an absent group id", async () => {
    const push = createPushSender({ MADANI_FCM_SERVICE_ACCOUNT_FILE: fcmEnv.MADANI_FCM_SERVICE_ACCOUNT_FILE }, { fetch });
    expect(await push.send(target, { ...message, groupId: undefined })).toBe("sent");
    expect(requests[1].url).toBe("https://fcm.googleapis.com/v1/projects/fixture-project/messages:send");
    expect(JSON.parse(String(requests[1].init.body)).message.data).not.toHaveProperty("groupId");
  });
});

describe("push configuration", () => {
  it("skips unconfigured services and warns only on the first send", async () => {
    const log = vi.fn();
    const push = createPushSender({}, { log });
    expect(push.configured).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(await push.send({ service: "apns", token: "fixture" }, message)).toBe("skipped");
    expect(await push.send({ service: "fcm", token: "fixture" }, message)).toBe("skipped");
    expect(log).toHaveBeenCalledExactlyOnceWith("mobile push: no APNs or FCM credentials and no push relay on this server; phones get notifications only while the app is open");
  });

  it("loads each service independently and logs credential failures without error details", async () => {
    const log = vi.fn();
    const push = createPushSender({ ...apnsEnv, ...fcmEnv }, {
      log, readFile: (path) => {
        if (path === apnsEnv.MADANI_APNS_KEY_FILE) throw new Error("sensitive fixture details");
        return JSON.stringify({ private_key: "sensitive fixture details" });
      },
    });
    expect(push.configured).toEqual([]);
    expect(log.mock.calls).toEqual([
      ["mobile push: could not load APNs credentials; APNs is disabled"],
      ["mobile push: could not load FCM credentials; FCM is disabled"],
    ]);
    await push.send({ service: "apns", token: "fixture" }, message);
    await push.send({ service: "apns", token: "fixture" }, message);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it("skips an unconfigured service when the other service loaded", async () => {
    const log = vi.fn();
    const push = createPushSender(apnsEnv, { log });
    expect(await push.send({ service: "fcm", token: "fixture" }, message)).toBe("skipped");
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects incomplete APNs credentials", () => {
    const log = vi.fn();
    expect(createPushSender({ MADANI_APNS_KEY_ID: "key-id" }, { log }).configured).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("push relay", () => {
  function relayFetch(status: number, body: unknown) {
    return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  }

  it("sends through the relay when this server has no keys for the service, without the title", async () => {
    const fetch = relayFetch(200, { outcome: "sent" });
    const push = createPushSender({}, { fetch, relay: () => "https://relay.example", log: vi.fn() });
    expect(push.delivers?.("apns")).toBe(true);
    expect(await push.send({ service: "apns", token: "fixture-token", environment: "sandbox" }, message)).toBe("sent");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://relay.example/v1/push");
    const sent = JSON.parse(String(init?.body));
    expect(sent).toEqual({ service: "apns", token: "fixture-token", environment: "sandbox", message: { ...data, botName: "Maus" } });
    expect(JSON.stringify(sent)).not.toContain("body text");
  });

  it("sends a Live Activity push through the relay, and none for FCM", async () => {
    const fetch = relayFetch(200, { outcome: "sent" });
    const push = createPushSender({}, { fetch, relay: () => "https://relay.example", log: vi.fn() });
    const activity = { event: "end" as const, state: { phase: "done" as const, steps: 2, startedAt: 1_799_999_000 }, timestamp: 1_800_000_000, dismissAt: 1_800_000_240, priority: 10 as const };
    expect(await push.sendActivity!({ service: "apns", token: "abcdef0123456789" }, activity)).toBe("sent");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ service: "apns", token: "abcdef0123456789", activity });
    expect(await push.sendActivity!({ service: "fcm", token: "abcdef0123456789" }, activity)).toBe("skipped");
  });

  it("keeps its own keys ahead of the relay", async () => {
    const fetch = relayFetch(200, { outcome: "sent" });
    const push = createPushSender(apnsEnv, { fetch, relay: () => "https://relay.example", http2Connect: (() => { throw new Error("no network"); }) as never });
    expect(await push.send({ service: "apns", token: "fixture" }, message)).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps the relay's answers", async () => {
    const send = (status: number, body: unknown) => createPushSender({}, { fetch: relayFetch(status, body), relay: () => "https://relay.example" }).send({ service: "fcm", token: "fixture" }, message);
    expect(await send(200, { outcome: "gone" })).toBe("gone");
    expect(await send(200, { outcome: "weird" })).toBe("failed");
    expect(await send(503, { code: "not_configured" })).toBe("skipped");
    expect(await send(429, { code: "rate_limited" })).toBe("failed");
  });

  it("reads MADANI_PUSH_RELAY", () => {
    expect(pushRelayBase({}, "https://link.example")).toBe("https://link.example");
    expect(pushRelayBase({ MADANI_PUSH_RELAY: "off" }, "https://link.example")).toBeNull();
    expect(pushRelayBase({ MADANI_PUSH_RELAY: "https://push.example/" }, null)).toBe("https://push.example");
    expect(pushRelayBase({ MADANI_PUSH_RELAY: "not a url" }, "https://link.example")).toBeNull();
  });
});
