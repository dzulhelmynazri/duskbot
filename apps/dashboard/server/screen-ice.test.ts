import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { cleanIceServers, ownTurnServers, SCREEN_ICE_TTL_S, screenIceMinterFromEnv } from "./screen-ice.ts";

const cloudflare = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:5349?transport=tcp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
  ],
};

it("keeps Cloudflare's servers without port 53 and drops anything else", () => {
  expect(cleanIceServers(cloudflare)).toEqual([
    { urls: ["stun:stun.cloudflare.com:3478"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:5349?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
  ]);
  expect(cleanIceServers({ iceServers: { urls: "turn:turn.cloudflare.com:3478", username: "u", credential: "c" } })).toHaveLength(1);
  expect(cleanIceServers({ iceServers: [{ urls: ["turn:evil.example:3478"], username: "u", credential: "c" }, { urls: ["turn:turn.cloudflare.com:3478"] }] })).toEqual([]);
  expect(cleanIceServers(null)).toEqual([]);
});

it("is off without a TURN key, and mints with the key only server-side", async () => {
  expect(screenIceMinterFromEnv({})).toBeNull();
  const fetch = vi.fn(async () => new Response(JSON.stringify(cloudflare), { status: 201 })) as unknown as typeof globalThis.fetch;
  const minter = screenIceMinterFromEnv({ MADANI_CF_TURN_KEY_ID: "key-id-0123456789", MADANI_CF_TURN_KEY_TOKEN: "secret-token" }, fetch)!;
  const answer = await minter.mint(1_000);
  expect(answer).toMatchObject({ v: 1, expiresAt: 1_000 + SCREEN_ICE_TTL_S * 1000 });
  expect(JSON.stringify(answer)).not.toContain("secret-token");
  const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
  expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key-id-0123456789/credentials/generate-ice-servers");
  expect(init.headers.authorization).toBe("Bearer secret-token");
  const refused = screenIceMinterFromEnv({ MADANI_CF_TURN_KEY_ID: "key-id-0123456789", MADANI_CF_TURN_KEY_TOKEN: "t" }, (async () => new Response("no", { status: 401 })) as unknown as typeof globalThis.fetch)!;
  expect(await refused.mint(0)).toBeNull();
});

const SECRET = "s".repeat(40);

it("mints our own coturn credentials in the TURN REST shape", () => {
  const [server] = ownTurnServers(SECRET, ["link.madani.bot", "link-in.madani.bot"], 1_000_000);
  expect(server!.urls).toEqual(["turn:link.madani.bot:3478?transport=udp", "turn:link.madani.bot:3478?transport=tcp", "turn:link-in.madani.bot:3478?transport=udp", "turn:link-in.madani.bot:3478?transport=tcp"]);
  expect(server!.username).toBe(`${1_000 + SCREEN_ICE_TTL_S}:screen`);
  expect(server!.credential).toBe(createHmac("sha1", SECRET).update(server!.username!).digest("base64"));
});

it("uses coturn alone, after Cloudflare, and when Cloudflare refuses", async () => {
  expect(screenIceMinterFromEnv({ MADANI_TURN_SECRET: "short", MADANI_TURN_HOSTS: "link.madani.bot" })).toBeNull();
  expect(screenIceMinterFromEnv({ MADANI_TURN_SECRET: SECRET, MADANI_TURN_HOSTS: "bad host,/x" })).toBeNull();
  const own = await screenIceMinterFromEnv({ MADANI_TURN_SECRET: SECRET, MADANI_TURN_HOSTS: " link.madani.bot " })!.mint(1_000);
  expect(own).toMatchObject({ v: 1, expiresAt: 1_000 + SCREEN_ICE_TTL_S * 1000 });
  expect(own!.iceServers.flatMap((server) => server.urls)).toEqual(["turn:link.madani.bot:3478?transport=udp", "turn:link.madani.bot:3478?transport=tcp"]);
  expect(JSON.stringify(own)).not.toContain(SECRET);
  const env = { MADANI_CF_TURN_KEY_ID: "key-id-0123456789", MADANI_CF_TURN_KEY_TOKEN: "t", MADANI_TURN_SECRET: SECRET, MADANI_TURN_HOSTS: "link.madani.bot" };
  const both = await screenIceMinterFromEnv(env, (async () => new Response(JSON.stringify(cloudflare), { status: 201 })) as unknown as typeof globalThis.fetch)!.mint(0);
  expect(both!.iceServers.map((server) => server.urls[0])).toEqual(["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp", "turn:link.madani.bot:3478?transport=udp"]);
  const refused = await screenIceMinterFromEnv(env, (async () => { throw new Error("down"); }) as unknown as typeof globalThis.fetch)!.mint(0);
  expect(refused!.iceServers).toHaveLength(1);
});
