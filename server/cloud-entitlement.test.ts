import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { generateEntitlementSigner, signEntitlement } from "../shared/entitlement.ts";
import { createCloudEntitlement } from "./cloud-entitlement.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const MACHINE = `c${"1".repeat(24)}`, NOW = 1_800_000_000_000;
const dev = generateEntitlementSigner("dev-home");
const env = { MADANI_ENTITLEMENT_DEV_KEYS: `${dev.publicKey.kid}:${dev.publicKey.x}` };
const token = (over: { cloud?: string; aud?: Array<"home" | "app">; exp?: number } = {}) =>
  signEntitlement({ aud: over.aud ?? ["home", "app"], cloud: over.cloud ?? MACHINE, acct: "a", tier: "shared_s", features: ["cloud"], iat: NOW, exp: over.exp ?? NOW + 3_600_000 }, dev.signer);
function home(options: { fromSource?: boolean; required?: boolean; now?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "madani-entitlement-")); dirs.push(dataDir);
  let at = options.now ?? NOW;
  const made = (dir = dataDir) => createCloudEntitlement({ dataDir: dir, machineId: MACHINE, now: () => at, fromSource: options.fromSource ?? true,
    env: { ...env, ...(options.required ? { MADANI_CLOUD_ENTITLEMENT: "required" } : {}) } });
  return { dataDir, made, advance: (ms: number) => { at += ms; } };
}

it("a release build told to require one refuses every client request until a valid entitlement arrives, except its liveness probe", () => {
  const { made } = home({ fromSource: false, required: true });
  const e = made();
  expect(e.required).toBe(true);
  expect(e.gate("/api/bots")).toEqual({ status: 403, body: { error: "entitlement_required" } });
  expect(e.gate("/api/cloud/pairing")).not.toBeNull();
  expect(e.gate("/api/health")).toBeNull();
  // a release build ignores development keys: a token from one never opens it
  expect(e.accept(token())).toEqual({ ok: false, error: "unknown_key" });
  expect(e.gate("/api/bots")).not.toBeNull();
});

it("opens once a token for this machine verifies, keeps it across a restart, and closes again when it expires", () => {
  const { made, advance, dataDir } = home({ required: true });
  const e = made();
  expect(e.gate("/api/bots")).not.toBeNull();
  expect(e.accept(token())).toMatchObject({ ok: true });
  expect(e.gate("/api/bots")).toBeNull();
  expect(statSync(join(dataDir, "cloud-entitlement")).mode & 0o777).toBe(0o600);
  expect(made().gate("/api/bots")).toBeNull();
  advance(3_600_000 + 5 * 60_000);
  expect(made().gate("/api/bots")).not.toBeNull();
});

it("refuses a token for another machine, for the app only, or a forged one, and keeps the longer-lived one it holds", () => {
  const { made, dataDir } = home({ required: true });
  const e = made();
  expect(e.accept(token({ cloud: `c${"2".repeat(24)}` }))).toEqual({ ok: false, error: "wrong_cloud" });
  expect(e.accept(token({ aud: ["app"] }))).toEqual({ ok: false, error: "wrong_audience" });
  expect(e.accept(`${token().slice(0, -4)}AAAA`)).toMatchObject({ ok: false });
  expect(e.accept(token({ exp: NOW + 7_200_000 })).ok).toBe(true);
  const longer = readFileSync(join(dataDir, "cloud-entitlement"), "utf8");
  expect(e.accept(token({ exp: NOW + 3_600_000 })).ok).toBe(true);
  expect(readFileSync(join(dataDir, "cloud-entitlement"), "utf8")).toBe(longer);
});

it("a home whose boot env does not ask (another Admin's) asks for nothing, from source or a release", () => {
  for (const fromSource of [true, false]) {
    const e = home({ fromSource }).made();
    expect(e.required).toBe(false);
    expect(e.gate("/api/bots")).toBeNull();
  }
});
