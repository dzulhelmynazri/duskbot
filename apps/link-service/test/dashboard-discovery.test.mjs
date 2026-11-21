import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createLinkService } from "../src/app.mjs";

it("advertises the configured account dashboard and returns 404 when unset", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url)), dir = mkdtempSync(join(tmpdir(), "omb-dashboard-discovery-"));
  const previous = process.env.MADANI_LINK_DASHBOARD_URL;
  const service = createLinkService({ base: "http://link.test", dataDir: dir, scriptPath: join(root, "install.sh"), agentPath: join(root, "agent.mjs"), trustProxy: false });
  const server = createServer((req, res) => void service.handler(req, res));
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    const url = `http://127.0.0.1:${server.address().port}/.well-known/madanibot/dashboard`;
    delete process.env.MADANI_LINK_DASHBOARD_URL;
    const missing = await fetch(url); expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: expect.any(String) });
    process.env.MADANI_LINK_DASHBOARD_URL = "https://madani.bot";
    const advertised = await fetch(url); expect(advertised.status).toBe(200); expect(await advertised.json()).toEqual({ v: 1, url: "https://madani.bot" });
  } finally {
    if (previous === undefined) delete process.env.MADANI_LINK_DASHBOARD_URL; else process.env.MADANI_LINK_DASHBOARD_URL = previous;
    service.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); rmSync(dir, { recursive: true, force: true });
  }
});
