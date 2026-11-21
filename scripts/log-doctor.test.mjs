import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  group, levelOf, parseBracketed, parseJournal, parseNginxAccess, parseNginxError, parseProzessor, rank, readContabo, readLocal, readOracle,
  readSeen, signature, trailLine, writeSeen,
} from "./log-doctor.mjs";

describe("scripts/log-doctor.mjs", () => {
  it("one signature for lines that differ only in ids, addresses, numbers and names", () => {
    const same = (a, b) => expect(signature(a)).toBe(signature(b));
    same("vps link: direct path did not connect (connect ENETUNREACH 137.23.38.102:22 - Local (0.0.0.0:61429))",
      "vps link: direct path did not connect (connect ENETUNREACH 137.23.38.102:22 - Local (0.0.0.0:50365))");
    same("http 503 POST /v1/channels/ajkjwohxwl/to-vps", "http 503 POST /v1/channels/x5xbkaf2bh/to-vps");
    same("egress: the home's public address is unknown (timeout); asking again in 30 s", "egress: the home's public address is unknown (timeout); asking again in 45 s");
    same("managed: ALERT delete_refused cloud c6b4a64262b15c15cc92cb100 by reconciler", "managed: ALERT delete_refused cloud ceead4ba35e89a0cfa224fb6f by reconciler");
    same("computer update: Ada could not update yet, the old one is kept", "computer update: X Scraper could not update yet, the old one is kept");
    same("bot 3955ec9c-0473-4f66-a089-6af114313c80 woke at 2a02:c207:2352:3248::1", "bot 11111111-0473-4f66-a089-6af114313c80 woke at 64:ff9b::a93a:d3a0");
    expect(signature("http 502 GET /")).not.toBe(signature("http 503 GET /"));
    expect(signature("local ui: could not answer file (Invalid InterceptionId.)")).toBe("local ui: could not answer file (Invalid InterceptionId.)");
  });

  it("errors, warnings and the rest, from the words a line uses", () => {
    expect(levelOf("two places: this computer was not told where the other bots live (fetch failed)")).toBe("error");
    expect(levelOf("vps link: tunnel retrying (the relay closed the stream)")).toBe("warn");
    expect(levelOf("startup: ready 262ms")).toBe("info");
    expect(levelOf("dashboard service listening", "error")).toBe("warn");
  });

  it("reads each log's own format, with its time", () => {
    expect(parseBracketed("[2026-11-13T21:13:45.365Z] two places: x")).toEqual({ at: Date.parse("2026-11-13T21:13:45.365Z"), text: "two places: x" });
    expect(parseProzessor("2026-11-12T04:03:22.644Z ERR persistence: waiting")).toMatchObject({ text: "persistence: waiting", hint: "error" });
    const nginx = parseNginxError('2026/11/14 05:49:55 [error] 994496#994496: *376478 connect() failed (111: Connection refused) while connecting to upstream, client: 1.2.3.4, server: link.apps.siddz.com, request: "GET /v1/tunnels/wd7bya4ia4/to-app?x=1 HTTP/2.0", upstream: "http://127.0.0.1:3101/"');
    expect(nginx.text).toBe("nginx error: connect() failed (111: Connection refused) while connecting to upstream, server: link.apps.siddz.com GET /v1/tunnels/wd7bya4ia4/to-app");
    expect(nginx.at).toBe(Date.parse("2026-11-14T05:49:55Z"));
    const access = parseNginxAccess('172.71.202.8 - - [13/Nov/2026:05:08:37 +0530] "GET /v1/health?x=1 HTTP/2.0" 502 166 "-" "madani-uptime/2"');
    expect(access).toEqual({ at: Date.parse("2026-11-12T23:38:37Z"), text: "http 502 GET /v1/health (uptime check)", hint: "error" });
    expect(parseNginxAccess('1.2.3.4 - - [13/Nov/2026:23:17:00 +0530] "GET / HTTP/2.0" 502 1 "-" "madani-loadtest/1 (qa)"')).toBeNull();
    expect(parseNginxAccess('1.2.3.4 - - [13/Nov/2026:23:17:00 +0530] "GET / HTTP/2.0" 200 1 "-" "x"')).toBeNull();
    expect(parseJournal(JSON.stringify({ MESSAGE: "docker gate: refused", _SYSTEMD_UNIT: "omb-docker-gate.service", __REALTIME_TIMESTAMP: "1763000000000000" })))
      .toEqual({ at: 1763000000000, text: "docker gate: refused", unit: "omb-docker-gate" });
  });

  it("the trail: failed answers, slow requests and drops, never a long poll or a stream that ran long", () => {
    expect(trailLine({ ev: "link.req", method: "POST", path: "/api/bots/3955ec9c-0473-4f66-a089-6af114313c80/computer/control", status: 200, ms: 14125, via: "relay" }).text)
      .toBe("trail link.req: slow POST /api/bots/:id/computer/control (over 3 s, via relay)");
    expect(trailLine({ ev: "api.call", method: "POST", path: "/api/x", status: 409, ms: 10 }).text).toBe("trail api.call: POST /api/x answered 409");
    expect(trailLine({ ev: "link.req", method: "GET", path: "/api/events", status: 200, ms: 14000, kind: "chat-stream" })).toBeNull();
    expect(trailLine({ ev: "desktop.stream.end", ms: 16910 })).toBeNull();
    expect(trailLine({ ev: "link.relay.retry", msg: "the relay closed the stream" }).text).toBe("trail link.relay.retry: the relay closed the stream");
    expect(trailLine({ ev: "ui.click", control: "x" })).toBeNull();
  });

  it("groups by source and signature, ranks errors and counts first, says what is known, and marks what is new", () => {
    const at = (minute) => Date.parse("2026-11-13T00:00:00Z") + minute * 60_000;
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => ({ at: at(i), source: "mac:server.log", text: `egress: the home's public address is unknown (timeout); asking again in ${30 + i} s` })),
      { at: at(9), source: "mac:server.log", text: "two places: this computer was not told where the other bots live (fetch failed)" },
      { at: at(3), source: "mac:server.log", text: "startup: ready 200ms" },
      { at: at(4), source: "contabo:x", text: "    at foo (file.ts:1:2)" },
    ];
    const groups = group(lines);
    expect(groups.map((entry) => entry.count)).toEqual([5, 1, 1]);
    const egress = groups.find((entry) => entry.signature.startsWith("egress"));
    expect([egress.first, egress.last]).toEqual([at(0), at(4)]);
    const seen = new Map([[egress.key, 1]]);
    const ranked = rank(groups, seen);
    expect(ranked.map((entry) => entry.signature.slice(0, 10))).toEqual(["egress: th", "two places", "startup: r"]);
    expect(ranked[0].known).toMatch(/fixed/);
    expect(ranked.map((entry) => entry.new)).toEqual([false, true, true]);
    expect(rank(group(lines), null).every((entry) => !entry.new)).toBe(true);
  });

  it("keeps the signatures it saw between runs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-doctor-"));
    const file = path.join(dir, "seen.json");
    expect(readSeen(file)).toBeNull();
    writeSeen(file, [{ key: "a" }, { key: "b" }], null, 1000);
    const back = readSeen(file);
    expect([back.lastRun, [...back.seen.keys()]]).toEqual([1000, ["a", "b"]]);
    fs.rmSync(dir, { recursive: true });
  });

  it("this computer's folder, Oracle's journal and Contabo's logs, each read by its own parser", async () => {
    const since = Date.parse("2026-11-12T00:00:00Z");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-doctor-"));
    fs.writeFileSync(path.join(dir, "server.log"), "[2026-11-11T00:00:00.000Z] too old\n[2026-11-13T00:00:00.000Z] one home: the top-up waits (fetch failed)\n");
    fs.writeFileSync(path.join(dir, "trail.jsonl"), `${JSON.stringify({ ts: "2026-11-13T00:00:01.000Z", ev: "api.call", src: "renderer", method: "GET", path: "/api/x", status: 500, ms: 3 })}\n`);
    const local = await readLocal([dir], since);
    expect(local.map((line) => [line.source, line.text])).toEqual([["mac:server.log", "one home: the top-up waits (fetch failed)"], ["mac:trail-renderer", "trail api.call: GET /api/x answered 500"]]);
    fs.rmSync(dir, { recursive: true });

    const asked = [];
    const oracle = await readOracle(since, async (host, command) => {
      asked.push([host, command]);
      return `${JSON.stringify({ MESSAGE: "link: tunnel retrying (x)", _SYSTEMD_UNIT: "madanibot-link.service", __REALTIME_TIMESTAMP: String(Date.parse("2026-11-13T00:00:00Z") * 1000) })}\n`;
    });
    expect(oracle).toMatchObject([{ source: "oracle:madanibot-link", text: "link: tunnel retrying (x)" }]);
    expect(asked[0][1]).toMatch(/^journalctl -u madanibot -u madanibot-link -u omb-docker-gate -u madani-link-node --since @\d+ /);

    const contabo = await readContabo(since, async () => [
      "@@ madani-account", "2026-11-13T00:00:00.000Z ERR persistence: another account service holds the writer lease; waiting", "2026-11-13T00:00:00.000Z ERR     at x (y:1:2)",
      "@@ nginx-error", "2026/11/13 00:00:00 [error] 1#1: *2 upstream timed out, client: 1.2.3.4, server: madani.bot",
      "@@ nginx-access", '1.2.3.4 - - [13/Nov/2026:05:30:00 +0530] "GET /v1/me HTTP/2.0" 502 1 "-" "Mozilla"', "",
    ].join("\n"));
    expect(contabo.map((line) => line.source)).toEqual(["contabo:madani-account", "contabo:madani-account", "contabo:nginx-error", "contabo:nginx-access"]);
    expect(group(contabo)).toHaveLength(3);
  });
});
