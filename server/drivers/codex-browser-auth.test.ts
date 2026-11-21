import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexDeviceAuthController } from "./codex-device-auth.ts";

// codex-cli 0.167's `codex login` in a disposable HOME: a localhost listener, the printed auth.openai.com link, and
// its own /success page after the callback. No network, no real account.
const FAKE = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const home = process.env.HOME;
const args = process.argv.slice(2).join(' ');
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({ args, browser: process.env.BROWSER }) + '\n');
if (args === 'login status') {
  if (existsSync(join(home, 'authenticated'))) { process.stderr.write('Logged in using ChatGPT\n'); process.exit(0); }
  process.stderr.write('Not logged in\n'); process.exit(1);
} else if (args === 'login') {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/auth/callback' && url.searchParams.get('state') === 'xyz' && url.searchParams.get('code') === 'GOOD') {
      writeFileSync(join(home, 'authenticated'), 'fixture only');
      res.writeHead(302, { location: 'http://localhost:' + server.address().port + '/success?id_token=fixture' }); res.end(); return;
    }
    if (url.pathname === '/success') { res.writeHead(200); res.end('ok', () => process.exit(0)); return; }
    res.writeHead(400); res.end();
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    process.stderr.write('Starting local login server on http://localhost:' + port + '.\nIf your browser did not open, navigate to this URL to authenticate:\n\n');
    process.stderr.write('https://auth.openai.com/oauth/authorize?response_type=code&client_id=fixture&redirect_uri=' + encodeURIComponent('http://localhost:' + port + '/auth/callback') + '&state=xyz\n');
  });
} else process.exit(4);
`;

describe("Codex normal browser sign-in through a relayed callback", () => {
  let home: string;
  let controller: CodexDeviceAuthController | null = null;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "madani-codex-browser-"));
    writeFileSync(join(home, "codex.mjs"), FAKE, { mode: 0o700 });
  });
  afterEach(async () => {
    await controller?.dispose();
    controller = null;
    await removeTempDir(home);
  });
  const create = () => (controller = new CodexDeviceAuthController({
    cli: join(home, "codex.mjs"),
    environment: () => ({ ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") }),
    startupTimeoutMs: 5000, lifetimeMs: 10_000, terminateTimeoutMs: 50,
  }));

  it("runs `codex login`, shows ChatGPT's page with no code, and signs in from the relayed callback", async () => {
    const login = create();
    const start = await login.start({ browser: true });
    expect(start.userCode).toBeUndefined();
    expect(start.loopback).toMatchObject({ path: "/auth/callback" });
    expect(new URL(start.loopback!.authorizationUrl).hostname).toBe("auth.openai.com");
    const { port } = start.loopback!;
    await expect(login.complete(start.flowId!, `http://localhost:${port}/auth/callback?code=GOOD&state=forged`)).rejects.toThrow(/does not belong/);
    // codex's own /success page is followed on the server and never handed to the browser
    expect(await login.complete(start.flowId!, `http://localhost:${port}/auth/callback?code=GOOD&state=xyz`)).toEqual({});
    expect((await login.get(start.flowId!)).phase).toBe("succeeded");
  });

  it("keeps the device code when the browser cannot reach a loopback", async () => {
    const login = create();
    await expect(login.complete("nope", "http://localhost:1455/auth/callback?code=GOOD&state=xyz")).rejects.toThrow(/no longer available/);
  });
});
