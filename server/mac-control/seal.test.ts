import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cloudJobRefusal, cloudMacJobAad, cloudMacOutcomeAad, cloudMacSignedBytes, createCloudMacSeal } from "../../electron/cloud-mac.mjs";
import * as shared from "../../shared/cloud-mac.ts";
import { openMacOutcome, readLinkSigningKey, sealMacJob } from "./seal.ts";

const link = generateKeyPairSync("ed25519");
const linkPublic = link.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const job = (over: Record<string, unknown> = {}) => ({ id: randomUUID(), tool: "mac_exec", arguments: { command: "git status" }, bot: { id: "nova", name: "Nova" }, expiresAt: Date.now() + 60_000, ...over });

describe("sealed jobs between a madani cloud and the Mac", () => {
  it("the Mac and the cloud agree on the signed and authenticated bytes", () => {
    const parts = { mac: "a", eph: "b", iv: "c", data: "d" };
    expect(cloudMacSignedBytes(parts)).toBe(shared.cloudMacSignedBytes(parts));
    expect(cloudMacJobAad("a", "b")).toBe(shared.cloudMacJobAad("a", "b"));
    expect(cloudMacOutcomeAad("x")).toBe(shared.cloudMacOutcomeAad("x"));
  });

  it("opens a job sealed to this Mac and signed by its cloud, and seals the outcome back", () => {
    const mac = createCloudMacSeal();
    const sent = job();
    const { envelope, key } = sealMacJob(sent, mac.key(), link.privateKey);
    const opened = mac.open(envelope, linkPublic);
    expect(opened.job).toEqual(sent);
    const outcome = { ok: true, result: { text: "exit code 0" } };
    expect(openMacOutcome(opened.wrap(outcome).sealed, key, sent.id)).toEqual(outcome);
    expect(() => openMacOutcome(opened.wrap(outcome).sealed, key, "another-job")).toThrow();
  });

  it("refuses a job signed by any other key, changed on the way, sealed to another Mac, repeated or expired", () => {
    const mac = createCloudMacSeal();
    const other = generateKeyPairSync("ed25519");
    expect(() => mac.open(sealMacJob(job(), mac.key(), other.privateKey).envelope, linkPublic)).toThrow(/not signed/);
    const { envelope } = sealMacJob(job(), mac.key(), link.privateKey);
    const flipped = Buffer.from(envelope.data, "base64url");
    flipped[0] ^= 1;
    expect(() => mac.open({ ...envelope, data: flipped.toString("base64url") }, linkPublic)).toThrow(/not signed/);
    expect(() => mac.open(sealMacJob(job(), createCloudMacSeal().key(), link.privateKey).envelope, linkPublic)).toThrow(/another key/);
    const once = sealMacJob(job(), mac.key(), link.privateKey).envelope;
    mac.open(once, linkPublic);
    expect(() => mac.open(once, linkPublic)).toThrow(/already ran/);
    expect(() => mac.open(sealMacJob(job({ expiresAt: Date.now() - 1 }), mac.key(), link.privateKey).envelope, linkPublic)).toThrow(/expired/);
    expect(() => mac.open(envelope, null)).toThrow(/no link key/);
  });

  it("reads the cloud's own link key from its data folder, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-link-key-"));
    try {
      expect(readLinkSigningKey(dir)).toBeNull();
      writeFileSync(join(dir, "dashboard-link.json"), JSON.stringify({ v: 1, privateKey: link.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") }));
      expect(readLinkSigningKey(dir)?.asymmetricKeyType).toBe("ed25519");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("what the Mac itself refuses", () => {
  let home: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "madani-cloud-mac-home-")));
    mkdirSync(join(home, "Downloads"));
    mkdirSync(join(home, "Documents"));
    symlinkSync(join(home, "Documents"), join(home, "Downloads", "escape"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("a risky action needs its card in Auto; Never ask runs it; Ask needs one for every action", async () => {
    const risky = { tool: "mac_exec", arguments: { command: "rm -rf build" } };
    expect(await cloudJobRefusal({ ...risky }, { mode: "auto", home })).toMatch(/deletes many files/);
    expect(await cloudJobRefusal({ ...risky, approved: true }, { mode: "auto", home })).toBeNull();
    expect(await cloudJobRefusal({ ...risky }, { mode: "never", home })).toBeNull();
    expect(await cloudJobRefusal({ tool: "mac_exec", arguments: { command: "ls" } }, { mode: "auto", home })).toBeNull();
    expect(await cloudJobRefusal({ tool: "mac_exec", arguments: { command: "ls" } }, { mode: "ask", home })).toMatch(/allow it on a card/);
    expect(await cloudJobRefusal({ tool: "mac_screenshot", arguments: {} }, { mode: "never", home })).toMatch(/does not let cloud bots/);
  });

  it("Only these folders keeps files, downloads and a command's folder inside them, links followed", async () => {
    const folders = ["~/Downloads"];
    expect(await cloudJobRefusal({ tool: "mac_read_file", arguments: { path: "~/Downloads/a.txt" } }, { folders, mode: "never", home })).toBeNull();
    expect(await cloudJobRefusal({ tool: "mac_read_file", arguments: { path: "~/Documents/a.txt" } }, { folders, mode: "never", home })).toMatch(/outside/);
    expect(await cloudJobRefusal({ tool: "mac_write_file", arguments: { path: "~/Downloads/escape/a.txt" } }, { folders, mode: "never", home })).toMatch(/outside/);
    expect(await cloudJobRefusal({ tool: "mac_write_file", arguments: { path: "~/Downloads/../Documents/a.txt" } }, { folders, mode: "never", home })).toMatch(/outside/);
    const exec = { tool: "mac_exec", arguments: {} as Record<string, unknown> };
    expect(await cloudJobRefusal(exec, { folders, mode: "never", home })).toBeNull();
    expect(exec.arguments.cwd).toBe("~/Downloads");
    expect(await cloudJobRefusal({ tool: "mac_exec", arguments: { command: "ls", cwd: "~" } }, { folders, mode: "never", home })).toMatch(/outside/);
    expect(await cloudJobRefusal({ tool: "mac_open", arguments: { target: "vnc://x" } }, { folders, mode: "never", home })).toMatch(/only opens/);
    expect(await cloudJobRefusal({ tool: "mac_read_file", arguments: { path: "~/Documents/a.txt" } }, { mode: "never", home })).toBeNull();
  });
});
