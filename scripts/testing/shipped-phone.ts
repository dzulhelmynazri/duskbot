// The connection code of a phone app build people already have, taken from the commit it was built from and bundled
// for node, so a check drives exactly what that build does: pairing, the route walk and when it unpairs itself.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

/** the commits the shipped phone apps were built from */
export const SHIPPED_PHONES = {
  /** iPhone 1.2, App Store, built 2026-11-17 21:07 IST */
  ios: "95f534fd04",
  /** Android 1.2.1, the signed APK on madani.bot, built 2026-11-18 */
  android: "00b99aea78",
  /** Android 1.2.3, built from release/0.2.23 */
  android123: "28577ae9cb",
  /** Android 1.2.4, built from release/0.2.24 */
  android124: "40d0befb13",
} as const;

export interface PhoneRecord {
  id: string;
  transport: string;
  via?: Array<{ kind: string; url?: string; base?: string; channel?: string }>;
  relay?: { base: string; channel: string; agentPub?: string };
  relayLate?: true;
  deviceId?: string;
  label: string;
  environmentId: string;
}

export interface ShippedPhone {
  readScanned(input: string): { kind: string; payload?: unknown; code?: string } | null;
  redeemPairing(payload: unknown, platform: FakePlatform): Promise<{ record: PhoneRecord; token: string }>;
  resolveTypedCode(code: string, relayBase?: string): Promise<unknown>;
  connectToWorkspace(record: PhoneRecord, token: string, platform: FakePlatform, signal: AbortSignal): Promise<PhoneTransport>;
  createConnectionStore(platform: FakePlatform): { save(record: PhoneRecord, token: string): Promise<void>; remove(id: string): Promise<void>; list(): Promise<PhoneRecord[]> };
  PairError: new (code: string) => Error & { code: string };
  /** builds that heal a pairing's relay channel on connect: what they ask the place after connecting */
  learnRoutes?: (record: PhoneRecord, working: PhoneTransport, save: (id: string, via: PhoneRecord["via"], relay?: PhoneRecord["relay"]) => Promise<void>, ask: typeof fetch, keys: () => Promise<unknown>) => Promise<void>;
  relaySecrets?: (platform: FakePlatform, id: string) => Promise<unknown>;
}

export type PhoneTransport =
  | { kind: "relay"; token: string; asleep?: true; channel: { request(method: string, path: string, headers?: Record<string, string>, body?: Uint8Array | null, signal?: AbortSignal): Promise<Response>; close(): void } }
  | { kind: "bearer"; origin: string; token: string; asleep?: true };

export interface FakePlatform {
  kind: "ios" | "android";
  native: true;
  appVersion: string;
  deviceName(): string;
  prefs: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
  secrets: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
}

export function fakePlatform(kind: "ios" | "android", name: string, appVersion = kind === "ios" ? "1.2" : "1.2.1"): FakePlatform {
  const store = () => {
    const kept = new Map<string, string>();
    return { get: async (key: string) => kept.get(key) ?? null, set: async (key: string, value: string) => { kept.set(key, value); }, remove: async (key: string) => { kept.delete(key); } };
  };
  return { kind, native: true, appVersion, deviceName: () => name, prefs: store(), secrets: store() };
}

/** `git archive` of the build's sources into `scratch`, bundled with its own `@/` paths and this tree's node_modules */
export async function loadShippedPhone(root: string, commit: string, scratch: string): Promise<ShippedPhone> {
  const at = join(scratch, commit);
  mkdirSync(at, { recursive: true });
  const archive = execFileSync("git", ["archive", commit, "src", "shared", "electron/legacy-names.mjs"], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", at], { input: archive });
  const entry = join(at, "entry.ts");
  const heals = readFileSync(join(at, "src/mobile/connection/pair.ts"), "utf8").includes("export async function relaySecrets");
  writeFileSync(entry, [
    `export { readScanned, redeemPairing, resolveTypedCode, PairError${heals ? ", relaySecrets" : ""} } from "./src/mobile/connection/pair";`,
    `export { connectToWorkspace, createConnectionStore } from "./src/mobile/connection/connections";`,
    ...(heals ? [`export { learnRoutes } from "./src/mobile/connection/learn-routes";`] : []),
  ].join("\n"));
  const out = join(at, "phone.mjs");
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "error",
    alias: { "@": join(at, "src") }, nodePaths: [join(root, "node_modules")], loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".json": "json" },
    define: { "import.meta.env": "{}" },
  });
  return await import(pathToFileURL(out).href) as ShippedPhone;
}
