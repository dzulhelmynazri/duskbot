import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { generateEntitlementSigner, signEntitlement } from "../../shared/entitlement.ts";
import { createCloudEntitlement } from "../cloud-entitlement.ts";
import { createCloudHealth } from "../cloud-health.ts";
import { cloudRequestSignature } from "../cloud-home.ts";
import { DATA_DIR } from "../config.ts";
import { SessionRegistry } from "../sessions.ts";
import { createCloudSignedRoutes } from "./cloud-signed.ts";

const secret = "S".repeat(43), MACHINE = `c${"3".repeat(24)}`, NOW = 1_800_000_000_000;
const dev = generateEntitlementSigner("dev-route");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function routes(linkGrant?: (grant: unknown) => void) {
  let counter = 0;
  const now = () => NOW;
  const dataDir = mkdtempSync(join(tmpdir(), "madani-signed-entitlement-")); dirs.push(dataDir);
  const sessions = new SessionRegistry({ file: join(DATA_DIR, "sessions.json"), now });
  const health = createCloudHealth({
    store: { onChange: () => () => {}, botByThread: () => null, bots: [] }, bus: { subscribe: () => () => {} },
    engines: () => [], dataDir: DATA_DIR, eventsDir: DATA_DIR, version: "0.1.0", image: undefined, connectors: () => null,
    browser: () => ({ available: true, installing: false, interrupted: 0 }), now,
  });
  const entitlement = createCloudEntitlement({ dataDir, machineId: MACHINE, now, fromSource: true,
    env: { MADANI_CLOUD_ENTITLEMENT: "required", MADANI_ENTITLEMENT_DEV_KEYS: `${dev.publicKey.kid}:${dev.publicKey.x}` } });
  const handle = createCloudSignedRoutes({ secret, sessions, health, now, entitlement, ...(linkGrant ? { linkGrant } : {}) });
  const send = async (path: string, value: unknown, key = secret) => {
    const body = JSON.stringify(value), timestamp = String(Math.floor(NOW / 1000)), nonce = `nonce-${String(++counter).padStart(12, "0")}`;
    const headers = { "content-type": "application/json", "x-madani-cloud-timestamp": timestamp, "x-madani-cloud-nonce": nonce,
      "x-madani-cloud-signature": `v1=${cloudRequestSignature(key, timestamp, nonce, "POST", path, body)}` };
    const req = Object.assign(new PassThrough(), { method: "POST", url: path, headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
    let status = 0, text = "";
    const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as unknown as ServerResponse;
    const url = new URL(path, "http://localhost");
    const answered = handle({ req, res, url, path: url.pathname, method: "POST" });
    (req as unknown as PassThrough).end(body);
    return { answered: await answered, status, body: text ? JSON.parse(text) : null };
  };
  return { send, entitlement };
}
const token = (cloud = MACHINE) => signEntitlement({ aud: ["home", "app"], cloud, acct: "a", tier: "pro", features: ["cloud"], iat: NOW, exp: NOW + 3_600_000 }, dev.signer);

describe("POST /api/cloud/entitlement", () => {
  it("refuses pairing until the Admin pushes a valid entitlement for this machine, then pairs", async () => {
    const { send, entitlement } = routes();
    expect(await send("/api/cloud/pairing", { label: "App" })).toMatchObject({ status: 403, body: { error: "entitlement_required" } });
    expect(await send("/api/cloud/entitlement", { v: 1, token: token(`c${"4".repeat(24)}`) })).toMatchObject({ status: 400, body: { error: "wrong_cloud" } });
    expect(await send("/api/cloud/entitlement", { v: 1, token: token() }, "F".repeat(43))).toMatchObject({ status: 401 });
    expect(entitlement.valid()).toBe(false);
    expect(await send("/api/cloud/entitlement", { v: 1, token: token() })).toMatchObject({ status: 200, body: { ok: true, expiresAt: NOW + 3_600_000 } });
    expect((await send("/api/cloud/pairing", { label: "App" })).status).toBe(200);
  });

  it("hands the link grant sent beside a valid entitlement to the phone relay, and never one beside a refused entitlement", async () => {
    const grants: unknown[] = [];
    const { send } = routes((grant) => grants.push(grant));
    await send("/api/cloud/entitlement", { v: 1, token: token(`c${"4".repeat(24)}`), linkGrant: "refused" });
    expect(grants).toEqual([]);
    expect(await send("/api/cloud/entitlement", { v: 1, token: token(), linkGrant: "l1.grant" })).toMatchObject({ status: 200 });
    expect(grants).toEqual(["l1.grant"]);
  });
});
