import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureTrail } from "./trail.mjs";
import { exportTrailText, installTrailMain } from "./trail-main.mjs";

function fakeMain({ accept = true, linkPath = () => ({ place: "linked", link: "abc", path: "relay", via: "relay" }) } = {}) {
  const on = new Map(), handle = new Map();
  const written = [];
  configureTrail({ src: "main", writer: { write: (event) => written.push(event), flush: async () => {}, flushSync() {}, close() {} } });
  installTrailMain({
    ipcMain: { on: (name, fn) => on.set(name, fn), handle: (name, fn) => handle.set(name, fn) },
    app: { on() {}, getPath: () => os.tmpdir() }, dialog: {}, shell: {}, powerMonitor: { on() {} }, BrowserWindow: { fromWebContents: () => null },
    logDir: os.tmpdir(), writer: { flush: async () => {}, flushSync() {} }, accept: () => accept, linkPath,
  });
  return { send: (batch) => on.get("trail:write")({ sender: {} }, batch), written };
}

test("a take-over from the page is written with the way this app reaches its server right now", () => {
  const main = fakeMain();
  main.send([{ ev: "takeover.start", bot: "b1", cid: "abc12345", ok: true }, { ev: "ui.click", control: "send" }]);
  const takeover = main.written.find((event) => event.ev === "takeover.start");
  assert.deepEqual(takeover.link, { place: "linked", link: "abc", path: "relay", via: "relay" });
  assert.equal(takeover.src, "renderer");
  assert.equal(main.written.find((event) => event.ev === "ui.click").link, undefined);
});

test("a page main does not trust writes nothing", () => {
  const main = fakeMain({ accept: false });
  main.send([{ ev: "takeover.start" }]);
  assert.equal(main.written.length, 0);
});

test("the export is scrubbed a second time and starts with what it holds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "madani-trail-export-"));
  const now = Date.parse("2026-11-14T10:00:00Z");
  fs.writeFileSync(path.join(dir, "trail.jsonl"), [
    { ts: "2026-11-14T09:00:00.000Z", ev: "link.path", from: "direct", to: "relay", host: "my-vps.example.net", msg: "ssh to 10.1.2.3 failed for sidd@example.com in /Users/sidd/x" },
    { ts: "2026-11-01T09:00:00.000Z", ev: "old" },
  ].map((event) => JSON.stringify(event)).join("\n"));
  const { text, count } = await exportTrailText(dir, { now, home: "/Users/sidd", salt: "x" });
  const lines = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(count, 1);
  assert.equal(lines[0].ev, "export.header");
  assert.match(lines[0].about, /No messages, passwords or personal files/);
  assert.equal(lines[1].to, "relay");
  assert.ok(!/my-vps|10\.1\.2\.3|sidd@|\/Users\/sidd/.test(text));
  fs.rmSync(dir, { recursive: true, force: true });
});
