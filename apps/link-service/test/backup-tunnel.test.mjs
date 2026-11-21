// every server keeps a cloudflare quick tunnel to its direct listener as a backup path: run, read, restarted, and the
// cloudflared it fetches for itself is the pinned one or nothing
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CLOUDFLARED, cloudflaredBinary, control, createBackupTunnel } from "../agent.mjs";

const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } };

describe("the cloudflare backup path", () => {
  it("runs cloudflared to the direct listener, reads its name from the metrics, and answers direct-cf with it", async () => {
    const runs = [];
    const run = (file, args) => { const child = Object.assign(new EventEmitter(), { kill() {} }); runs.push({ file, args }); return child; };
    const fetchImpl = async (url) => (String(url).endsWith("/quicktunnel") ? Response.json({ hostname: "able-baker-charlie.trycloudflare.com" }) : new Response("", { status: 404 }));
    const backup = createBackupTunnel({ wssPort: 8797, binary: async () => "/usr/bin/cloudflared", run, fetchImpl, everyMs: 20 });
    backup.start();
    try {
      await until(() => backup.url() !== null);
      expect(runs[0].args).toEqual(expect.arrayContaining(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8797"]));
      expect(backup.url()).toBe("wss://able-baker-charlie.trycloudflare.com/omb-direct");
      expect(await control("direct-cf", {}, { backup })).toEqual({ v: 1, url: backup.url() });
    } finally { backup.stop(); }
  });

  it("has no backup without cloudflared, and says so when asked", async () => {
    const backup = createBackupTunnel({ wssPort: 8797, binary: async () => null, run: () => { throw new Error("never"); } });
    backup.start();
    try {
      await expect(control("direct-cf", {}, { backup })).rejects.toThrow(/no backup path/);
    } finally { backup.stop(); }
  });

  it("keeps a fetched cloudflared only when it matches the pinned hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-cf-"));
    const saved = process.env.PATH;
    process.env.PATH = dir;
    try {
      const wrong = async () => new Response("not cloudflared");
      await expect(cloudflaredBinary({ dir, fetchImpl: wrong, arch: "x64", platform: "linux" })).rejects.toThrow(/pinned hash/);
      expect(CLOUDFLARED.x64.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash("sha256").update("not cloudflared").digest("hex")).not.toBe(CLOUDFLARED.x64.sha256);
    } finally { process.env.PATH = saved; rmSync(dir, { recursive: true, force: true }); }
  });
});
