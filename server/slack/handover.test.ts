import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSlackHandover } from "./handover.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("a Mac or own VPS never talks to the edge, even with a dashboard link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-handover-")); dirs.push(dir);
  writeFileSync(join(dir, "dashboard-link.json"), JSON.stringify({ v: 1, url: "https://dash.example.test", workspaceId: "ws_1", publicKey: "x", privateKey: "y", enrolledAt: 1 }));
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const env of [{}, { MADANI_CLOUD_ROLE: "home", MADANI_SLACK_EDGE: "0" }]) {
    const handover = createSlackHandover({ dataDir: dir, env, fetch, bots: () => [{ botId: "b", appId: "A1", botUserId: "U1", appToken: "xapp-1-secret" }], deliver: async () => {} });
    handover.start();
    await handover.sync();
    expect(handover.active).toBe(false);
    handover.stop();
  }
  expect(fetch).not.toHaveBeenCalled();
});
