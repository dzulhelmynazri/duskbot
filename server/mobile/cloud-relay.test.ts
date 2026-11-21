import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";
import { startCloudPhoneRelay } from "./cloud-relay.ts";
import { createMobileLink } from "./link.ts";

const LINK_SERVICE = "../../apps/link-service/src/app.mjs";
const { createLinkService } = await import(LINK_SERVICE) as { createLinkService(options: Record<string, unknown>): { handler(req: IncomingMessage, res: ServerResponse): Promise<void>; close(): void; store: { tunnels: Map<string, unknown>; channels: Map<string, { tunnel: string; kind: string }> } } };

const ACCT = "0123456789abcdef0123456789abcdef";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keys = [{ kid: "t", x: publicKey.export({ format: "jwk" }).x! }];
function grant() {
  const iat = Date.now();
  const payload = Buffer.from(JSON.stringify({ v: 1, aud: "link", acct: ACCT, iat, exp: iat + 5 * 60_000 })).toString("base64url");
  return `l1.t.${payload}.${sign(null, Buffer.from(`l1.t.${payload}`), privateKey).toString("base64url")}`;
}

let dir: string, sessions: SessionRegistry, server: Server, base: string, service: ReturnType<typeof createLinkService>;
let stop: () => void = () => {};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "madani-cloud-relay-"));
  sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  service = createLinkService({ base: "http://link.test", dataDir: join(dir, "link"), scriptPath: "apps/link-service/install.sh", agentPath: "apps/link-service/agent.mjs", trustProxy: false, grantKeys: keys });
  server = createServer((req, res) => void service.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  service.close();
  sessions.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(mobile: ReturnType<typeof createMobileLink>, auth: RequestAuth, method: string, path: string, body: unknown = {}) {
  const out: { status: number; body: any } = { status: 0, body: null };
  const res = { setHeader: () => {}, once: () => res, writableEnded: false, destroyed: false } as unknown as ServerResponse;
  const req = { headers: { "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
  await mobile.route({ req, res, path, method, auth, json: (_res, status, value) => { out.status = status; out.body = value; }, readBody: async () => body });
  return out;
}

it("a madani cloud makes its own relay tunnel with the grant the account service sends, and a phone signed in with the account gets a channel on it", async () => {
  const mobile = createMobileLink({
    dataDir: dir, sessions, workspace: () => ({ name: "My Cloud", environmentId: "cloud-1", kind: "server" }), publicOrigin: () => "https://d1.madani.test",
    refusal: () => "Phones sign in to this workspace through its own sign-in.", lookupRelay: null, adoptSessions: true, log: () => {},
    push: { configured: [], send: async () => "skipped" },
  });
  const relay = startCloudPhoneRelay({ dataDir: dir, machineId: "machine-one", port: () => 9, label: () => "My Cloud phones", sync: (input) => mobile.relaySync(input), env: { MADANI_LINK_BASE: base }, checkMs: 200, retryMs: [200] });
  stop = () => relay.stop();
  expect((await relay.ready(1_000)).status).toBe("signed-out");

  relay.grant(grant());
  expect((await relay.ready(15_000)).status).toBe("ready");
  expect(service.store.tunnels.size).toBe(1);
  expect(statSync(join(dir, "phone-relay.json")).mode & 0o777).toBe(0o600);

  // the phone's own session from the account sign-in, not a pairing: the place has a relay and no channel for it yet
  const pairing = sessions.openPairing({ scopes: ["client"], label: "Pixel" });
  const exchanged = sessions.exchange({ code: pairing.code, label: "Pixel", source: "test" });
  if (!exchanged.ok) throw new Error(exchanged.error);
  const phone: RequestAuth = { kind: "session", session: sessions.authenticate(exchanged.token)!, via: "bearer", scopes: ["client"] };
  expect((await call(mobile, phone, "GET", "/api/mobile/routes")).body).toEqual({ https: [{ kind: "https", url: "https://d1.madani.test" }], companion: null, relay: null });
  const phonePub = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x!;
  const opened = await call(mobile, phone, "POST", "/api/mobile/relay", { pub: phonePub, verifier: "e".repeat(64) });
  expect(opened.status).toBe(200);
  expect(opened.body).toMatchObject({ base, agentPub: expect.any(String) });
  expect(service.store.channels.get(opened.body.channel)).toMatchObject({ kind: "device" });
  expect(mobile.state().devices).toHaveLength(1);

  // a cookie session (the cloud's own web page) is never listed as a phone
  const page: RequestAuth = { kind: "session", session: sessions.authenticate(exchanged.token)!, via: "cookie", scopes: ["client"] };
  expect((await call(mobile, { ...page, session: { ...page.session, id: "other" } } as RequestAuth, "POST", "/api/mobile/relay", { pub: phonePub, verifier: "e".repeat(64) })).status).toBe(404);
});

it("a moved or restored home never uses the tunnel another machine saved: it makes its own from the next grant, keeps its phones' channels, and serves them a new key to repair with", async () => {
  const mobile = createMobileLink({
    dataDir: dir, sessions, workspace: () => ({ name: "My Cloud", environmentId: "cloud-1", kind: "server" }), publicOrigin: () => "https://d1.madani.test",
    refusal: () => "Phones sign in to this workspace through its own sign-in.", lookupRelay: null, adoptSessions: true, log: () => {},
    push: { configured: [], send: async () => "skipped" },
  });
  const start = (machineId: string) => startCloudPhoneRelay({ dataDir: dir, machineId, port: () => 9, label: () => "My Cloud phones", sync: (input) => mobile.relaySync(input), env: { MADANI_LINK_BASE: base }, checkMs: 200, retryMs: [200] });
  let relay = start("machine-one");
  stop = () => relay.stop();
  relay.grant(grant());
  expect((await relay.ready(15_000)).status).toBe("ready");
  const pairing = sessions.openPairing({ scopes: ["client"], label: "Pixel" });
  const exchanged = sessions.exchange({ code: pairing.code, label: "Pixel", source: "test" });
  if (!exchanged.ok) throw new Error(exchanged.error);
  const phone: RequestAuth = { kind: "session", session: sessions.authenticate(exchanged.token)!, via: "bearer", scopes: ["client"] };
  const before = (await call(mobile, phone, "POST", "/api/mobile/relay", { pub: generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x!, verifier: "e".repeat(64) })).body;
  const firstTunnel = [...service.store.tunnels.keys()][0];
  relay.stop();

  // the same data folder on another machine: no relay until the account service's next push brings a grant
  relay = start("machine-two");
  expect((await relay.ready(1_000)).status).toBe("signed-out");
  relay.grant(grant());
  expect((await relay.ready(15_000)).status).toBe("ready");
  const tunnels = [...service.store.tunnels.keys()];
  expect(tunnels).toHaveLength(2);
  const secondTunnel = tunnels.find((one) => one !== firstTunnel)!;
  const deadline = Date.now() + 10_000;
  while (service.store.channels.get(before.channel)?.tunnel !== secondTunnel && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(service.store.channels.get(before.channel)?.tunnel).toBe(secondTunnel);
  const after = (await call(mobile, phone, "GET", "/api/mobile/routes")).body.relay;
  expect(after).toMatchObject({ channel: before.channel });
  expect(after.agentPub).not.toBe(before.agentPub);
});
