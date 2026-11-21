#!/usr/bin/env node
// the chaos run: brings up two link service nodes, a server with the real agent and the app's real relay code, then
// breaks things one at a time and measures what a person would notice and how long until it works again.
//   node apps/link-service/chaos/run.mjs                  every scenario
//   node apps/link-service/chaos/run.mjs --quick          the short set (ci)
//   node apps/link-service/chaos/run.mjs --only a,b       some scenarios
//   --md file / --json file write the matrix; --verbose streams every process's log
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createAgent, createApp, createBotServer, createFaultProxy, createFront, createImpostor, createNode, freePort, makeCerts, removeScratch, scratch, sleep, STATS_TOKEN } from "./harness.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { randomBytes } from "node:crypto";
import { createRelayClient, newLinkKeys, openResult, randomB32, sealKeyOf, sha256hex, vpsTokenOf, x25519Pair } from "../../../electron/vps-link-protocol.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
const verbose = flag("--verbose");
const log = verbose ? (line) => console.error(line) : () => {};
const say = (line) => console.error(`${new Date().toISOString().slice(11, 19)} ${line}`);

/** the whole loopback world; `world.reset()` puts every fault back */
async function bringUp() {
  const dir = process.env.MADANI_CHAOS_DIR;
  const certs = makeCerts(dir);
  const ids = ["contabo", "oracle-in"];
  const pub = {}, nodePorts = {}, fronts = {}, nodes = {}, net = {}, appNet = {}, agentNet = {};
  for (const id of ids) { pub[id] = await freePort(); nodePorts[id] = await freePort(); }
  const list = ids.map((id, i) => `${id}=https://localhost:${pub[id]}@${i ? "asia" : "eu"}`).join(",");
  const impostor = await createImpostor({ key: certs.fakeKey, cert: certs.fakeCert });
  for (const id of ids) {
    nodes[id] = createNode({ id, port: nodePorts[id], dataDir: join(dir, `node-${id}`), nodes: list, base: `https://localhost:${pub[id]}`, log });
    await nodes[id].start();
    fronts[id] = await createFront({ key: certs.key, cert: certs.cert, target: nodePorts[id] });
    net[id] = await createFaultProxy({ port: pub[id], target: fronts[id].port, impostor: impostor.port });
    appNet[id] = await createFaultProxy({ target: pub[id], impostor: impostor.port });
    agentNet[id] = await createFaultProxy({ target: pub[id], impostor: impostor.port });
  }
  const base = `https://localhost:${pub.contabo}`;
  const bot = await createBotServer();
  /**
   * one server linked the way the app and install.sh do it: a setup session on the default node, the agent's own `link`,
   * the sealed result opened here, then `tunnel` and the app's relay. `placeOn`: the server measures every other node as
   * far away, so it lives there while the app knows only the node it linked through
   */
  async function linkServer({ name = "server", placeOn = null } = {}) {
    const phone = option("--client") === "phone";
    const rtc = option("--direct") === "rtc";
    const agent = createAgent({ home: join(dir, `${name}-home`), serverPort: bot.port, ca: certs.ca, log, env: { MADANI_CHAOS_PORTS: ids.map((id) => `${pub[id]}:${agentNet[id].port}`).join(","), ...(phone ? { MADANI_LINK_PHONES: "on" } : {}),
      // --direct rtc: the agent answers webrtc offers with the node-datachannel this checkout has
      ...(rtc ? { MADANI_LINK_DIRECT: "on", MADANI_LINK_NDC_DIR: fileURLToPath(new URL("../../..", import.meta.url)), MADANI_LINK_RTC_FETCH: "off", MADANI_LINK_WSS_PORT: String(await freePort()) } : {}) } });
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    await agent.link({ LINK_BASE: base, LINK_ID: made.id, LINK_TOKEN: vpsTokenOf(keys.secret), LINK_NAME: name });
    const done = await relay.watch(made.id, made.watch, 0);
    const result = openResult({ id: made.id, priv: keys.priv, pub: keys.pub, vpsPub: done.vpsPub, sealed: done.sealed });
    const link = { base, id: made.id, key: result.tunnel.key, token: result.tunnel.token };
    if (placeOn) for (const id of ids) if (id !== placeOn) await agentNet[id].set("pass", { latencyMs: 400 });
    agent.start();
    if (placeOn) {
      for (let i = 0; i < 100 && !agent.lines.some((line) => line.includes(`lives on node ${placeOn}`)); i += 1) await sleep(100);
      for (const id of ids) await agentNet[id].set("pass");
    }
    process.env.MADANI_CHAOS_PORTS = ids.map((id) => `${pub[id]}:${appNet[id].port}`).join(",");
    let app;
    if (phone) {
      // --client phone: the phone app's transport on a device channel the stand-in server hands the agent
      const pair = x25519Pair(), cid = randomB32(10), token = randomBytes(32).toString("base64url");
      bot.setPhone({ id: cid, verifier: sha256hex(token), kind: "device", pub: pair.pub });
      for (let i = 0; i < 200 && !bot.agentPub(); i += 1) await sleep(100);
      if (!bot.agentPub()) throw new Error("the agent never asked the server for phone channels");
      await sleep(1500);
      app = createApp({ link: { base, id: cid, token, key: sealKeyOf(pair.priv, pair.pub, bot.agentPub(), cid).toString("base64url") }, ca: certs.ca, log, runner: "phone-runner.mjs" });
    } else {
      if (rtc) process.env.MADANI_CHAOS_DIRECT = "rtc";
      app = createApp({ link, ca: certs.ca, log });
    }
    await app.start();
    delete process.env.MADANI_CHAOS_PORTS;
    delete process.env.MADANI_CHAOS_DIRECT;
    return { agent, app, link };
  }
  const { agent, app, link } = await linkServer({ placeOn: option("--home") });

  const world = {
    dir, certs, ids, pub, nodes, fronts, net, appNet, agentNet, bot, agent, app, link, base, linkServer,
    url: (id) => `https://localhost:${pub[id]}`,
    async limits(id, body) {
      const response = await fetch(`http://127.0.0.1:${nodePorts[id]}/ops/relay/limits`, { method: "PUT", headers: { authorization: `Bearer ${STATS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`limits answered ${response.status}: ${await response.text()}`);
      return response.json();
    },
    async stats(id) { return (await fetch(`http://127.0.0.1:${nodePorts[id]}/ops/relay/stats`, { headers: { authorization: `Bearer ${STATS_TOKEN}` } })).json(); },
    async homeOf() {
      for (const id of ids) {
        if (!nodes[id].alive()) continue;
        try {
          const response = await fetch(`http://127.0.0.1:${nodePorts[id]}/v1/tunnels/${link.id}/node`, { headers: { authorization: `Bearer ${link.token}` }, signal: AbortSignal.timeout(2000) });
          if (response.ok) return (await response.json()).node;
        } catch {}
      }
      return null;
    },
    async reset() {
      for (const id of ids) {
        fronts[id].setFault(null);
        for (const proxy of [net[id], appNet[id], agentNet[id]]) await proxy.set("pass");
        if (!nodes[id].alive()) await nodes[id].start();
        nodes[id].resume();
        await world.limits(id, { paused: false }).catch(() => {});
      }
      if (bot.isDown()) await bot.start();
      agent.resume();
      app.resume();
      for (const target of [agent, app]) target.send({ chaos: "dns", mode: null });
    },
    async close() {
      await app.close().catch(() => {});
      await agent.stop().catch(() => {});
      for (const id of ids) { await nodes[id].kill("SIGTERM"); await net[id].close(); await appNet[id].close(); await agentNet[id].close(); await fronts[id].close(); }
      await impostor.close();
      bot.close();
    },
  };
  return world;
}

/**
 * what the person's app keeps doing the whole time: a small request every half second (opening a chat, sending a
 * message) and one live event stream (replies arriving), reconnecting a second after it ends like EventSource does
 */
function createProbe(world) {
  const pings = [], gaps = [];
  let live = null, lastEventAt = 0, stopped = false, timer = null, inFlight = 0, liveReq = null;
  const port = () => Number(new URL(world.app.origin()).port);
  const host = () => world.app.host();
  function call(path, { method = "GET", body = null, timeoutMs = 8000, port: at = port(), host: name = host() } = {}) {
    return new Promise((resolve) => {
      const started = Date.now();
      const req = httpRequest({ host: "127.0.0.1", port: at, path, method, headers: { host: name, ...(body ? { "content-type": "application/octet-stream", "content-length": String(body.length) } : {}) } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), ms: Date.now() - started }));
        res.on("error", (error) => resolve({ status: 0, error: error.message, ms: Date.now() - started }));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error("no answer in time")));
      req.on("error", (error) => resolve({ status: 0, error: error.message === "no answer in time" ? "no answer in 8 s" : error.message, ms: Date.now() - started }));
      req.end(body ?? undefined);
    });
  }
  let held = false;
  const pending = new Set();
  function tick() {
    if (stopped || held || inFlight >= 16) return;
    inFlight += 1;
    const at = Date.now();
    pending.add(at);
    void call("/api/ping").then((answer) => {
      inFlight -= 1;
      pending.delete(at);
      let error = null;
      if (answer.status !== 200) {
        try { error = JSON.parse(answer.body.toString("utf8")).error ?? `status ${answer.status}`; } catch { error = answer.error ?? `status ${answer.status}`; }
      }
      pings.push({ at, done: Date.now(), ok: answer.status === 200, ms: answer.ms, error });
    });
  }
  function openLive() {
    if (stopped) return;
    const req = httpRequest({ host: "127.0.0.1", port: port(), path: "/api/events", headers: { host: host(), accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); res.on("end", () => closed("status")); return; }
      res.on("data", () => { lastEventAt = Date.now(); if (live === null) live = true; });
      res.on("end", () => closed("ended"));
      res.on("error", () => closed("error"));
      res.on("close", () => closed("closed"));
    });
    liveReq = req;
    let done = false;
    function closed() {
      if (done) return;
      done = true;
      if (live) { live = null; }
      liveReq = null;
      setTimeout(openLive, 1000).unref();
    }
    req.on("error", closed);
    req.end();
  }
  // a stream that delivers nothing for 5 s counts as down even while its socket stays open: replies would not arrive
  let downSince = null;
  const watch = setInterval(() => {
    const now = Date.now();
    const up = now - lastEventAt < 5000;
    if (!up && downSince === null) downSince = Math.max(lastEventAt, now - 5000);
    if (up && downSince !== null) { gaps.push({ from: downSince, to: now }); downSince = null; }
    if (liveReq && now - lastEventAt > 20_000 && live) { liveReq.destroy(); }
  }, 250);
  return {
    start() { timer = setInterval(tick, 500); openLive(); },
    /** while the laptop sleeps nothing on it runs, so nothing is measured */
    hold() { held = true; },
    release() { held = false; },
    stop() { stopped = true; clearInterval(timer); clearInterval(watch); liveReq?.destroy(); },
    call,
    pings,
    gaps: () => (downSince === null ? gaps : [...gaps, { from: downSince, to: null }]),
    liveNow: () => Date.now() - lastEventAt < 5000,
    // a ping still out after 1.5 s counts against it as much as one that failed
    okNow: () => { const recent = pings.filter((ping) => ping.done > Date.now() - 2000); return recent.length > 0 && recent.every((ping) => ping.ok) && ![...pending].some((at) => at < Date.now() - 1500); },
  };
}

/** waits until requests and the live stream both work for `steadyMs`; the time it took, or null */
async function waitHealthy(probe, { limitMs = 180_000, steadyMs = 3000 } = {}) {
  const started = Date.now();
  let since = null;
  while (Date.now() - started < limitMs) {
    if (probe.okNow() && probe.liveNow()) { since ??= Date.now(); if (Date.now() - since >= steadyMs) return since - started; }
    else since = null;
    await sleep(200);
  }
  return null;
}

/** reads the probe over one scenario: when it broke, when it worked again, what the person saw */
function judge(probe, { from, cleared, to }) {
  const pings = probe.pings.filter((ping) => ping.at >= from && ping.at <= to);
  const failed = pings.filter((ping) => !ping.ok);
  const lastFail = failed.at(-1)?.done ?? null;
  const firstFail = failed[0]?.at ?? null;
  const recoveredAt = lastFail === null ? null : pings.find((ping) => ping.ok && ping.at >= lastFail)?.done ?? null;
  const gaps = probe.gaps().filter((gap) => (gap.to ?? to) >= from && gap.from <= to).map((gap) => ({ from: Math.max(gap.from, from), to: Math.min(gap.to ?? to, to) }));
  const liveDownMs = gaps.reduce((sum, gap) => sum + (gap.to - gap.from), 0);
  const longestGap = gaps.reduce((most, gap) => Math.max(most, gap.to - gap.from), 0);
  const liveBackAt = gaps.length ? Math.max(...gaps.map((gap) => gap.to)) : null;
  const errors = new Map();
  for (const ping of failed) errors.set(ping.error, (errors.get(ping.error) ?? 0) + 1);
  const back = Math.max(recoveredAt ?? 0, liveBackAt ?? 0) || null;
  const anchor = cleared ?? from;
  const slow = pings.filter((ping) => ping.ok).map((ping) => ping.ms).sort((a, b) => a - b);
  return {
    requests: pings.length, failed: failed.length,
    firstFailAfterMs: firstFail === null ? null : firstFail - from,
    recoverMs: back === null ? 0 : Math.max(0, back - anchor),
    outageMs: firstFail === null && !gaps.length ? 0 : (back ?? to) - Math.min(firstFail ?? Infinity, gaps[0]?.from ?? Infinity),
    liveDownMs, longestGapMs: longestGap,
    strip: longestGap > 4000,
    p95: slow.length ? slow[Math.floor(slow.length * 0.95)] : null,
    errors: [...errors].map(([message, count]) => `${message} (${count})`),
  };
}

function seen(verdict, extra) {
  const parts = [];
  if (!verdict.failed && !verdict.strip) parts.push("nothing");
  else {
    if (verdict.strip) parts.push(`"Reconnecting" strip ${Math.round(verdict.longestGapMs / 1000)} s`);
    if (verdict.failed) parts.push(`${verdict.failed} of ${verdict.requests} requests failed: ${verdict.errors.slice(0, 2).join("; ")}`);
  }
  if (extra) parts.push(extra);
  return parts.join("; ");
}

async function main() {
  const only = option("--only")?.split(",") ?? null;
  const quick = flag("--quick");
  const chosen = SCENARIOS.filter((scenario) => (only ? only.includes(scenario.name) : !quick || scenario.quick));
  if (!chosen.length) throw new Error(`no scenario matches; known: ${SCENARIOS.map((scenario) => scenario.name).join(", ")}`);
  say(`bringing up two nodes, a server and the app`);
  const world = await bringUp();
  const probe = createProbe(world);
  world.probe = probe;
  probe.start();
  const first = await waitHealthy(probe, { limitMs: 60_000 });
  if (first === null) {
    for (const id of world.ids) {
      const answer = await fetch(`${world.url(id)}/v1/tunnels/${world.link.id}/node`, { headers: { authorization: `Bearer ${world.link.token}` } }).then(async (r) => `${r.status} ${await r.text()}`, (e) => e.message);
      say(`${id} says: ${answer}`);
    }
    say(`app node: ${JSON.stringify(await world.app.node().catch((e) => e.message))}`);
    say(`ping: ${JSON.stringify(await probe.call("/api/ping").then((a) => ({ s: a.status, b: a.body?.toString(), e: a.error })))}`);
  }
  if (first === null) throw new Error(`the link never worked:\n${world.agent.lines.slice(-20).join("\n")}\n${world.app.lines.slice(-20).join("\n")}`);
  say(`linked (${world.link.id}), home ${await world.homeOf()}`);
  if (option("--direct") === "rtc") {
    for (let i = 0; i < 40 && !(await world.app.node()).via; i += 1) await sleep(500);
    const via = (await world.app.node()).via;
    say(`direct path: ${via ?? "not up"}`);
    if (via !== "rtc" && via !== "ssh") throw new Error(`the webrtc direct path did not come up:\n${world.app.lines.slice(-15).join("\n")}\n${world.agent.lines.slice(-15).join("\n")}`);
  }
  const rows = [];
  for (const scenario of chosen) {
    await world.reset();
    const settled = await waitHealthy(probe, { limitMs: 240_000 });
    if (settled === null) { rows.push({ name: scenario.name, title: scenario.title, pass: false, note: "the world did not get healthy before this one" }); say(`! ${scenario.name}: not healthy before start`); continue; }
    say(`> ${scenario.name}: ${scenario.title}`);
    const from = Date.now();
    let outcome = {}, error = null;
    try { outcome = (await scenario.run(world, { mark: () => Date.now() })) ?? {}; }
    catch (caught) { error = caught; }
    const cleared = outcome.clearedAt ?? null;
    // after the fault: how long until it all works again
    const healthyIn = await waitHealthy(probe, { limitMs: scenario.recoverLimitMs ?? 240_000, steadyMs: 3000 });
    const to = Date.now();
    const verdict = judge(probe, { from: outcome.from ?? from, cleared, to: healthyIn === null ? to : to - 3000 });
    const recovered = healthyIn !== null;
    const pass = !error && recovered && (outcome.pass ?? true) && (scenario.budgetMs ? verdict.recoverMs <= scenario.budgetMs : true);
    const row = { name: scenario.name, title: scenario.title, pass, recovered, ...verdict, sees: seen(verdict, outcome.sees), note: error ? `error: ${error.message}` : outcome.note ?? "", budgetMs: scenario.budgetMs ?? null, home: await world.homeOf() };
    rows.push(row);
    say(`${pass ? "ok" : "FAIL"} ${scenario.name}: recover ${(row.recoverMs / 1000).toFixed(1)} s, ${row.failed}/${row.requests} failed, live down ${(row.liveDownMs / 1000).toFixed(1)} s${row.note ? `, ${row.note}` : ""}`);
    if (!pass && verbose) say(`errors: ${row.errors.join("; ")}`);
    if (!pass && verbose) say(`agent tail:\n${world.agent.lines.slice(-25).join("\n")}\napp tail:\n${world.app.lines.slice(-25).join("\n")}`);
  }
  probe.stop();
  await world.close();
  const md = ["| scenario | result | time to recover | failed requests | live stream down | what the person sees | note |", "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.title ?? row.name} | ${row.pass ? "ok" : "FAIL"} | ${row.recovered === false ? "did not" : `${((row.recoverMs ?? 0) / 1000).toFixed(1)} s`} | ${row.failed ?? "-"}/${row.requests ?? "-"} | ${((row.liveDownMs ?? 0) / 1000).toFixed(1)} s | ${row.sees ?? ""} | ${row.note ?? ""} |`)].join("\n");
  console.log(md);
  if (option("--md")) writeFileSync(option("--md"), `${md}\n`);
  if (option("--json")) writeFileSync(option("--json"), JSON.stringify(rows, null, 2));
  process.exitCode = rows.every((row) => row.pass) ? 0 : 1;
}

// the run trusts its own throwaway ca like every process it starts, and node reads that only at start
if (!process.env.MADANI_CHAOS_DIR) {
  const dir = scratch();
  makeCerts(dir);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: "inherit", env: { ...process.env, MADANI_CHAOS_DIR: dir, NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") } });
  child.on("exit", (code) => { removeScratch(dir); process.exit(code ?? 2); });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
} else {
  process.env.MADANI_CHAOS_PARENT = String(process.pid);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));
  main().catch((error) => { console.error(error); process.exit(2); });
}
