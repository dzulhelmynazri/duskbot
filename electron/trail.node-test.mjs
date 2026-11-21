import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTrailWriter, readTrail, redactEvent, scrubForExport, scrubString, trailFrom, urlHostPath } from "./trail.mjs";

const SECRETS = [
  "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "AKIAIOSFODNN7EXAMPLE",
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "hunter2-secret-password",
];
const everyString = (value) => JSON.stringify(value);

test("secret-looking values never survive redaction, keyed or free", () => {
  const event = redactEvent({
    ev: "settings.change", ts: new Date().toISOString(),
    apiKey: SECRETS[0], token: SECRETS[1], password: SECRETS[5], cookie: "sid=abc123; other=1", authorization: `Bearer ${SECRETS[2]}`,
    vaultValue: "my bank pin 4321", pairingCode: "482-113",
    msg: `request failed: Authorization: Bearer ${SECRETS[2]} key=${SECRETS[3]} at https://user:pw@my.server.example/api/x?token=${SECRETS[1]}#frag ${SECRETS[4]} ${SECRETS[0]}`,
    nested: { secret: "s3cr3t", deep: { deeper: { gone: "x" } } },
  });
  const text = everyString(event);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret}`);
  for (const bit of ["sid=abc123", "4321", "482-113", "s3cr3t", "user:pw", "token=", "frag"]) assert.ok(!text.includes(bit), `leaked ${bit}`);
  assert.match(event.msg, /my\.server\.example\/api\/x/);
});

test("what people and bots write is never kept, only its length", () => {
  const event = redactEvent({ ev: "chat.send", text: "my diagnosis is private", prompt: "draft a letter to Ana", body: "{}", bot: "b_1", len: 23 });
  const text = everyString(event);
  assert.ok(!text.includes("diagnosis") && !text.includes("Ana"));
  assert.equal(event.textLen, 23);
  assert.equal(event.bot, "b_1");
});

test("ids and paths stay readable: a UUID is an id, a path keeps its segments", () => {
  const id = "ab30b993-104a-4fd0-9111-abfc72147b26";
  const event = redactEvent({ ev: "takeover.take", bot: id, path: `/api/bots/${id}/computer/control?lease=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b`, lease: "9f86d081884c7d659a2feaa0c55ad015" });
  assert.equal(event.bot, id);
  assert.equal(event.path, `/api/bots/${id}/computer/control`);
  assert.equal(event.lease, "«redacted»");
});

test("addresses keep host and path only", () => {
  assert.equal(urlHostPath("https://a:b@host.example:8443/p/q?x=1#y"), "https://host.example:8443/p/q");
  assert.equal(scrubString("open wss://h.trycloudflare.com/link?k=v now"), "open wss://h.trycloudflare.com/link now");
  assert.ok(!scrubString("data:text/plain;base64,SGVsbG8=").includes("SGVsbG8"));
});

test("an unnamed or malformed event is dropped", () => {
  assert.equal(redactEvent({ ev: "Bad Name" }), null);
  assert.equal(redactEvent({ ev: 3 }), null);
  assert.equal(redactEvent(null), null);
});

test("the export scrubber takes out emails, names, IPs, home paths and the person's own hosts, and keeps routes", () => {
  const nasty = {
    ev: "link.path", ts: "2026-11-14T10:00:00.000Z", from: "relay", to: "direct", via: "ssh",
    host: "sidds-mac-mini", origin: "https://vps.siddz.example:8443", node: "eu-1.madani.bot",
    name: "Ananya", botName: "Research Bot", email: "sidd@example.com", account: "acct_123",
    msg: "connect ECONNREFUSED 169.58.211.160:22 from 192.168.1.4 via fe80::1ff:fe23:4567:890a for meenasiddarth72@gmail.com at /Users/siddharth/Desktop/code/OpenMausBot/electron/main.mjs and /home/agent/x and C:\\Users\\Sidd\\AppData; host vps.siddz.example said no",
    stack: "at fn (/Users/siddharth/x.mjs:1:2)",
    path: "/api/bots/b_1/computer/control",
    list: ["direct", "10.0.0.8"],
    secret: SECRETS[0],
  };
  const out = scrubForExport(nasty, { home: "/Users/siddharth", salt: "s" });
  const text = everyString(out);
  for (const bit of ["Ananya", "Research Bot", "sidd@example.com", "meenasiddarth72", "169.58.211.160", "192.168.1.4", "fe80::1ff", "10.0.0.8",
    "siddharth", "agent/x", "Sidd\\\\AppData", "sidds-mac-mini", "vps.siddz.example", SECRETS[0]]) assert.ok(!text.includes(bit), `leaked ${bit}`);
  assert.equal(out.from, "relay");
  assert.equal(out.to, "direct");
  assert.equal(out.via, "ssh");
  assert.equal(out.node, "eu-1.madani.bot");
  assert.equal(out.path, "/api/bots/b_1/computer/control");
  assert.deepEqual(out.list, ["direct", "«ip»"]);
  assert.match(out.host, /^h-[0-9a-f]{10}$/);
  // the same server hashes the same way, so one export still follows it
  assert.ok(out.msg.includes(scrubForExport({ ev: "x", host: "vps.siddz.example" }, { salt: "s" }).host));
  assert.match(out.msg, /~\/Desktop\/code\/OpenMausBot\/electron\/main\.mjs/);
});

test("a tool field keeps only a tool's name, even in a trail written before names were checked", () => {
  const old = { ev: "bot.tool", ts: new Date().toISOString(), tool: "node scripts/upload.mjs --sheet 1BxiMVs0XRA5nFMdKvBdBZjgm", ok: true };
  const out = scrubForExport(old, { home: "/Users/siddharth", salt: "s" });
  assert.equal(out.tool, "tool");
  assert.ok(!everyString(out).includes("upload"));
  assert.equal(scrubForExport({ ev: "bot.tool", tool: "Bash" }).tool, "Bash");
  assert.equal(scrubForExport({ ev: "bot.tool", tool: "invoice.pdf" }).tool, "tool");
  assert.equal(redactEvent({ ev: "bot.card.shown", tool: "mcp__madani__get_url" }).tool, "mcp__madani__get_url");
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "madani-trail-"));

test("the writer batches, rotates past a fifth of the cap and keeps the total under it", async () => {
  const dir = tmp();
  let clock = Date.parse("2026-11-14T10:00:00Z");
  const writer = createTrailWriter({ dir, capBytes: 1024 * 1024 * 2, now: () => clock, flushMs: 5 });
  const pad = "x".repeat(200);
  for (let i = 0; i < 12_000; i++) {
    writer.write({ ts: new Date(clock).toISOString(), ev: i % 2 ? "ui.click" : "link.path", n: i, pad });
    if (i % 1000 === 0) { clock += 1000; await writer.flush(); }
  }
  await writer.flush();
  await writer.prune();
  const files = fs.readdirSync(dir);
  const total = files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  assert.ok(files.length > 1, "rotated");
  assert.ok(total <= 2 * 1024 * 1024 + 512 * 1024, `total ${total}`);
  // past the cap the oldest kept file lost its clicks first
  const compacted = files.filter((name) => name.endsWith(".c.jsonl"));
  for (const name of compacted) assert.ok(!fs.readFileSync(path.join(dir, name), "utf8").includes("\"ev\":\"ui."));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("files older than the window are removed", async () => {
  const dir = tmp();
  const now = Date.parse("2026-11-14T10:00:00Z");
  fs.writeFileSync(path.join(dir, `trail.${now - 8 * 86_400_000}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(dir, `trail.${now - 86_400_000}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(dir, `trail-server.${now - 9 * 86_400_000}.jsonl`), "{}\n");
  await createTrailWriter({ dir, now: () => now }).prune();
  assert.deepEqual(fs.readdirSync(dir).sort(), [`trail-server.${now - 9 * 86_400_000}.jsonl`, `trail.${now - 86_400_000}.jsonl`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a write never throws, even into a folder that cannot exist", async () => {
  const writer = createTrailWriter({ dir: "/dev/null/nope", flushMs: 1 });
  writer.write({ ev: "x" });
  await writer.flush();
  writer.write({ ev: "x", bad: 1n });
  await writer.flush();
});

test("readTrail merges every file in time order and keeps the window", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "trail.jsonl"), `${JSON.stringify({ ts: "2026-11-14T10:00:02.000Z", ev: "b" })}\nnot json\n`);
  fs.writeFileSync(path.join(dir, "trail-server.jsonl"), `${JSON.stringify({ ts: "2026-11-14T10:00:01.000Z", ev: "a" })}\n${JSON.stringify({ ts: "2026-11-13T10:00:01.000Z", ev: "old" })}\n`);
  const events = await readTrail(dir, { sinceMs: Date.parse("2026-11-14T00:00:00Z") });
  assert.deepEqual(events.map((e) => e.ev), ["a", "b"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("events from the renderer are checked one by one and capped", () => {
  assert.equal(trailFrom("renderer", "nope"), 0);
  assert.equal(trailFrom("renderer", [{ ev: "ui.click", control: "send" }, { ev: "BAD" }, null, { nope: 1 }]), 1);
  assert.equal(trailFrom("renderer", Array.from({ length: 500 }, () => ({ ev: "ui.nav" }))), 200);
});
