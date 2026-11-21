// tls over a dialled socket whose first address fails and a later one connects: before the fix this segfaulted the process
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { wssConnector } from "./vps-link-direct.mjs";
import { connectedSocket, relayFetch } from "./vps-link-protocol.mjs";

let pem = null;
function certificate() {
  if (pem !== null) return pem;
  const dir = mkdtempSync(join(tmpdir(), "madani-fallback-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=relay.test", "-addext", "subjectAltName=DNS:relay.test", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    pem = { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } catch { pem = false; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  return pem;
}

async function refusingPort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** dials relay.test after an async lookup, as real dns answers: first an address that fails, so autoSelectFamily moves the socket to a new handle for the server's */
function fallbackDial(port) {
  const lookup = (_name, _options, done) => setTimeout(() => done(null, [{ address: "127.0.0.2", family: 4 }, { address: "127.0.0.1", family: 4 }]), 10);
  return () => netConnect({ host: "relay.test", port, autoSelectFamily: true, lookup });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
}

test("the relay connects over tls when the dialled socket falls back to a later address", { timeout: 10_000 }, async (t) => {
  const tls = certificate();
  if (!tls) { t.skip("no openssl here"); return; }
  const target = await listen(createSecureServer({ ...tls, allowHTTP1: true }, (_req, res) => res.end("ok")));
  const dial = fallbackDial(target.port);
  const go = relayFetch({ tls: { ca: tls.cert }, dial: () => dial() });
  try {
    assert.equal(await (await go(`https://relay.test:${target.port}/`)).text(), "ok");
  } finally {
    go.close();
    await target.close();
  }
});

test("the direct path's tls goes on only after the dialled socket falls back and connects", { timeout: 10_000 }, async (t) => {
  const tls = certificate();
  if (!tls) { t.skip("no openssl here"); return; }
  const target = await listen(createSecureServer({ ...tls, allowHTTP1: true }, (_req, res) => { res.statusCode = 404; res.end(); }));
  const dial = fallbackDial(target.port);
  try {
    await assert.rejects(wssConnector({ url: `https://relay.test:${target.port}/omb-direct`, spki: "not-this-key", connect: () => dial(), tls: { ca: tls.cert } })(), (error) => error.code === "PIN");
  } finally {
    await target.close();
  }
});

test("connectedSocket rejects and destroys a socket that never opens", { timeout: 5000 }, async () => {
  const port = await refusingPort();
  const socket = netConnect({ host: "127.0.0.1", port });
  await assert.rejects(connectedSocket(socket, { timeoutMs: 2000 }), (error) => error.code === "ECONNREFUSED");
  assert.equal(socket.destroyed, true);
});
