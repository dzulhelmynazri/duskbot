import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mobileLinkUrl, pairingFromPayload, type MobileLinkPayload, type MobilePairingPayload, type MobileRedeemResponse } from "../../../shared/mobile-link";
import type { MobilePlatform } from "../platform";
import { connectToWorkspace, createConnectionStore, PlaceGoneError } from "./connections";
import { LINK_DEADLINE_MS, linkDeadline, PairError, parseTypedPairing, readScanned, redeemPairing, resolveTypedCode } from "./pair";
import { MOBILE_LINK_VERSION, universalPairLink, universalSignInLink } from "../../../shared/mobile-link";
import * as relay from "../transport/relay";
import { createRelaySecrets } from "../transport/link-crypto";
import { registerPushForConnection } from "./push";
import { outboxKey } from "./active";

const credential = `omb_pair_${"a".repeat(43)}`;
const payload: MobilePairingPayload = { v: 1, transport: "https", origin: "https://workspace.test", credential };

function fakePlatform() {
  const preferences = new Map<string, string>();
  const secrets = new Map<string, string>();
  const storage = (values: Map<string, string>) => ({
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); },
    remove: async (key: string) => { values.delete(key); },
  });
  const platform: MobilePlatform = { kind: "ios", native: true, prefs: storage(preferences), secrets: storage(secrets), deviceName: () => "Test phone", haptic() {}, openExternal: async () => {}, appVersion: "test" };
  return { platform, preferences, secrets };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("typed pairing", () => {
  it("parses phone links and 12-character workspace codes without inventing credentials", () => {
    expect(parseTypedPairing(`madanibot://pair?address=https%3A%2F%2Fworkspace.test&token=${credential}`)).toMatchObject(payload);
    expect(parseTypedPairing("workspace.test abcd1234efgh")).toEqual({ ...payload, v: 1, credential: "", code: "ABCD1234EFGH" });
    // the desktop's qr is an https link, and the app's own scanner reads it too
    expect(parseTypedPairing(`https://madani.bot/m/pair#address=https%3A%2F%2Fworkspace.test&token=${credential}`)).toMatchObject(payload);
    expect((parseTypedPairing(" https://workspace.test:8443 ABCD1234EFGH ") as MobilePairingPayload)?.origin).toBe("https://workspace.test:8443");
  });

  it.each(["workspace.test 123456", "http://workspace.test ABCD1234EFGH", "https://person:secret@workspace.test ABCD1234EFGH", "https://workspace.test/path ABCD1234EFGH", "https://workspace.test?query ABCD1234EFGH", "https://workspace.test#fragment ABCD1234EFGH", "https://workspace.test\\elsewhere ABCD1234EFGH", "madanibot://pair?address=workspace.test", "unrelated text"])("rejects %s", (input) => {
    expect(parseTypedPairing(input)).toBeNull();
  });
});

describe("pairing exchange", () => {
  it.each([
    [400, {}, "invalid"], [400, { error: "pairing expired" }, "expired"], [410, {}, "expired"],
    [409, {}, "used"], [401, {}, "refused"], [403, {}, "refused"], [503, {}, "unreachable"],
    [401, { error: "pairing code is wrong or has expired; create a new one on the server" }, "expired"],
    [403, { error: "Phones sign in to this workspace through its own sign-in.", code: "sign_in_instead" }, "sign-in"], [429, {}, "limited"],
  ])("maps HTTP %s to %s", async (status, body, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body, status)));
    await expect(redeemPairing(payload, fakePlatform().platform)).rejects.toMatchObject({ name: "PairError", code, message: `mobile.pair.${code}` });
  });

  it("reuses the persisted attempt after a network drop and discovers capabilities", async () => {
    const { platform, preferences, secrets } = fakePlatform();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(response({ token: "test-token", serverName: "Studio" }, 201))
      .mockResolvedValueOnce(response({ environmentId: "studio", scopes: ["admin"], id: "session-1" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(redeemPairing(payload, platform)).rejects.toMatchObject({ code: "unreachable" });
    const result = await redeemPairing(payload, platform);
    const first = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const retry = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(first.pairRequestId).toBe(retry.pairRequestId);
    expect(first).toMatchObject({ credential, deviceName: "Test phone" });
    expect([...preferences.keys()]).toEqual([expect.stringMatching(/^madani\.mobile\.pairAttempt\.[a-f0-9]{12}$/)]);
    expect([...preferences.values()]).not.toContain(credential);
    expect(result.record).toMatchObject({ label: "Studio", environmentId: "studio", sessionId: "session-1", capabilities: { computerControl: true, routines: true, notifications: true, settingsWrite: true, openOnDesktop: false } });
    expect(result.record.sessionRef).toBe(`token.${result.record.id}`);
    expect(secrets.size).toBe(0);
    expect(fetcher.mock.calls[2]).toEqual(["https://workspace.test/api/auth/session", expect.objectContaining({ headers: { Authorization: "Bearer test-token" }, credentials: "omit", redirect: "error" })]);
  });

  it("sends typed codes without credential and separates attempts for different codes", async () => {
    const { platform } = fakePlatform();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith("/api/pair") ? response({ token: "test" }) : response({}));
    vi.stubGlobal("fetch", fetcher);
    const typed = parseTypedPairing("workspace.test ABCD1234EFGH") as MobilePairingPayload;
    await redeemPairing(typed, platform);
    await redeemPairing({ ...typed, code: "ABCD1234EFGJ" }, platform);
    const first = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const second = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(first).not.toHaveProperty("credential");
    expect(first.code).toBe("ABCD1234EFGH");
    expect(second.pairRequestId).not.toBe(first.pairRequestId);
  });

  it("refuses a mismatched environment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ token: "test" })).mockResolvedValueOnce(response({ environmentId: "different" })));
    await expect(redeemPairing({ ...payload, environmentId: "expected" }, fakePlatform().platform)).rejects.toMatchObject({ code: "mismatch" });
  });

  it.each([403, 404])("tolerates companion session HTTP %s without inventing privileges", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ token: "test", device: { id: "phone" } })).mockResolvedValueOnce(response({ scopes: ["admin"] }, status)));
    const { record } = await redeemPairing({ ...payload, transport: "companion", origin: "http://companion.test:8810" }, fakePlatform().platform);
    expect(record.environmentId).toBe("http://companion.test:8810");
    expect(record.capabilities).toEqual({ chat: true, uploads: true, computerView: true, computerControl: false, routines: false, settingsWrite: false, notifications: false, openOnDesktop: false });
  });

  it("uses explicit companion capabilities", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ token: "test", capabilities: { routines: true } })).mockResolvedValueOnce(response({ capabilities: { computerControl: true } })));
    const { record } = await redeemPairing({ ...payload, transport: "companion" }, fakePlatform().platform);
    expect(record.capabilities).toMatchObject({ routines: true, computerControl: true, notifications: false });
  });

  it("refuses relay, invalid and expired payloads without contacting a server", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { platform } = fakePlatform();
    await expect(redeemPairing({ ...payload, transport: "relay" }, platform)).rejects.toEqual(new PairError("relay-unavailable"));
    await expect(redeemPairing({ ...payload, expiresAt: Date.now() - 11 * 60_000 }, platform)).rejects.toMatchObject({ code: "expired" });
    await expect(redeemPairing({ ...payload, origin: "https://workspace.test/path" }, platform)).rejects.toMatchObject({ code: "invalid" });
    await expect(redeemPairing({ ...payload, credential: "placeholder" }, platform)).rejects.toMatchObject({ code: "invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves a grant that only just ended by the phone's clock for the desktop to judge", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({}, 410));
    vi.stubGlobal("fetch", fetcher);
    await expect(redeemPairing({ ...payload, expiresAt: Date.now() - 8 * 60_000 }, fakePlatform().platform)).rejects.toMatchObject({ code: "expired" });
    expect(fetcher).toHaveBeenCalled();
  });
});

describe("connection storage", () => {
  it("keeps tokens out of prefs, replaces matching workspaces and removes secure entries", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith("/api/pair") ? response({ token: "sensitive-test-token" }) : response({ environmentId: "work" })));
    const { platform, preferences, secrets } = fakePlatform();
    const { record, token } = await redeemPairing(payload, platform);
    const store = createConnectionStore(platform);
    await store.save(record, token);
    expect(await store.active()).toEqual({ record, token });
    expect(JSON.stringify([...preferences.values()])).not.toContain(token);
    expect(secrets.get(`token.${record.id}`)).toBe(token);
    const replacement = { ...record, id: "replacement", sessionRef: "ignored" };
    await store.save(replacement, "replacement-secret");
    expect(await store.list()).toHaveLength(1);
    expect(secrets.has(record.sessionRef)).toBe(false);
    expect((await store.active())?.record.sessionRef).toBe("token.replacement");
    await store.touch("replacement");
    await store.remove("replacement");
    expect(await store.active()).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(secrets.size).toBe(0);
  });
});

const grantRoute = { kind: "relay", base: "https://relay.test", channel: "abcdefghij", token: "grant-token", key: Buffer.alloc(32, 3).toString("base64url") } as const;
function v2Payload(): MobileLinkPayload {
  return {
    v: 2, workspace: { name: "Studio", environmentId: "studio", kind: "vps" },
    grant: { id: "grant-id", secret: credential, expiresAt: Date.now() + 60_000 },
    via: [{ kind: "https", url: "https://workspace.test" }, grantRoute],
  };
}
function v2Answer(): MobileRedeemResponse {
  return {
    token: "madani_sess_test", workspace: { name: "Studio", environmentId: "studio", kind: "vps" }, scopes: ["client", "admin"],
    device: { id: "device-1", name: "Test phone", platform: "ios", createdAt: 1, lastSeenAt: 1, expiresAt: 1000, relay: true, push: null },
    relay: { base: "https://relay.test", channel: "klmnopqrst", agentPub: Buffer.alloc(32, 7).toString("base64url") },
  };
}

describe("v2 pairing", () => {
  it("accepts the deep link and normalized hostless codes", () => {
    const source = v2Payload();
    expect(parseTypedPairing(mobileLinkUrl(source))).toEqual(pairingFromPayload(source));
    for (const code of ["abcd-efgh-2345", "ABCD EFGH 2345", "abcdefgh2345"]) expect(parseTypedPairing(code)).toEqual({ kind: "code", code: "ABCDEFGH2345" });
  });

  it("resolves a typed code using Node-produced HKDF/AES lookup vectors", async () => {
    const source = v2Payload();
    const code = "ABCDEFGH2345";
    const id = Buffer.from(hkdfSync("sha256", code, "omb-mobile-v1", "lookup", 16)).toString("hex");
    const key = Buffer.from(hkdfSync("sha256", code, "omb-mobile-v1", "seal", 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(id));
    const sealed = Buffer.concat([iv, cipher.update(JSON.stringify(source)), cipher.final(), cipher.getAuthTag()]).toString("base64url");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ sealed }));
    vi.stubGlobal("fetch", fetcher);
    expect(await resolveTypedCode("abcd-efgh 2345", "https://relay.test")).toEqual(pairingFromPayload(source));
    expect(fetcher.mock.calls[0][0]).toBe(`https://relay.test/v1/lookups/${id}`);
  });

  it("maps missing lookups to an unknown code, not an expired one, and unsupported crypto to a clear error", async () => {
    // a /pair code made for a browser has no lookup at all: "expired" sent people to make the same wrong code again
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 404)));
    await expect(resolveTypedCode("ABCDEFGH2345")).rejects.toMatchObject({ code: "unknown" });
    vi.stubGlobal("crypto", {});
    await expect(resolveTypedCode("ABCDEFGH2345")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("persists an attempt and its relay keys before sending, then reuses both after a lost reply", async () => {
    const { platform, preferences, secrets } = fakePlatform();
    const source = pairingFromPayload(v2Payload());
    const channel = { request: vi.fn().mockRejectedValue(new TypeError("offline")), close: vi.fn() };
    vi.spyOn(relay, "open").mockReturnValue(channel);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      const id = preferences.get("madani.mobile.attempt.grant-id");
      expect(id).toBeTruthy();
      expect(secrets.has(`relay.${id}`)).toBe(true);
      throw new TypeError("lost response");
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(redeemPairing(source, platform)).rejects.toMatchObject({ code: "unreachable" });
    fetcher.mockResolvedValueOnce(response(v2Answer()));
    const result = await redeemPairing(source, platform);
    const first = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const second = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(second).toEqual(first);
    expect(first).toMatchObject({ secret: credential, device: { name: "Test phone", platform: "ios", app: "test" } });
    expect(first.relay.verifier).toMatch(/^[a-f0-9]{64}$/);
    expect(result.record).toMatchObject({ id: first.attemptId, transport: "https", origin: "https://workspace.test", environmentId: "studio", label: "Studio", deviceId: "device-1", relay: v2Answer().relay, via: source.via, capabilities: { settingsWrite: true, notifications: true } });
    expect(JSON.stringify([...preferences.values()])).not.toContain(first.relay.pub);
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("sends this install's own id with every pairing, the same one each time, kept in its preferences", async () => {
    const { platform, preferences } = fakePlatform();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(v2Answer()));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(relay, "open").mockReturnValue({ request: vi.fn().mockRejectedValue(new TypeError("offline")), close: vi.fn() });
    await redeemPairing(pairingFromPayload(v2Payload()), platform);
    await redeemPairing(pairingFromPayload({ ...v2Payload(), grant: { ...v2Payload().grant, id: "grant-two" } }), platform);
    const [first, second] = fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).device.install);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    expect(preferences.get("madani.mobile.install")).toBe(first);
  });

  it("times a grant that says when it was issued on the phone's own clock, so a computer an hour slow still pairs", async () => {
    const { platform, preferences } = fakePlatform();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(v2Answer()));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(relay, "open").mockReturnValue({ request: vi.fn().mockRejectedValue(new TypeError("offline")), close: vi.fn() });
    const slow = Date.now() - 60 * 60_000;
    const late = pairingFromPayload({ ...v2Payload(), grant: { ...v2Payload().grant, issuedAt: slow, expiresAt: slow + 10 * 60_000 } });
    expect(late.issuedAt).toBe(slow);
    await expect(redeemPairing(late, platform)).resolves.toMatchObject({ token: expect.any(String) });
    expect(fetcher).toHaveBeenCalled();
    fetcher.mockClear();
    preferences.set("madani.mobile.grantSeen.grant-id", String(Date.now() - 11 * 60_000));
    await expect(redeemPairing(late, platform)).rejects.toMatchObject({ code: "expired" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to grant relay and records the device channel", async () => {
    const channel = { request: vi.fn().mockResolvedValue(response(v2Answer())), close: vi.fn() };
    const opened = vi.spyOn(relay, "open").mockReturnValue(channel);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const { record } = await redeemPairing(pairingFromPayload(v2Payload()), fakePlatform().platform);
    expect(record.transport).toBe("relay");
    expect(record.origin).toBeUndefined();
    expect(record.relay).toEqual(v2Answer().relay);
    expect(opened).toHaveBeenCalledWith(grantRoute.base, grantRoute.channel, grantRoute.token, expect.any(Uint8Array));
    expect(channel.request.mock.calls[0].slice(0, 2)).toEqual(["POST", "/api/mobile/redeem"]);
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("asks the relay once more when the desktop answered before its device channel was open, so the phone can reach it off wi-fi", async () => {
    const late = { ...v2Answer(), relay: undefined };
    const channel = { request: vi.fn().mockResolvedValueOnce(response(late)).mockResolvedValueOnce(response(v2Answer())), close: vi.fn() };
    vi.spyOn(relay, "open").mockReturnValue(channel);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const { record, token } = await redeemPairing(pairingFromPayload(v2Payload()), fakePlatform().platform);
    expect(record.relay).toEqual(v2Answer().relay);
    expect(token).toBe("madani_sess_test");
    expect(channel.request).toHaveBeenCalledTimes(2);
    expect(channel.request.mock.calls[1][3]).toEqual(channel.request.mock.calls[0][3]);

    const stillLate = { request: vi.fn().mockResolvedValueOnce(response(late)).mockRejectedValueOnce(new TypeError("dropped")), close: vi.fn() };
    vi.spyOn(relay, "open").mockReturnValue(stillLate);
    const kept = await redeemPairing(pairingFromPayload(v2Payload()), fakePlatform().platform);
    expect(kept.record).toMatchObject({ transport: "relay", deviceId: "device-1", relay: { base: grantRoute.base, channel: grantRoute.channel } });
    expect(stillLate.close).toHaveBeenCalledOnce();
  });

  it("stops on the first HTTP answer, including a refusal", async () => {
    const opened = vi.spyOn(relay, "open");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 401)));
    await expect(redeemPairing(pairingFromPayload(v2Payload()), fakePlatform().platform)).rejects.toMatchObject({ code: "refused" });
    expect(opened).not.toHaveBeenCalled();
  });

  it("keeps direct pairing available without X25519 and refuses relay-only pairing", async () => {
    vi.spyOn(crypto.subtle, "generateKey").mockRejectedValue(new Error("not supported"));
    const answer = { ...v2Answer(), relay: undefined };
    const fetcher = vi.fn().mockResolvedValue(response(answer));
    vi.stubGlobal("fetch", fetcher);
    const { record } = await redeemPairing(pairingFromPayload(v2Payload()), fakePlatform().platform);
    expect(record.transport).toBe("https");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty("relay");
    await expect(redeemPairing(pairingFromPayload({ ...v2Payload(), via: [grantRoute] }), fakePlatform().platform)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("uses the native companion route with limited capabilities", async () => {
    const source = { ...v2Payload(), via: [{ kind: "companion", url: "http://mac.test:8810", net: "lan", priority: 1 }] } as MobileLinkPayload;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...v2Answer(), scopes: ["client"], relay: undefined })));
    const { record } = await redeemPairing(pairingFromPayload(source), fakePlatform().platform);
    expect(record).toMatchObject({ transport: "companion", origin: "http://mac.test:8810", capabilities: { chat: true, computerView: true, computerControl: false, routines: false, notifications: false, settingsWrite: false } });
  });
});

describe("workspace reconnect", () => {
  async function saved() {
    const fixture = fakePlatform();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(v2Answer())));
    const result = await redeemPairing(pairingFromPayload(v2Payload()), fixture.platform);
    return { ...fixture, ...result };
  }

  it("tries routes in order, derives the device key and never reuses grant secrets", async () => {
    const { record, token, platform, secrets } = await saved();
    const agent = await createRelaySecrets();
    record.relay!.agentPub = agent.pub;
    const channel = { request: vi.fn().mockResolvedValue(response({})), close: vi.fn() };
    const opened = vi.spyOn(relay, "open").mockReturnValue(channel);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const transport = await connectToWorkspace(record, token, platform, new AbortController().signal);
    expect(transport).toEqual({ kind: "relay", channel, token });
    expect(opened.mock.calls[0][1]).toBe(record.relay!.channel);
    expect(opened.mock.calls[0][2]).toBe(JSON.parse(secrets.get(`relay.${record.id}`)!).token);
    expect(opened.mock.calls[0][2]).not.toBe(grantRoute.token);
    expect(channel.request.mock.calls[0].slice(0, 3)).toEqual(["GET", "/api/auth/session", { Authorization: `Bearer ${token}` }]);
  });

  it("treats a 401 on any route as revoked and stops fallback", async () => {
    const { record, token, platform } = await saved();
    const opened = vi.spyOn(relay, "open");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 401)));
    await expect(connectToWorkspace(record, token, platform, new AbortController().signal)).rejects.toMatchObject({ code: "refused" });
    expect(opened).not.toHaveBeenCalled();
  });

  it("tries a computer's wi-fi first, and a phone paired over the relay goes on to it when the companion never saw it", async () => {
    const { record, token, platform } = await saved();
    const agent = await createRelaySecrets();
    record.relay!.agentPub = agent.pub;
    record.via = [record.via!.find((route) => route.kind === "relay")!, { kind: "companion", url: "http://mac.test:8810", net: "lan", priority: 1 }];
    const channel = { request: vi.fn().mockResolvedValue(response({})), close: vi.fn() };
    vi.spyOn(relay, "open").mockReturnValue(channel);
    const fetched = vi.fn().mockResolvedValue(response({}, 401));
    vi.stubGlobal("fetch", fetched);
    expect(await connectToWorkspace(record, token, platform, new AbortController().signal)).toEqual({ kind: "relay", channel, token });
    expect(fetched.mock.calls[0][0]).toBe("http://mac.test:8810/api/auth/session");
  });

  it.each([403, 404])("accepts HTTP %s from a companion after pairing has validated the token", async (status) => {
    const { record, token, platform } = await saved();
    record.via = [{ kind: "companion", url: "http://mac.test:8810", net: "lan", priority: 1 }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, status)));
    expect(await connectToWorkspace(record, token, platform, new AbortController().signal)).toEqual({
      kind: "bearer", origin: "http://mac.test:8810", token,
    });
  });

  it.each([403, 404])("does not accept HTTP %s from a regular workspace route", async (status) => {
    const { record, token, platform } = await saved();
    record.via = [{ kind: "https", url: "https://workspace.test" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, status)));
    await expect(connectToWorkspace(record, token, platform, new AbortController().signal)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("keeps a 401 authoritative even if closing its body fails", async () => {
    const { record, token, platform } = await saved();
    const body = new ReadableStream({ cancel() { throw new Error("connection lost"); } });
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(connectToWorkspace(record, token, platform, new AbortController().signal)).rejects.toMatchObject({ code: "refused" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("a relay that no longer has this phone's channel means removed, and a relay it cannot reach means offline", async () => {
    const { record, token, platform } = await saved();
    record.relay!.agentPub = (await createRelaySecrets()).pub;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const channel = { request: vi.fn().mockRejectedValue(new relay.RelayGoneError()), close: vi.fn() };
    vi.spyOn(relay, "open").mockReturnValue(channel);
    await expect(connectToWorkspace(record, token, platform, new AbortController().signal)).rejects.toMatchObject({ code: "refused" });
    expect(channel.close).toHaveBeenCalledOnce();
    channel.request.mockRejectedValue(new Error("relay request timed out"));
    await expect(connectToWorkspace(record, token, platform, new AbortController().signal)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("opens a madani cloud whose edge says it sleeps instead of calling it unreachable: no read could ever wake it", async () => {
    const { record, token, platform } = await saved();
    record.via = [{ kind: "https", url: "https://workspace.test" }];
    const asleep = () => new Response("asleep", { status: 503, headers: { "x-madani-cloud-power": "asleep", "retry-after": "5" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(asleep()));
    expect(await connectToWorkspace(record, token, platform, new AbortController().signal)).toEqual({ kind: "bearer", origin: "https://workspace.test", token, asleep: true });
    // a plain outage is still unreachable
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 503)));
    await expect(connectToWorkspace(record, token, platform, new AbortController().signal)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("says a madani cloud whose edge answers gone was deleted, never unreachable or unpaired", async () => {
    const { record, token, platform } = await saved();
    record.via = [{ kind: "https", url: "https://workspace.test" }];
    const gone = () => new Response("This madani bot was deleted.", { status: 410, headers: { "x-madani-cloud-power": "gone" } });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => gone()));
    await expect(connectToWorkspace(record, token, platform, new AbortController().signal)).rejects.toBeInstanceOf(PlaceGoneError);
    // a 410 without the edge's word is no more than a failed route
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({}, 410)));
    await expect(connectToWorkspace(record, token, platform, new AbortController().signal)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("falls back after a server failure and stops after a successful companion check", async () => {
    const { record, token, platform } = await saved();
    record.via = [{ kind: "https", url: "https://workspace.test" }, { kind: "companion", url: "http://mac.test:8810", net: "lan", priority: 1 }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response({})));
    expect(await connectToWorkspace(record, token, platform, new AbortController().signal)).toEqual({ kind: "bearer", origin: "http://mac.test:8810", token });
  });

  it("opens on the computer's wi-fi at once while a secure access route and a tailnet name never answer", async () => {
    const { record, token, platform } = await saved();
    record.via = [
      { kind: "companion", url: "https://mac.access.test", net: "hosted", priority: 0 },
      { kind: "companion", url: "http://mac.tail.ts.net:8810", net: "tailnet", priority: 100 },
      { kind: "companion", url: "http://192.168.1.20:8810", net: "lan", priority: 200 },
    ];
    const hung: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => url.startsWith("http://192.168.1.20")
      ? Promise.resolve(response({}))
      : new Promise((_, reject) => init.signal!.addEventListener("abort", () => { hung.push(url); reject(new DOMException("aborted", "AbortError")); }))));
    const started = Date.now();
    expect(await connectToWorkspace(record, token, platform, new AbortController().signal)).toEqual({ kind: "bearer", origin: "http://192.168.1.20:8810", token });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hung).toHaveLength(2);
  });

  it("removes relay keys with a saved connection", async () => {
    const { record, token, platform, secrets } = await saved();
    const store = createConnectionStore(platform);
    await store.save(record, token);
    await store.remove(record.id);
    expect(secrets.has(`relay.${record.id}`)).toBe(false);
  });

  function deletedShelves() {
    const deleted: string[] = [];
    vi.stubGlobal("indexedDB", { deleteDatabase(name: string) {
      deleted.push(name);
      const req = {} as IDBOpenDBRequest;
      queueMicrotask(() => req.onsuccess?.(new Event("success")));
      return req;
    } });
    return deleted;
  }

  it("leaves no unsent messages or saved chats of a removed workspace on the phone", async () => {
    const { record, token, platform, preferences } = await saved();
    const deleted = deletedShelves();
    const store = createConnectionStore(platform);
    await store.save(record, token);
    preferences.set(outboxKey(record.id), "[]");
    await store.remove(record.id);
    expect(preferences.has(outboxKey(record.id))).toBe(false);
    expect(deleted).toEqual([`madani-transcripts.${record.id}`]);
  });

  it("keeps what was written offline when the same installation is linked again, and drops the old link's chats", async () => {
    const { record, token, platform, preferences } = await saved();
    const deleted = deletedShelves();
    const store = createConnectionStore(platform);
    await store.save(record, token);
    preferences.set(outboxKey(record.id), "[\"held\"]");
    const again = { ...record, id: `${record.id}-again`, sessionRef: `token.${record.id}-again` };
    await store.save(again, "token-2");
    expect(preferences.has(outboxKey(record.id))).toBe(false);
    expect(preferences.get(outboxKey(again.id))).toBe("[\"held\"]");
    expect(deleted).toEqual([`madani-transcripts.${record.id}`]);
  });

  it("replaces a madani cloud linked again at its new address, and keeps two places that only share an address fallback", async () => {
    const { record, token, platform, preferences } = await saved();
    deletedShelves();
    const store = createConnectionStore(platform);
    const cloud = { ...record, transport: "https" as const, origin: "https://old.madani.bot", environmentId: "env-cloud", relay: undefined, via: undefined };
    await store.save(cloud, token);
    preferences.set(outboxKey(cloud.id), "[\"held\"]");
    const moved = { ...cloud, id: `${cloud.id}-moved`, sessionRef: `token.${cloud.id}-moved`, origin: "https://new.madani.bot" };
    await store.save(moved, "token-2");
    expect((await store.list()).map((one) => one.origin)).toEqual(["https://new.madani.bot"]);
    expect(preferences.get(outboxKey(moved.id))).toBe("[\"held\"]");
    const bare = { ...cloud, id: "bare-a", sessionRef: "token.bare-a", origin: "https://a.example", environmentId: "https://a.example" };
    await store.save(bare, "token-3");
    await store.save({ ...bare, id: "bare-b", sessionRef: "token.bare-b", origin: "https://b.example" }, "token-4");
    expect((await store.list()).map((one) => one.id)).toEqual([moved.id, "bare-a", "bare-b"]);
  });
});

describe("push registration", () => {
  async function fixture() {
    const { platform, preferences } = fakePlatform();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(v2Answer())));
    const { record, token } = await redeemPairing(pairingFromPayload(v2Payload()), platform);
    await createConnectionStore(platform).save(record, token);
    platform.registerPush = vi.fn().mockResolvedValue({ platform: "apns", token: "push-device-token" });
    const registered = { push: "apns" as string | null };
    const fetcher = vi.fn(async (path: string) => response(path === "/api/mobile/device" ? { device: { push: registered.push } } : { ok: true }));
    vi.stubGlobal("fetch", fetcher);
    return { platform, preferences, record, fetcher, registered };
  }
  const puts = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([path]) => path === "/api/mobile/push");

  it("registers APNs through the installed fetch once per connection and token", async () => {
    const { platform, fetcher } = await fixture();
    await Promise.all([registerPushForConnection(platform), registerPushForConnection(platform)]);
    await registerPushForConnection(platform);
    expect(puts(fetcher)).toHaveLength(1);
    expect(JSON.parse(puts(fetcher)[0][1].body)).toEqual({ service: "apns", token: "push-device-token", environment: "sandbox" });
    // connecting never shows the system's question; a sent message may
    expect(platform.registerPush).toHaveBeenCalledWith({ prompt: false });
    await registerPushForConnection(platform, { prompt: true });
    expect(platform.registerPush).toHaveBeenLastCalledWith({ prompt: true });
    platform.registerPush = vi.fn().mockResolvedValue({ platform: "fcm", token: "new-token" });
    await registerPushForConnection(platform);
    expect(JSON.parse(puts(fetcher)[1][1].body)).toEqual({ service: "fcm", token: "new-token" });
  });

  it("registers again when the workspace dropped the token", async () => {
    const { platform, fetcher, registered } = await fixture();
    await registerPushForConnection(platform);
    registered.push = null;
    await registerPushForConnection(platform);
    expect(puts(fetcher)).toHaveLength(2);
  });

  it("ignores failures, retries rejected registration and skips web", async () => {
    const { platform, fetcher, preferences, record } = await fixture();
    fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(registerPushForConnection(platform)).resolves.toBeUndefined();
    expect(preferences.has(`madani.mobile.push.${record.id}`)).toBe(false);
    await registerPushForConnection(platform);
    expect(puts(fetcher)).toHaveLength(2);
    platform.native = false;
    await registerPushForConnection(platform);
    expect(puts(fetcher)).toHaveLength(2);
  });
});

describe("the app's own scanner reads every qr the desktop, the site or an older build draws", () => {
  const v2 = mobileLinkUrl({
    v: MOBILE_LINK_VERSION, workspace: { name: "Studio", environmentId: "env_1", kind: "mac" },
    grant: { id: "g1", secret: "s3cret", expiresAt: 1_900_000_000_000 },
    via: [{ kind: "relay", base: "https://link.madani.bot", channel: "abcdefghij", token: "tok_1", key: "k".repeat(43) }],
  });

  it("pairs from this computer's qr, the https link and its madanibot:// form alike", () => {
    for (const text of [universalPairLink(v2, "QWER-TYPL-KMNB"), universalPairLink(v2, null), v2, ` ${v2} `]) {
      expect(readScanned(text), text).toMatchObject({ kind: "pair", payload: { v: 2, credential: "s3cret", grantId: "g1" } });
    }
  });

  it("pairs from an older server or companion qr", () => {
    expect(readScanned(`madanibot://pair?address=https%3A%2F%2Fworkspace.test&token=${credential}`)).toMatchObject({ kind: "pair", payload: { origin: "https://workspace.test" } });
    expect(readScanned(`https://madani.bot/m/pair#address=https%3A%2F%2Fworkspace.test&token=${credential}`)).toMatchObject({ kind: "pair" });
  });

  it("opens the madani cloud log in from a cloud's qr, with its email, the https link and madanibot:// alike", () => {
    expect(readScanned(universalSignInLink("owner@example.test"))).toEqual({ kind: "signin", email: "owner@example.test" });
    expect(readScanned("madanibot://signin?email=owner%40example.test")).toEqual({ kind: "signin", email: "owner@example.test" });
    expect(readScanned(universalSignInLink(null))).toEqual({ kind: "signin", email: "" });
  });

  it("a cloud qr with a code, or 8 typed letters, is a madani cloud log in by code; 12 is still a computer's", () => {
    expect(readScanned(universalSignInLink("owner@example.test", "ABCD-EFGH"))).toEqual({ kind: "signin", email: "owner@example.test", code: "ABCDEFGH" });
    expect(readScanned("abcd-efgh")).toEqual({ kind: "account", code: "ABCDEFGH" });
    expect(readScanned(" ABCD EFGH ")).toEqual({ kind: "account", code: "ABCDEFGH" });
    expect(readScanned("ABCD-EFGH-JKLM")).toEqual({ kind: "code", code: "ABCDEFGHJKLM" });
  });

  it("knows the store qr, takes a typed code, and refuses anything else", () => {
    expect(readScanned("https://apps.apple.com/app/id6834725640")).toEqual({ kind: "store" });
    expect(readScanned("https://madani.bot/download")).toEqual({ kind: "store" });
    expect(readScanned("qwer-typl-kmnb")).toEqual({ kind: "code", code: "QWERTYPLKMNB" });
    for (const text of ["https://madani.bot/m/pair?m=x", "https://evil.example/m/pair#m=x", "https://madani.bot/pricing", "hello", ""]) expect(readScanned(text), text).toBeNull();
  });
});

describe("a link attempt never spins forever", () => {
  it("one the computer never answers ends at the deadline with can't reach, for Try again", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
      const attempt = redeemPairing(payload, fakePlatform().platform);
      const outcome = expect(attempt).rejects.toMatchObject({ name: "PairError", code: "unreachable" });
      await vi.advanceTimersByTimeAsync(LINK_DEADLINE_MS + 1);
      await outcome;
    } finally { vi.useRealTimers(); }
  });

  it("the guard passes a result or a failure that comes in time through as it is", async () => {
    await expect(linkDeadline(Promise.resolve("ok"), 50)).resolves.toBe("ok");
    await expect(linkDeadline(Promise.reject(new PairError("used")), 50)).rejects.toMatchObject({ code: "used" });
  });
});
