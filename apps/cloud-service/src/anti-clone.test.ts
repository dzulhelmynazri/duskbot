import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { generateEntitlementSigner, signEntitlement, verifyEntitlement } from "../../../shared/entitlement.ts";
import { createSealer } from "../../dashboard/server/clouds/seal.ts";
import type { StoredCloud } from "../../dashboard/server/clouds/types.ts";
import { Script } from "node:vm";
import { homeControlScript, homeSetupScript, INSTABOX_BOOT_FILE, installCommand, REDEEM_SCRIPT } from "./home.ts";
import { CLAIM_LIMIT_ENTRIES, managedCloudFromEnv } from "./index.ts";
import { homeFixture } from "./test-fixture.ts";
import { machineVerifyScript, signRelease, verifyRelease, type ReleaseKey } from "./release-signing.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function releaseKey(kid = "rel-test"): { signing: string; key: ReleaseKey } {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { signing: `${kid}:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`, key: { kid, x: String(createPublicKey(privateKey).export({ format: "jwk" }).x) } };
}

async function call(handle: NonNullable<ReturnType<typeof managedOf>["handle"]>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = Object.assign(new PassThrough(), { method, url: path, headers, socket: { remoteAddress: "198.51.100.7" } }) as unknown as IncomingMessage;
  let status = 0, text = "";
  const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as unknown as ServerResponse;
  (req as unknown as PassThrough).end(body === undefined ? "" : JSON.stringify(body));
  const answered = await handle(req, res, new URL(path, "http://dash.test"), { publicUrl: "https://dash.example.test",
    json: (r, code, data) => { (r as unknown as { writeHead(c: number): void }).writeHead(code); (r as unknown as { end(d: string): void }).end(JSON.stringify(data)); },
    readJson: async () => body as Record<string, unknown>, clientIp: () => "198.51.100.7" });
  return { answered, status, body: text ? JSON.parse(text) : null };
}
const managedOf = (f: Awaited<ReturnType<typeof homeFixture>>) => f.service.managed!;

describe("the machine never receives its secrets through the provider", () => {
  it("gets a one-time claim, redeems it once (again only within 5 minutes, alerted), and the provider's request carries no secret", async () => {
    const f = await homeFixture({ settings: { claims: true } });
    const plan = { kind: "shared_s" as const, placement: "pool" as const, spec: { vcpu: 2, ramGb: 4, diskGb: 40 }, botComputers: 2 };
    const c = f.service.order({ ...plan, accountId: "acct_1", name: "Mine", color: null, region: "eu" });
    f.subscriptions.push({ id: "sub_x", accountId: "acct_1", cloudId: c.id, status: "active", currentPeriodEnd: f.now() + 30 * 86_400_000, currentPeriodStart: f.now(), updatedAt: f.now(), lastEventAt: f.now() } as never);
    f.service.activate(c.id, "sub_x", plan);
    await f.service.reconcile();
    const create = f.api.requests.find(r => r.method === "POST" && r.path === "/v1/machines")!.body;
    const secret = createSealer(Buffer.alloc(32, 7)).unseal(c.bootstrapSecret);
    const machine = f.api.machines.get(c.serverId!)!, uploaded = [...machine.files.values()].map(b => b.toString()).join("\n");
    const boot = JSON.parse(machine.files.get(INSTABOX_BOOT_FILE)!.toString());
    expect(JSON.stringify(create)).not.toContain(secret);
    expect(uploaded).not.toContain(secret);
    expect(boot).toMatchObject({ v: 2, machine: c.id, redeem: "https://dash.example.test/v1/managed/claims/redeem" });
    expect(c.managed!.claim!.hash).toBe(createHash("sha256").update(boot.claim).digest("hex"));
    const handle = managedOf(f).handle!;
    expect((await call(handle, "POST", "/v1/managed/claims/redeem", { cloud: c.id, claim: "x".repeat(43) })).status).toBe(403);
    const first = await call(handle, "POST", "/v1/managed/claims/redeem", { cloud: c.id, claim: boot.claim });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ v: 1, machine: c.id, env: { MADANI_CLOUD_BOOTSTRAP_SECRET: secret, MADANI_CLOUD_MACHINE_ID: c.id } });
    f.advance(4 * 60_000);
    expect((await call(handle, "POST", "/v1/managed/claims/redeem", { cloud: c.id, claim: boot.claim })).status).toBe(200);
    f.advance(2 * 60_000);
    expect((await call(handle, "POST", "/v1/managed/claims/redeem", { cloud: c.id, claim: boot.claim })).status).toBe(403);
    expect(f.audit.entries(c.id).filter(e => e.action === "claim_redeemed")).toHaveLength(1);
    expect(f.audit.entries(c.id).filter(e => e.action === "claim_redeemed_again")).toHaveLength(1);
  });

  it("a retried create gets the first machine back with the same claim, so its boot still redeems", async () => {
    const f = await homeFixture({ settings: { claims: true } });
    const plan = { kind: "shared_s" as const, placement: "pool" as const, spec: { vcpu: 2, ramGb: 4, diskGb: 40 }, botComputers: 2 };
    const c = f.service.order({ ...plan, accountId: "acct_1", name: "Mine", color: null, region: "eu" });
    f.subscriptions.push({ id: "sub_y", accountId: "acct_1", cloudId: c.id, status: "active", currentPeriodEnd: f.now() + 30 * 86_400_000, currentPeriodStart: f.now(), updatedAt: f.now(), lastEventAt: f.now() } as never);
    f.service.activate(c.id, "sub_y", plan);
    await f.service.reconcile();
    const first = c.serverId;
    // the create's answer was lost: the reserving step runs again with the same attempt
    c.setupStep = "reserving"; c.serverId = null; c.nextAttemptAt = 0;
    await f.service.reconcile();
    expect(c.serverId).toBe(first);
    expect(f.api.machines.size).toBe(1);
    // the boot file the first machine got still names the claim the record now holds
    const claim = JSON.parse(f.api.machines.get(first!)!.files.get(INSTABOX_BOOT_FILE)!.toString()).claim;
    expect(createHash("sha256").update(claim).digest("hex")).toBe(c.managed!.claim!.hash);
    expect((await call(managedOf(f).handle!, "POST", "/v1/managed/claims/redeem", { cloud: c.id, claim })).status).toBe(200);
  });

  it("limits wrong guesses per address, never a machine's own boot", async () => {
    const f = await homeFixture({ settings: { claims: true } });
    const handle = managedOf(f).handle!;
    const codes = [];
    for (let n = 0; n < 61; n++) codes.push((await call(handle, "POST", "/v1/managed/claims/redeem", { cloud: `c${"a".repeat(24)}`, claim: "y".repeat(43) })).status);
    expect(codes.at(0)).toBe(403);
    expect(codes.at(-1)).toBe(429);
  });

  it("remembers a bounded number of guessing addresses, the oldest dropped first", async () => {
    const f = await homeFixture({ settings: { claims: true } });
    const handle = managedOf(f).handle!;
    const guess = async (ip: string) => {
      const req = Object.assign(new PassThrough(), { method: "POST", url: "/v1/managed/claims/redeem", headers: {}, socket: { remoteAddress: ip } }) as unknown as IncomingMessage;
      (req as unknown as PassThrough).end("");
      let status = 0;
      const res = { setHeader() {} } as unknown as ServerResponse;
      await handle(req, res, new URL("/v1/managed/claims/redeem", "http://dash.test"), { publicUrl: "https://dash.example.test",
        json: (_r, code) => { status = code; }, readJson: async () => ({ cloud: `c${"a".repeat(24)}`, claim: "y".repeat(43) }), clientIp: () => ip });
      return status;
    };
    for (let n = 0; n < 60; n++) await guess("203.0.113.1");
    expect(await guess("203.0.113.1")).toBe(429);
    for (let n = 0; n < CLAIM_LIMIT_ENTRIES; n++) await guess(`10.${n >> 16 & 255}.${n >> 8 & 255}.${n & 255}`);
    expect(await guess("203.0.113.1")).toBe(403);
  }, 60_000);
});

describe("the scripts a machine runs", () => {
  it("are valid bash and valid JavaScript, and the claim redeemer refuses a boot file that points anywhere else", () => {
    const { key } = releaseKey();
    const dir = mkdtempSync(join(tmpdir(), "madani-scripts-")); dirs.push(dir);
    for (const [name, text] of [["setup.sh", homeSetupScript({ releaseKeys: [key], requireSigned: true })], ["control.sh", homeControlScript({ releaseKeys: [key], requireSigned: true })]] as const) {
      writeFileSync(join(dir, name), text);
      execFileSync("bash", ["-n", join(dir, name)]);
    }
    expect(() => new Script(REDEEM_SCRIPT)).not.toThrow();
    expect(() => new Script(machineVerifyScript([key]))).not.toThrow();
    writeFileSync(join(dir, "boot.json"), JSON.stringify({ v: 2, machine: `c${"a".repeat(24)}`, claim: "x".repeat(43), redeem: "https://evil.example/steal" }));
    expect(() => execFileSync(process.execPath, ["-e", REDEEM_SCRIPT, join(dir, "boot.json"), join(dir, "out.json")], { stdio: "ignore", timeout: 10_000 })).toThrow();
  });
});

describe("people see our own domain, never the provider's", () => {
  it("publishes an opaque label on the public domain, starts the home with both names, and answers the edge's lookup only for its token", async () => {
    const token = "t".repeat(40);
    const f = await homeFixture({ settings: { publicDomain: "desktops.example.com" }, edgeToken: token });
    const { c } = await f.paid();
    expect(c.origin).toMatch(/^https:\/\/d[0-9a-f]{20}\.desktops\.example\.com$/);
    expect(c.origin).not.toContain(c.id);
    const upstream = c.managed!.upstream!;
    expect(upstream).toMatch(/^https:\/\/8080-[a-z0-9]+\.instabox\.tech$/);
    const start = f.api.requests.filter(r => r.path.endsWith("/exec")).map(r => (r.body as { cmd: string }).cmd).find(cmd => cmd.includes("omb-home start"))!;
    expect(start).toBe(`sudo -n ${CLOUD_HOME.root}/bin/omb-home start '${c.origin}' '${upstream}'`);
    expect(f.home.healthy).toHaveBeenCalledWith(upstream, expect.any(String));
    const label = new URL(c.origin!).hostname.split(".")[0]!;
    const handle = managedOf(f).handle!;
    expect(await call(handle, "GET", `/v1/managed/edge/route?label=${label}`, undefined, { authorization: `Bearer ${token}` })).toMatchObject({ status: 200, body: { upstream } });
    expect((await call(handle, "GET", `/v1/managed/edge/route?label=${label}`, undefined, { authorization: "Bearer nope" })).status).toBe(404);
    expect((await call(handle, "GET", `/v1/managed/edge/route?label=d${"0".repeat(20)}`, undefined, { authorization: `Bearer ${token}` })).status).toBe(404);
    c.status = "destroyed";
    expect(await call(handle, "GET", `/v1/managed/edge/route?label=${label}`, undefined, { authorization: `Bearer ${token}` })).toMatchObject({ status: 410, body: { error: "gone" } });
    expect((await call(handle, "GET", `/v1/managed/edge/route?label=${label}`, undefined, { authorization: "Bearer nope" })).status).toBe(404);
  });
});

describe("signed entitlements", () => {
  it("pushes one to the home before it counts as running, and the app's list carries one for the cloud", async () => {
    const dev = generateEntitlementSigner("dev-svc");
    const entitlements = { sign: (cloud: StoredCloud) => signEntitlement({ aud: ["home", "app"], cloud: cloud.id, acct: "a", tier: cloud.kind, features: ["cloud", "managed"], iat: Date.UTC(2026, 10, 9, 12), exp: Date.UTC(2026, 10, 10, 12) }, dev.signer) };
    const f = await homeFixture({ entitlements });
    const { c } = await f.paid();
    expect(c.status).toBe("running");
    expect(f.home.entitle).toHaveBeenCalledTimes(1);
    const pushed = f.home.entitle.mock.calls[0]![2];
    expect(verifyEntitlement(pushed, { keys: [dev.publicKey], audience: "home", cloudId: c.id, now: f.now() }).ok).toBe(true);
    expect(c.entitledAt).toBe(f.now());
    expect(f.service.entitlement!(c)).toBeTruthy();
  });
});

describe("signed releases", () => {
  it("signs and verifies a package by its sha256 and kind, and refuses another artifact or key", () => {
    const { signing, key } = releaseKey(), other = releaseKey("rel-other");
    const sha256 = "c".repeat(64);
    const signature = signRelease({ kind: "home-package", name: "omb-home", version: "0.1.150", sha256, signedAt: 1 }, signing);
    expect(verifyRelease(signature, { kind: "home-package", sha256 }, [key]).version).toBe("0.1.150");
    expect(() => verifyRelease(signature, { kind: "home-package", sha256: "d".repeat(64) }, [key])).toThrow("another artifact");
    expect(() => verifyRelease(signature, { kind: "desktop" }, [key])).toThrow("another artifact");
    expect(() => verifyRelease(signature, { kind: "home-package", sha256 }, [other.key])).toThrow("unknown key");
  });

  it("the machine's own check, run by node as the control script runs it, accepts only the pinned key's signature for this sha256", () => {
    const { signing, key } = releaseKey(), other = releaseKey("rel-test");
    const dir = mkdtempSync(join(tmpdir(), "madani-release-")); dirs.push(dir);
    const sha256 = "e".repeat(64), file = join(dir, "sig");
    const check = (signature: string, sum: string, kind: string) => {
      writeFileSync(file, signature);
      try { execFileSync(process.execPath, ["-e", machineVerifyScript([key]), file, sum, kind], { stdio: "ignore" }); return true; } catch { return false; }
    };
    const good = signRelease({ kind: "home-package", name: "omb-home", version: "1", sha256, signedAt: 1 }, signing);
    expect(check(good, sha256, "home-package")).toBe(true);
    expect(check(good, "f".repeat(64), "home-package")).toBe(false);
    expect(check(good, sha256, "desktop")).toBe(false);
    expect(check(signRelease({ kind: "home-package", name: "omb-home", version: "1", sha256, signedAt: 1 }, other.signing), sha256, "home-package")).toBe(false);
  });

  it("the install command carries the signature, and a machine that requires one refuses an unsigned package", () => {
    const { signing, key } = releaseKey();
    const signature = signRelease({ kind: "home-package", name: "omb-home", version: "1", sha256: "a".repeat(64), signedAt: 1 }, signing);
    expect(installCommand("a".repeat(64), undefined, signature)).toBe(`sudo -n ${CLOUD_HOME.root}/bin/omb-home install /data/home/omb-home.tgz ${"a".repeat(64)} ${signature}`);
    expect(() => installCommand("a".repeat(64), undefined, "r1.x.y.z; rm -rf /")).toThrow();
    const control = homeControlScript({ releaseKeys: [key], requireSigned: true });
    expect(control).toContain("signed=1");
    expect(control).toContain('echo "unsigned package"');
    expect(control).toContain(key.x);
  });
});

describe("a service people use refuses an unsafe setup", () => {
  const base = { INSTABOX_API_KEY: `ibk_${"k".repeat(52)}`, MADANI_MANAGED: "1", MADANI_CLOUD_SEAL_KEY: Buffer.alloc(32, 3).toString("base64url"),
    MADANI_MANAGED_HOME_PACKAGE_URL: "https://packages.example.test/home.tgz", MADANI_MANAGED_HOME_PACKAGE_SHA256: "a".repeat(64) };
  const make = (env: Record<string, string>) => () => managedCloudFromEnv(env, { dataDir: mkdtempSync(join(tmpdir(), "madani-env-")), publicUrl: "https://dash.example.com", loopback: false,
    sealKey: Buffer.alloc(32, 3), now: Date.now, subscriptions: () => [] });
  it("needs the provider key, our public domain, the edge token and a signed package", () => {
    expect(make({ ...base, INSTABOX_API_KEY: "" })).toThrow("INSTABOX_API_KEY");
    expect(make(base)).toThrow("MADANI_MANAGED_PUBLIC_DOMAIN");
    const named = { ...base, MADANI_MANAGED_PUBLIC_DOMAIN: "desktops.example.com", MADANI_MANAGED_EDGE_TOKEN: "e".repeat(40) };
    expect(make(named)).toThrow("MADANI_MANAGED_HOME_PACKAGE_SIGNATURE");
    expect(make({ ...named, MADANI_MANAGED_HOME_PACKAGE_SIGNATURE: "r1.rel-x.e30.AA" })).toThrow("unknown key");
    const { signing, key } = releaseKey("rel-staging");
    const signature = signRelease({ kind: "home-package", name: "omb-home", version: "1", sha256: "a".repeat(64), signedAt: 1 }, signing);
    expect(make({ ...named, MADANI_MANAGED_HOME_PACKAGE_SIGNATURE: signature, MADANI_RELEASE_PUBLIC_KEYS: `${key.kid}:${key.x}` })()).not.toBeNull();
  });
});
