// `pnpm dev:app`'s server takes changes only with the desktop owner header, so its test-bot seeding child must send it.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without types
import { call, readOwnerToken, useOwnerToken } from "../scripts/demo/seed-live.mjs";

const TOKEN = "a".repeat(43);
const closers: (() => void)[] = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

async function recorder() {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => { seen.push(req.headers); res.setHeader("content-type", "application/json"); res.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("the dev app's test-bot seeding", () => {
  it("reads the owner capability from the first line its parent writes on stdin", async () => {
    const stdin = new PassThrough();
    const token = readOwnerToken(stdin, 1_000);
    stdin.write(`${TOKEN}\nanything after\n`);
    await expect(token).resolves.toBe(TOKEN);
    await expect(readOwnerToken(new PassThrough(), 10)).resolves.toBeNull();
  });

  it("refuses a malformed capability", () => {
    expect(() => useOwnerToken("short")).toThrow();
    expect(() => useOwnerToken(null)).toThrow();
  });

  it("sends the owner header on reads and changes once it has one", async () => {
    const { base, seen } = await recorder();
    useOwnerToken(TOKEN);
    await call(base, "GET", "/api/bots");
    await call(base, "POST", "/api/routines", { name: "x" });
    expect(seen.map((headers) => headers["x-madani-desktop-owner"])).toEqual([TOKEN, TOKEN]);
    expect(seen[1]!["content-type"]).toBe("application/json");
  });
});
