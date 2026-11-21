import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createDashboardApp } from "./app.ts";
import { createTestMailbox, memoryMailer } from "./auth/mail.ts";

const TOKEN = "t".repeat(40), origin = "http://dashboard.test";

describe("test mail sink", () => {
  let server: Server, app: ReturnType<typeof createDashboardApp>, dataDir: string, url: string, mailer: ReturnType<typeof memoryMailer>;
  async function boot(readable: boolean) {
    dataDir = mkdtempSync(join(tmpdir(), "madani-test-mail-"));
    mailer = memoryMailer();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, testMail: createTestMailbox({ readable }), admin: { emails: [], env: { MADANI_OPS_TOKEN: TOKEN } } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  const read = (to: string, token = TOKEN) => fetch(`${url}/v1/ops/test-mail?to=${encodeURIComponent(to)}`, { headers: { authorization: `Bearer ${token}` } });
  afterEach(async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("on preview", () => {
    beforeEach(() => boot(true));
    it("signs a test address in without sending any mail, the code read with the ops token", async () => {
      const email = "flow-1@qa.madani.test";
      const { attempt } = await (await post("/v1/auth/start", { email })).json() as { attempt: string };
      expect((await read(email, "x".repeat(40))).status).toBe(404);
      const answer = await read(email);
      expect(answer.status).toBe(200);
      const { code } = await answer.json() as { code: string };
      expect(code).toMatch(/^\d{8}$/);
      expect((await post("/v1/auth/verify", { attempt, code })).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 50));
      // no code, welcome or signup alert went to the real mailer
      expect(mailer.outbox).toEqual([]);
    });
    it("reads only test addresses", async () => {
      expect((await read("someone@example.com")).status).toBe(400);
    });
  });
  describe("on production", () => {
    beforeEach(() => boot(false));
    it("drops test mail and has no read route", async () => {
      const email = "flow-2@qa.madani.test";
      expect((await post("/v1/auth/start", { email })).status).toBe(200);
      expect((await read(email)).status).toBe(404);
      expect(mailer.outbox).toEqual([]);
    });
  });
});
