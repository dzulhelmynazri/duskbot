#!/usr/bin/env node
// Reads every log we have, groups the lines by what they say (ids, numbers, addresses and times taken out), and prints
// them ranked: errors before warnings, many before few, new since the last run first among equals. A line that keeps
// coming back is a bug or a log line that lies; either way it should not sit there unread (docs/log-doctor.md).
//
//   node scripts/log-doctor.mjs                       this computer: server.log, desktop-crashes.log, the trail
//   node scripts/log-doctor.mjs --remote --since 3d   and the Oracle server and Contabo over ssh
//   node scripts/log-doctor.mjs --grep egress --samples 3
//
// --oracle / --contabo pick one remote, --remote both. --all keeps info lines too. --json prints the groups.
// --state <file> is where seen signatures are kept (new ones are marked NEW); --no-save leaves it alone.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readTrail } from "../electron/trail.mjs";
import { defaultLogDirs, parseWhen } from "./trail.mjs";

const HELP = `usage: node scripts/log-doctor.mjs [--since 2d] [--remote | --oracle | --contabo] [--dir <folder>]... [--grep <regex>]
  [--top 40] [--min 1] [--samples 1] [--all] [--json] [--state <file>] [--no-save]`;

export const ORACLE_UNITS = Object.freeze(["madanibot", "madanibot-link", "omb-docker-gate", "madani-link-node"]);
export const CONTABO_PROJECTS = Object.freeze(["madani-account", "madani-account-prod", "omb-link", "madani-preview", "madani-landing"]);
/** a request slower than this is a signature of its own (streams and long polls excepted) */
export const SLOW_MS = 3000;
const LEVEL_WEIGHT = { error: 3, warn: 2, info: 1 };

/**
 * What is already known about a signature, so the list says it instead of someone digging again. Add a line when a
 * cause is found; take it out once the fix shipped and the signature is gone.
 */
export const KNOWN = Object.freeze([
  { re: /NGHTTP2_INTERNAL_ERROR|the relay closed the stream|node \S+ is reachable/, note: "link service restarted by a deploy: relay agent, 6cfc7d6cc restarts only on a changed file" },
  { re: /local ui: could not answer \S+ \(Invalid InterceptionId/, note: "a reload cancelled the request: quiet since 2026-11-14" },
  { re: /egress: the home's public address is unknown/, note: "asked over a bare fetch: fixed 2026-11-14, asks the tunnel's node" },
  { re: /two places: this computer was not told .*fetch failed/, note: "app starting or quitting: fixed 2026-11-14" },
  { re: /one home: the top-up waits \(/, note: "waited an hour for a server still starting: fixed 2026-11-14" },
  { re: /holds the writer lease; waiting/, note: "a crashed start kept the lease: fixed 2026-11-14 (taken from a dead holder)" },
  { re: /docker gate: refused POST \/grpc|pulling docker\.io\/moby\/buildkit/, note: "a computer image build through the gate (BuildKit is refused): follows an unpublished image" },
  { re: /computer update: .* could not update yet/, note: "image tag shipped before it was published: guarded since f4a6e70bf" },
  { re: /New commit detected|Reinstalling and restarting|Restarting\.\.\./, note: "prozessor restarts the service on every deploy (a second or two of 502)" },
  { re: /pulling ghcr\.io\/madanibotai\/madani-desktop is not allowed|could not pull ghcr\.io\/madanibotai\/madani-desktop/, note: "gate older than the image rename: d31ddbf2f, lands with the next signed server build" },
  { re: /startup HTTP cache cleared \(no-persisted-version/, note: "another app copy shares this userData and rewrites last-run-version.json: not the app" },
  { re: /direct path did not connect \(connect ENETUNREACH/, note: "this network has no ipv4 route to the server (nat64): expected" },
]);

export function parseArgs(argv) {
  const out = { since: "2d", dirs: [], oracle: false, contabo: false, grep: null, top: 40, min: 1, samples: 1, all: false, json: false, state: null, save: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = () => argv[++i];
    if (arg === "--since") out.since = next();
    else if (arg === "--dir") out.dirs.push(next());
    else if (arg === "--remote") { out.oracle = true; out.contabo = true; }
    else if (arg === "--oracle") out.oracle = true;
    else if (arg === "--contabo") out.contabo = true;
    else if (arg === "--grep") out.grep = next();
    else if (arg === "--top") out.top = Number(next()) || 40;
    else if (arg === "--min") out.min = Number(next()) || 1;
    else if (arg === "--samples") out.samples = Math.max(0, Number(next()) || 0);
    else if (arg === "--all") out.all = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--state") out.state = next();
    else if (arg === "--no-save") out.save = false;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument ${arg}\n${HELP}`);
  }
  return out;
}

/** the line with what changes from one occurrence to the next taken out: ids, addresses, numbers, durations */
/** lines whose subject is a name (a bot's): one signature for all of them */
const SUBJECTS = [[/^(computer update: ).+? (could not update yet|is on the new version)/, "$1<bot> $2"]];
/** a path segment after one of these is an id */
const COLLECTIONS = /\/(tunnels|channels|sessions|workspaces|clouds|bots|accounts|machines|threads|routines|homes)\/[^/\s?)"]+/g;

export function signature(text) {
  let out = String(text);
  for (const [re, to] of SUBJECTS) out = out.replace(re, to);
  return out
    .replace(COLLECTIONS, "/$1/<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\[?\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}\]?(?=[\s,):]|$)/gi, (all) => (/[a-f]|::/i.test(all) ? "<ip>" : all))
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<h>")
    .replace(/\b(?=[a-z2-7]*[2-7])(?=[a-z2-7]*[a-z])[a-z2-7]{10,12}\b/g, "<id>")
    .replace(/\b\d+(?:\.\d+)?\s?(ms|s|m|h|d|KB|MB|GB|KiB|MiB|GiB|B)\b/g, "<n>$1")
    // an http status stays: a 502 and a 503 are different stories
    .replace(/\b\d+\b/g, (all, at, whole) => (all.length === 3 && /\b(?:http|answered|status) $/.test(whole.slice(Math.max(0, at - 9), at)) ? all : "<n>"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

/** error, warn or info, from the words a line uses */
export function levelOf(text, hint = null) {
  if (/\b(?:error|errors|failed|fail|fails|crash(?:ed)?|exited|exception|fatal|refused|denied|unreadable|killed|cannot|can't|could not)\b|\bERR_|\b5\d\d\b/i.test(text)) return "error";
  if (/\b(?:retrying|retry|retried|waits?|waiting|lost|unknown|timeout|timed out|aborted|dropped|slow|unreachable|isn't answering|did not|didn't|not answer)\b|ENOTFOUND|ECONNRESET|ENETUNREACH|ECONNREFUSED/i.test(text)) return "warn";
  return hint === "error" ? "warn" : "info";
}

/** a continuation of a stack trace or a printed object: never a signature of its own */
const NOISE = /^(?:\s*at\s|\s*[\^{}\]]+\s*$|Node\.js v|\s*(?:code|errno|syscall|address|port|requireStack|path):\s|\s*$|\s*throw err;?$|node:internal\/)/;

/** "[iso] message" (server.log, desktop-crashes.log) */
export function parseBracketed(line) {
  const match = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]\s?(.*)$/.exec(line);
  return match ? { at: Date.parse(match[1]), text: match[2] } : null;
}

/** "iso OUT|ERR message" (prozessor's per-project logs) */
export function parseProzessor(line) {
  const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(OUT|ERR)\s?(.*)$/.exec(line);
  return match ? { at: Date.parse(match[1]), text: match[3], hint: match[2] === "ERR" ? "error" : null } : null;
}

/** nginx's error.log: "2026/11/14 00:18:24 [error] pid#tid: *conn message, client: ..., server: host, ..." */
export function parseNginxError(line) {
  const match = /^(\d{4})\/(\d\d)\/(\d\d) (\d\d:\d\d:\d\d) \[(\w+)\] [^:]*: (?:\*\d+ )?(.*?)(?:, client: [^,]*)?(, server: [^,]*)?(?:, request: "(\S+) (\S+)[^"]*")?(?:,.*)?$/.exec(line);
  if (!match) return null;
  const [, y, mo, d, time, level, what, server, method, url] = match;
  const at = Date.parse(`${y}-${mo}-${d}T${time}Z`);
  const route = url ? ` ${method} ${url.split("?")[0]}` : "";
  return { at, text: `nginx ${level}: ${what}${server ?? ""}${route}`, hint: level === "error" || level === "crit" ? "error" : null };
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** nginx's access log (combined): only 5xx answers count; load tests are left out */
export function parseNginxAccess(line) {
  const match = /^\S+ \S+ \S+ \[(\d\d)\/(\w{3})\/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-]\d{4})\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"/.exec(line);
  if (!match) return null;
  const [, d, mon, y, h, mi, s, zone, method, url, status, agent] = match;
  if (!status.startsWith("5") || /loadtest|stress/i.test(agent)) return null;
  const offset = (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  const at = Date.UTC(Number(y), MONTHS[mon] ?? 0, Number(d), Number(h), Number(mi), Number(s)) - offset * 60_000;
  return { at, text: `http ${status} ${method} ${url.split("?")[0]}${/uptime/.test(agent) ? " (uptime check)" : ""}`, hint: "error" };
}

/** one journald json record (journalctl -o json) */
export function parseJournal(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  let text = record.MESSAGE;
  if (Array.isArray(text)) text = Buffer.from(text).toString("utf8");
  if (typeof text !== "string") return null;
  const unit = String(record._SYSTEMD_UNIT ?? record.UNIT ?? "?").replace(/\.service$/, "");
  return { at: Math.floor(Number(record.__REALTIME_TIMESTAMP) / 1000), text, unit };
}

/** a trail event that says something went wrong or slowly, as a line; null for the rest */
export function trailLine(event) {
  const where = String(event.path ?? "").split("?")[0].replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, "/:id");
  const what = `${event.method ? `${event.method} ` : ""}${where}`.trim();
  if (Number(event.status) >= 400) return { text: `trail ${event.ev}: ${what} answered ${event.status}`, hint: Number(event.status) >= 500 ? "error" : null };
  const streaming = /stream|events|wait|websockify/.test(String(event.kind ?? "")) || /\/events\b|\/wait\b|websockify/.test(where) || /stream\.(?:end|close)$/.test(event.ev);
  if (Number(event.ms) > SLOW_MS && !streaming) return { text: `trail ${event.ev}: slow ${what} (over ${SLOW_MS / 1000} s, via ${event.via ?? "?"})`, hint: null, warn: true };
  if (/\.(?:retry|lost|fail|failed|error|drop)$/.test(event.ev) || event.ok === false) return { text: `trail ${event.ev}: ${event.reason ?? event.msg ?? event.error ?? what}`, hint: "error" };
  return null;
}

/** lines into groups: one per source and signature, with counts, first and last seen, and a few samples */
export function group(lines, { samples = 1 } = {}) {
  const groups = new Map();
  for (const line of lines) {
    if (!line || NOISE.test(line.text)) continue;
    const sig = signature(line.text);
    if (!sig) continue;
    const key = `${line.source}\u0000${sig}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { key, source: line.source, signature: sig, level: line.warn ? "warn" : levelOf(line.text, line.hint), count: 0, first: line.at, last: line.at, samples: [] };
      groups.set(key, entry);
    }
    entry.count += 1;
    if (line.at < entry.first) entry.first = line.at;
    if (line.at > entry.last) entry.last = line.at;
    if (entry.samples.length < samples) entry.samples.push(line.text.slice(0, 400));
  }
  return [...groups.values()];
}

/** errors before warnings, many before few; a new signature counts double */
export function rank(groups, seen = null) {
  for (const entry of groups) {
    entry.new = Boolean(seen) && !seen.has(entry.key);
    entry.known = KNOWN.find((item) => item.re.test(entry.signature) || entry.samples.some((sample) => item.re.test(sample)))?.note ?? null;
    entry.score = LEVEL_WEIGHT[entry.level] * entry.count * (entry.new ? 2 : 1);
  }
  return groups.sort((a, b) => b.score - a.score || b.last - a.last);
}

function linesOf(text, parse, source, since, extra = () => ({})) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = parse(raw);
    if (line && Number.isFinite(line.at) && line.at >= since) out.push({ ...line, source, ...extra(line) });
  }
  return out;
}

/** this computer: the app's logs folder (or --dir), plain logs and the trail */
export async function readLocal(dirs, since) {
  const lines = [];
  for (const dir of dirs) {
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const name of names.filter((one) => /^(?:server|desktop-crashes|main)\.log(?:\.\d+)?$/.test(one))) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      lines.push(...linesOf(text, parseBracketed, `mac:${name.replace(/\.\d+$/, "")}`, since));
    }
    for (const event of await readTrail(dir, { sinceMs: since, untilMs: Infinity }).catch(() => [])) {
      const line = trailLine(event);
      if (line) lines.push({ ...line, at: Date.parse(event.ts), source: `mac:trail-${event.src ?? "?"}` });
    }
  }
  return lines;
}

function ssh(host, command, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command], { timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) reject(error); else resolve(stdout);
    });
  });
}

/** the Oracle server: its services' journal, read only */
export async function readOracle(since, run = ssh) {
  const units = ORACLE_UNITS.map((unit) => `-u ${unit}`).join(" ");
  const text = await run("oracle", `journalctl ${units} --since @${Math.floor(since / 1000)} --no-pager -o json --output-fields=MESSAGE,_SYSTEMD_UNIT,UNIT,__REALTIME_TIMESTAMP 2>/dev/null | tail -n 200000`);
  return linesOf(text, parseJournal, "oracle", since, (line) => ({ source: `oracle:${line.unit}` }));
}

/** Contabo: prozessor's logs of the account, link and site services, nginx's errors and its 5xx answers, read only */
export async function readContabo(since, run = ssh) {
  const day = new Date(since - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
  const marker = (name) => `echo "@@ ${name}";`;
  const projects = CONTABO_PROJECTS.map((name) => `${marker(name)} for f in /root/autorunner/logs/${name}.log-*; do d=\${f##*-}; d=\${d%.gz}; [ "$d" \\< "${day}" ] || zcat -f "$f"; done 2>/dev/null; cat /root/autorunner/logs/${name}.log 2>/dev/null;`).join(" ");
  const nginx = `${marker("nginx-error")} tail -n 50000 /var/log/nginx/error.log; ${marker("nginx-access")} cat /var/log/nginx/access.log.1 /var/log/nginx/access.log 2>/dev/null | awk '$9 ~ /^5/';`;
  const text = await run("contabo", `${projects} ${nginx}`);
  const lines = [];
  for (const part of text.split(/^@@ /m).slice(1)) {
    const at = part.indexOf("\n");
    const name = part.slice(0, at).trim(), body = part.slice(at + 1);
    const parse = name === "nginx-error" ? parseNginxError : name === "nginx-access" ? parseNginxAccess : parseProzessor;
    lines.push(...linesOf(body, parse, `contabo:${name}`, since));
  }
  return lines;
}

const DEFAULT_STATE = () => path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".cache"), "madani-log-doctor", "seen.json");

export function readSeen(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.v === 1 && value.seen && typeof value.seen === "object" ? { lastRun: value.lastRun ?? null, seen: new Map(Object.entries(value.seen)) } : null;
  } catch { return null; }
}

export function writeSeen(file, groups, previous, now = Date.now()) {
  const seen = new Map(previous?.seen ?? []);
  for (const entry of groups) if (!seen.has(entry.key)) seen.set(entry.key, now);
  // a signature not seen for 60 days is forgotten, so it is new again if it comes back
  for (const [key, at] of seen) if (now - at > 60 * 86_400_000 && !groups.some((entry) => entry.key === key)) seen.delete(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, lastRun: now, seen: Object.fromEntries(seen) }));
}

const stamp = (at) => new Date(at).toISOString().slice(5, 16).replace("T", " ");

export function formatTable(groups, { samples = 1 } = {}) {
  const rows = [];
  groups.forEach((entry, index) => {
    rows.push(`${String(index + 1).padStart(3)} ${String(entry.count).padStart(6)}  ${entry.level.padEnd(5)} ${entry.new ? "NEW " : "    "}${stamp(entry.first)} .. ${stamp(entry.last)}  ${entry.source}`);
    rows.push(`             ${entry.signature}`);
    if (entry.known) rows.push(`             known: ${entry.known}`);
    for (const sample of entry.samples.slice(0, samples)) if (sample !== entry.signature) rows.push(`             e.g. ${sample.slice(0, 200)}`);
  });
  return rows.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  const since = parseWhen(args.since);
  const dirs = args.dirs.length ? args.dirs : defaultLogDirs();
  const sources = [["this computer", () => readLocal(dirs, since)]];
  if (args.oracle) sources.push(["oracle", () => readOracle(since)]);
  if (args.contabo) sources.push(["contabo", () => readContabo(since)]);
  const lines = [];
  const read = await Promise.all(sources.map(async ([name, load]) => {
    try { const got = await load(); lines.push(...got); return `${name}: ${got.length} lines`; }
    catch (error) { return `${name}: could not be read (${String(error?.message ?? error).split("\n")[0].slice(0, 120)})`; }
  }));
  const stateFile = args.state ?? DEFAULT_STATE();
  const previous = readSeen(stateFile);
  const grep = args.grep ? new RegExp(args.grep, "i") : null;
  let groups = rank(group(lines, { samples: Math.max(1, args.samples) }), previous?.seen ?? null);
  if (args.save) writeSeen(stateFile, groups, previous);
  groups = groups.filter((entry) => (args.all || entry.level !== "info") && entry.count >= args.min && (!grep || grep.test(entry.signature) || entry.samples.some((one) => grep.test(one))));
  if (args.json) { console.log(JSON.stringify(groups.slice(0, args.top), null, 2)); return; }
  console.log(`log doctor, since ${new Date(since).toISOString()}: ${read.join("; ")}`);
  console.log(previous ? `new since the last run (${new Date(previous.lastRun).toISOString()}) are marked NEW` : "first run: nothing to compare with yet");
  console.log(`${groups.length} signatures${groups.length > args.top ? `, the top ${args.top}` : ""}:\n`);
  console.log(formatTable(groups.slice(0, args.top), { samples: args.samples }));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("scripts/log-doctor.mjs")) {
  main().catch((error) => { console.error(error?.message ?? error); process.exitCode = 1; });
}
