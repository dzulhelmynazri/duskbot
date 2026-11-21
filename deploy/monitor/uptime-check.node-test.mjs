import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, duration, run, settings } from "./uptime-check.mjs";

const MINUTE = 60_000;
const cfg = { fails: 2 };

test("reads targets with an expected body text", () => {
  const { targets } = settings({});
  assert.deepEqual(targets.find(item => item.name === "api"), { name: "api", url: "https://madani.bot/v1/health", expect: "\"ok\":true" });
  assert.deepEqual(targets.find(item => item.name === "waitlist"), { name: "waitlist", url: "https://madani.bot/", expect: null });
});

test("one down email after two misses, nothing while down, one back up email with the downtime", () => {
  const state = { targets: {} };
  const miss = [{ name: "api", url: "u", ok: false, detail: "http 502" }], hit = [{ name: "api", url: "u", ok: true, detail: "http 200" }];
  let t = 0;
  assert.equal(decide(state, miss, cfg, t).down.length, 0);
  assert.equal(decide(state, miss, cfg, t += MINUTE).down.length, 1);
  for (let n = 0; n < 24 * 60; n++) assert.equal(decide(state, miss, cfg, t += MINUTE).down.length, 0);
  const back = decide(state, hit, cfg, t += MINUTE);
  assert.equal(back.recovered.length, 1);
  assert.equal(duration(back.recovered[0].downFor), "1d 0h");
  assert.equal(decide(state, hit, cfg, t += MINUTE).recovered.length, 0);
  assert.equal(decide(state, miss, cfg, t += MINUTE).down.length, 0);
  assert.equal(decide(state, hit, cfg, t += MINUTE).recovered.length, 0);
});

test("a run mails once, keeps a failed mail for the next run, and stays quiet when this box is offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uptime-"));
  try {
    const sent = [];
    let site = 503, brevo = 500, internet = true;
    const fetcher = async (url, init) => {
      if (url.includes("brevo")) { sent.push(JSON.parse(init.body)); return new Response("{}", { status: brevo }); }
      if (url.includes("cloudflare")) { if (!internet) throw new TypeError("fetch failed"); return new Response("ok"); }
      return new Response("{\"ok\":true}", { status: site });
    };
    const config = { ...settings({ MADANI_UPTIME_TARGETS: "api=https://x.test/v1/health=\"ok\":true", MADANI_UPTIME_TLS: "", MADANI_ALERT_TO: "owner@example.test", MADANI_BREVO_API_KEY: "k", MADANI_UPTIME_STATE: dir }) };
    let t = Date.parse("2026-11-12T10:00:00Z");
    const go = () => run(config, { fetcher, now: () => (t += MINUTE) });
    await go(); await go();
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /^something's wrong: api is down$/);
    assert.doesNotMatch(sent[0].htmlContent + sent[0].textContent, /—/);
    brevo = 201;
    await go();
    assert.equal(sent.length, 2);
    internet = false;
    for (let n = 0; n < 5; n++) await go();
    assert.equal(sent.length, 2);
    internet = true; site = 200;
    await go();
    assert.equal(sent.length, 3);
    assert.match(sent[2].subject, /^back up: api$/);
    assert.match(sent[2].textContent, /was down for/);
    for (let n = 0; n < 30; n++) { site = n % 4 < 2 ? 503 : 200; await go(); }
    const refusedAttempts = 1;
    assert.equal(sent.length, 10 + refusedAttempts);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
