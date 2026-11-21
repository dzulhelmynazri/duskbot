#!/usr/bin/env node
// the nat lab: for each network (nat kinds on either side, firewalls, a proxy, loss, a small mtu, a captive portal, a
// move to another network) it builds the network in namespaces, runs the real link service, the real agent (with sshd,
// webrtc and its cloudflare tunnel) and the app's real relay and direct code, and records which way won, how long it
// took, and how many bytes our relay carried. run as root on a throwaway linux box:
//   node apps/link-service/chaos/natlab/lab.mjs [--only a,b] [--json out.json]
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, captive, inNs, roam, sh, teardown } from "./net.mjs";
import { createRelayClient, newLinkKeys, openResult, vpsTokenOf } from "../../../../electron/vps-link-protocol.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const linkRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
const say = (line) => console.error(`${new Date().toISOString().slice(11, 19)} ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STATS = randomBytes(24).toString("hex"), TURN_SECRET = randomBytes(24).toString("hex");

function certs(dir) {
  const run = (a) => execFileSync("openssl", a, { cwd: dir, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=lab ca", "-keyout", "ca.key", "-out", "ca.pem"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=IP:198.51.100.10,IP:2001:db8:100::10,IP:198.51.100.20\nbasicConstraints=CA:FALSE\n");
  run(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=relay", "-keyout", "site.key", "-out", "site.csr"]);
  run(["x509", "-req", "-in", "site.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "ext.cnf", "-out", "site.pem"]);
}

const procs = [];
function start(ns, cmd, argv, env = {}, { ipc = false, onLine = null } = {}) {
  const child = spawn("ip", ["netns", "exec", ns, cmd, ...argv], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])] });
  const lines = [];
  const keep = (data) => { for (const line of String(data).split("\n").filter(Boolean)) { lines.push(line); onLine?.(line); if (args.includes("--verbose")) console.error(`[${ns}] ${line}`); } };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  procs.push(child);
  return { child, lines };
}
function stopAll() { for (const child of procs.splice(0)) { try { child.kill("SIGKILL"); } catch {} } sh("pkill -f 'sshd -f /tmp/natlab' ; pkill -f turnserver; pkill -f 'cloudflared tunnel'", { quiet: true }); }

const SCENARIOS = [
  { name: "home", title: "home router (port-restricted nat), vps that drops unsolicited udp", client: { nat: "restricted" }, server: { firewall: "vps" } },
  { name: "home-no-ssh", title: "home router, vps that drops udp, no ssh way (sshd closed to the link)", client: { nat: "restricted" }, server: { firewall: "vps" }, skip: ["ssh"] },
  { name: "home-no-ssh-open", title: "home router, open vps, no ssh way", client: { nat: "restricted" }, server: {}, skip: ["ssh"] },
  { name: "full-cone", title: "full-cone nat, open vps", client: { nat: "full" }, server: {} },
  { name: "symmetric-client", title: "symmetric nat on the client, vps that drops udp", client: { nat: "symmetric" }, server: { firewall: "vps" } },
  { name: "symmetric-client-open", title: "symmetric nat on the client, open vps, no ssh way", client: { nat: "symmetric" }, server: {}, skip: ["ssh"] },
  { name: "server-behind-nat", title: "home server behind port-restricted nat, client too", client: { nat: "restricted" }, server: { nat: "restricted" } },
  { name: "symmetric-both", title: "symmetric nat on both sides", client: { nat: "symmetric" }, server: { nat: "symmetric" } },
  { name: "symmetric-both-turn", title: "symmetric nat on both sides, turn offered", client: { nat: "symmetric" }, server: { nat: "symmetric" }, turn: true },
  { name: "cgnat", title: "carrier nat (port-restricted) behind the home router", client: { nat: "restricted", cgnat: "restricted" }, server: { firewall: "vps" } },
  { name: "cgnat-no-ssh", title: "carrier nat behind the home router, open vps, no ssh way", client: { nat: "restricted", cgnat: "restricted" }, server: {}, skip: ["ssh"] },
  { name: "cgnat-symmetric", title: "symmetric carrier nat behind the home router", client: { nat: "restricted", cgnat: "symmetric" }, server: { firewall: "vps" } },
  { name: "udp-blocked", title: "client network blocks udp", client: { nat: "restricted", firewall: "udp" }, server: { firewall: "vps" } },
  { name: "tcp443-only", title: "client network lets only tcp 443 out", client: { nat: "restricted", firewall: "tcp443" }, server: { firewall: "vps" } },
  { name: "https-proxy", title: "client network: only an https proxy (CONNECT)", client: { nat: "restricted", firewall: "proxy" }, server: { firewall: "vps" }, proxy: true },
  { name: "ipv6-only", title: "client on ipv6 only, no nat64", client: { v6only: true }, server: { firewall: "vps" } },
  { name: "mtu-blackhole", title: "1280 mtu on the way and icmp dropped (pmtu black hole)", client: { nat: "restricted", mtu: 1280 }, server: { firewall: "vps" } },
  { name: "captive-portal", title: "captive portal for the first 25 s", client: { nat: "restricted" }, server: { firewall: "vps" }, captive: 25_000 },
  { name: "roaming", title: "client moves to another network after it connected", client: { nat: "restricted" }, server: { firewall: "vps" }, roam: true },
];

async function scenario(spec, dir) {
  stopAll();
  const net = build({ client: spec.client, server: spec.server });
  // the root namespace (this script) reaches the lab's internet for setup
  sh("ip route replace 198.51.100.0/24 via 10.250.0.2");
  const env = { NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") };
  const relay = start("relay", process.execPath, [join(here, "relay.mjs"), dir, STATS], env);
  start("stun", "turnserver", ["-n", "--listening-port", "3478", "--listening-ip", "198.51.100.20", "--listening-ip", "2001:db8:100::20", "--relay-ip", "198.51.100.20", "--external-ip", "198.51.100.20",
    "--use-auth-secret", `--static-auth-secret=${TURN_SECRET}`, "--realm", "lab", "--no-cli", "--no-tls", "--no-dtls", "--log-file", "stdout", "--simple-log", "--no-multicast-peers", "--allow-loopback-peers"]);
  if (spec.captive) start("stun", process.execPath, ["-e", `const h=require("node:http");h.createServer((q,r)=>{r.writeHead(200,{"content-type":"text/html"});r.end("<p>sign in to the wifi</p>")}).listen(80,"198.51.100.20");require("node:net").createServer(s=>s.destroy()).listen(443,"198.51.100.20")`]);
  start("srv", process.execPath, [join(here, "bot.mjs")]);
  inNs("srv", "mkdir -p /run/sshd");
  writeFileSync("/tmp/natlab-sshd", "Port 22\nListenAddress 0.0.0.0\nListenAddress ::\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nPidFile /tmp/natlab-sshd.pid\nHostKey /etc/ssh/ssh_host_ed25519_key\nHostKey /etc/ssh/ssh_host_rsa_key\n");
  start("srv", "/usr/sbin/sshd", ["-D", "-f", "/tmp/natlab-sshd"]);
  if (spec.proxy) start("clir", process.execPath, ["-e", `const h=require("node:http"),n=require("node:net");const s=h.createServer((q,r)=>{r.writeHead(403);r.end()});s.on("connect",(q,c,head)=>{const[host,port]=q.url.split(/:(?=\\d+$)/);if(port!=="443"){c.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");return}const u=n.connect(Number(port),host.replace(/^\\[|\\]$/g,""),()=>{c.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");if(head.length)u.write(head);u.pipe(c);c.pipe(u)});u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())});s.listen(3128,"192.168.50.1")`]);
  for (let i = 0; i < 100 && !relay.lines.some((line) => line.includes("relay up")); i += 1) await sleep(200);
  await sleep(1000);

  // link: a setup session from here, the agent's own `link` in the server namespace
  const base = "https://198.51.100.10";
  const relayClient = createRelayClient({ base });
  const keys = newLinkKeys();
  const made = await relayClient.create({ verifier: keys.verifier, appPub: keys.pub });
  const home = mkdtempSync(join(tmpdir(), "natlab-srv-"));
  const agentEnv = { ...env, HOME: "/root", LINK_SERVER_PORT: "8799", MADANI_LINK_DIRECT: "on", MADANI_LINK_DIRECT_HOST: net.server, MADANI_LINK_STUN: "stun:198.51.100.20:3478",
    MADANI_LINK_NDC_DIR: repoRoot, MADANI_LINK_RTC_FETCH: "off", MADANI_RELAY_URL: "off", MADANI_LINK_SERVER_UPDATES: "off", MADANI_LINK_UPDATES: "off", MADANI_LINK_PHONES: "off", MADANI_LINK_NODES: "off" };
  sh("rm -rf /root/.config/madanibot-link");
  execFileSync("ip", ["netns", "exec", "srv", process.execPath, join(linkRoot, "agent.mjs"), "link"], { env: { ...process.env, ...agentEnv, LINK_BASE: base, LINK_ID: made.id, LINK_TOKEN: vpsTokenOf(keys.secret), LINK_NAME: "lab" }, stdio: "ignore" });
  const done = await relayClient.watch(made.id, made.watch, 0);
  const result = openResult({ id: made.id, priv: keys.priv, pub: keys.pub, vpsPub: done.vpsPub, sealed: done.sealed });
  const agent = start("srv", process.execPath, [join(linkRoot, "agent.mjs"), "tunnel"], agentEnv);
  // its cloudflare tunnel (real cloudflare, through the lab's own nat to this box's uplink) takes a few seconds
  for (let i = 0; i < 150 && !agent.lines.some((line) => line.includes("backup path at")); i += 1) await sleep(200);
  // a quick tunnel answers 530 for a while after it starts; a server's has been up for hours when its app connects
  const host = /backup path at (\S+)/.exec(agent.lines.find((line) => line.includes("backup path at")) ?? "")?.[1];
  for (let i = 0; host && i < 60; i += 1) {
    const status = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.status, () => 0);
    if (status && status !== 530 && status !== 1033) break;
    await sleep(1000);
  }

  const turn = spec.turn ? (() => {
    const username = `${Math.floor(Date.now() / 1000) + 3600}:lab`;
    const credential = execFileSync("sh", ["-c", `printf '%s' '${username}' | openssl dgst -binary -sha1 -hmac '${TURN_SECRET}' | base64`]).toString().trim();
    return [{ urls: ["turn:198.51.100.20:3478?transport=udp", "turn:198.51.100.20:3478?transport=tcp"], username, credential }];
  })() : [];
  const appConfig = { base: spec.client.v6only ? "https://[2001:db8:100::10]" : base, id: made.id, key: result.tunnel.key, token: result.tunnel.token, statsToken: STATS,
    stun: [spec.client.v6only ? "stun:[2001:db8:100::20]:3478" : "stun:198.51.100.20:3478"], turn, skip: spec.skip ?? [], ...(spec.proxy ? { proxy: { host: "192.168.50.1", port: 3128 } } : {}) };
  const events = [];
  let portal = null;
  if (spec.captive) portal = captive("198.51.100.20");
  const t0 = Date.now();
  const app = start("cli", process.execPath, [join(here, "app.mjs")], { ...env, NATLAB_APP: JSON.stringify(appConfig) }, { ipc: true });
  app.child.on("message", (message) => { events.push({ at: Date.now() - t0, ...message }); if (message.log && args.includes("--verbose")) console.error(`[app] ${message.log}`); });
  if (portal) setTimeout(() => portal.release(), spec.captive).unref();
  const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end && !check()) await sleep(200); return check(); };
  await until(() => events.some((one) => one.phase === "ready"), 150_000);
  const row = { name: spec.name, title: spec.title };
  const connected = events.find((one) => one.phase === "connected"), work = events.find((one) => one.phase === "workload");
  Object.assign(row, { ways: events.findLast((one) => one.ways)?.ways ?? [], path: connected?.direct ? connected.via : "relay", connectMs: connected?.ms ?? null, rtcPair: events.findLast((one) => one.rtc)?.rtc ?? null,
    requestsOk: work?.ok ?? 0, download: work?.big ?? false, relayBytes: work?.relayBytes ?? null });
  if (spec.roam) {
    roam({ nat: "restricted" });
    const moved = Date.now();
    app.child.send({ op: "after", waitMs: 60_000 });
    await until(() => events.some((one) => one.phase === "after-workload"), 120_000);
    const back = events.find((one) => one.phase === "after-connected"), again = events.find((one) => one.phase === "after-workload");
    Object.assign(row, { afterRoam: { path: back?.direct ? back.via : "relay", ms: back ? back.at - (moved - t0) : null, relayBytes: again?.relayBytes ?? null, requestsOk: again?.ok ?? 0 } });
  }
  app.child.send?.({ op: "close" });
  row.agentTail = agent.lines.slice(-4);
  rmSync(home, { recursive: true, force: true });
  stopAll();
  return row;
}

async function main() {
  const dir = process.env.NATLAB_DIR;
  mkdirSync(join(dir, "relay-data"), { recursive: true });
  const only = option("--only")?.split(",");
  const rows = [];
  for (const spec of SCENARIOS.filter((one) => !only || only.includes(one.name))) {
    say(`> ${spec.name}: ${spec.title}`);
    try { const row = await scenario(spec, dir); rows.push(row); say(`  ${row.path}${row.rtcPair ? ` (${row.rtcPair})` : ""} in ${row.connectMs} ms, relay ${row.relayBytes} bytes, ${row.requestsOk}/20 ok${row.afterRoam ? `; after the move ${row.afterRoam.path} in ${row.afterRoam.ms} ms` : ""}`); }
    catch (error) { rows.push({ name: spec.name, title: spec.title, error: error.message.slice(0, 300) }); say(`  error ${error.message.slice(0, 300)}`); stopAll(); }
  }
  teardown();
  rmSync(dir, { recursive: true, force: true });
  if (option("--json")) writeFileSync(option("--json"), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows.map(({ agentTail: _tail, ...row }) => row)));
}
// this process trusts the lab's own ca like every one it starts, and node reads that only at start
if (!process.env.NATLAB_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "natlab-"));
  certs(dir);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: "inherit", env: { ...process.env, NATLAB_DIR: dir, NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") } });
  child.on("exit", (code) => process.exit(code ?? 2));
} else {
  process.on("SIGINT", () => { stopAll(); teardown(); process.exit(130); });
  main().catch((error) => { console.error(error); stopAll(); teardown(); process.exit(2); });
}
