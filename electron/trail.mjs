// The debug trail: one JSON line per thing the app, its server or the cloud did, so a report can be followed exactly
// ("when I took over, was it direct or relay?"). Main and the renderer write trail.jsonl, a server trail-<src>.jsonl,
// in the logs folder; scripts/trail.mjs reads them as one timeline. Every event passes redactEvent on the way in and
// scrubForExport again on the way out of an export, so no message, typed text, secret, cookie or query string is kept.
// Writes are batched and async; nothing here may throw into its caller.
import nodeFs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { redactSecretsInLine } from "./diagnostics.mjs";

export const TRAIL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
/** the whole trail on disk, across main's and the server's files */
export const TRAIL_CAP_BYTES = { packaged: 20 * MB, dev: 50 * MB };
export const TRAIL_HEADER = "x-madani-trail";
export const TRAIL_EXPORT_PREVIEW = "App actions, connection routes, errors from the last 7 days. No messages, passwords or personal files";

const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const TRAIL_ID = /^[a-z0-9][a-z0-9_-]{5,63}$/;
const FILE = /^(trail(?:-[a-z]+)?)(?:\.(\d{10,16})(\.c)?)?\.jsonl$/;
const MAX_STRING = 300;
const MAX_KEYS = 40;
const FLUSH_MS = 400;
const FLUSH_LINES = 256;
const MAX_PENDING = 5000;

/** events cut first when the trail is near its cap: what the person clicked and where they went */
export const isVerboseEvent = (ev) => typeof ev === "string" && ev.startsWith("ui.");

// ---- redaction: applied to every event as it is made ----

const SECRET_WORDS = ["password", "passwd", "passphrase", "secret", "token", "cookie", "credential", "credentials", "authorization",
  "bearer", "apikey", "privatekey", "vault", "otp", "sdp", "signature", "sessionkey", "lease", "grant", "pin", "code"];
const CONTENT_WORDS = ["text", "content", "body", "prompt", "input", "output", "message", "messages", "typed", "query", "search",
  "draft", "clipboard", "subject", "summary", "command", "args", "arguments", "stdout", "stderr", "html", "cwd", "env", "headers"];
const norm = (key) => String(key).toLowerCase().replace(/[^a-z]/g, "");
/** a field whose string value is never kept, whatever it holds */
export function secretKey(key) {
  const k = norm(key);
  // a stable error code is the point of the field; a pairing or sign-in code is not
  if (k === "code" || k === "errcode") return false;
  return SECRET_WORDS.some((word) => k === word || k.endsWith(word) || (word.length > 4 && k.startsWith(word)));
}
/** a field that holds what a person or a bot wrote: never kept, only its length */
export function contentKey(key) {
  const k = norm(key);
  return CONTENT_WORDS.some((word) => k === word || k.endsWith(word));
}

const MASK = "«redacted»";
const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/[^\s"'<>]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// long opaque values (a key, a session id, a signed blob) with letters and digits mixed in
// (a "/" ends one, so a path keeps its other segments; a UUID is an id, not a secret)
const OPAQUE = /(?<![A-Za-z0-9_+=-])(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SECRET_PAIR = /\b(pass(?:word|wd)?|pwd|secret|token|cookie|session|auth|key|pin|otp)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi;

/** host and path of an address, never its userinfo, query or fragment */
export function urlHostPath(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "javascript:") return `${url.protocol}«…»`;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(raw).replace(/[?#].*$/, "");
  }
}

export function scrubString(value) {
  let out = String(value);
  if (out.length > 4 * MAX_STRING) out = out.slice(0, 4 * MAX_STRING);
  out = out.replace(URL_RE, (url) => urlHostPath(url)).replace(/\b(data|blob):[^\s"'<>]+/gi, "$1:«…»");
  out = redactSecretsInLine(out);
  out = out.replace(JWT, MASK).replace(OPAQUE, (found) => (UUID.test(found) ? found : MASK)).replace(EMAIL, "«email»");
  out = out.replace(SECRET_PAIR, (_m, key, sep) => `${key}${sep}${MASK}`);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

const TOOL_KEY = /^(?:tool|toolname)$/i;
const TOOL_NAME = /^[A-Za-z_][\w:.-]{0,63}$/;
const TOOL_FILE = /\.(?:m?[jt]sx?|cjs|json|jsonl|log|txt|md|png|jpe?g|gif|svg|webp|html?|css|sh|py|rb|zip|pdf|csv|xlsx?|docx?|ya?ml|toml)$/i;

/** a tool's own name ("Bash", "browser_open", "mcp__madani__get_url"), or undefined for anything else a tool field may
 * hold: a shell command, a script, a file name or a sentence is never a name */
export function toolName(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!TOOL_NAME.test(text) || TOOL_FILE.test(text)) return undefined;
  return text;
}

function redactValue(key, value, depth) {
  if (value === null || value === undefined) return value ?? undefined;
  if (TOOL_KEY.test(key) && typeof value === "string") return toolName(value) ?? "tool";
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    if (secretKey(key)) return MASK;
    if (contentKey(key)) return undefined;
    // an address-like field keeps its path, never its query or fragment, even when it has no scheme
    if (/^(?:path|route|url|href|src|target|page|location)$/i.test(key)) return scrubString(value.replace(/[?#].*$/s, ""));
    return scrubString(value);
  }
  if (value instanceof Error) return { code: typeof value.code === "string" ? scrubString(value.code) : undefined, msg: scrubString(value.message) };
  if (Array.isArray(value)) {
    if (contentKey(key) || secretKey(key)) return undefined;
    return value.slice(0, 20).map((item) => redactValue(key, item, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    if (contentKey(key) || secretKey(key) || depth >= 2) return undefined;
    return redactFields(value, depth + 1);
  }
  return undefined;
}

export function redactFields(fields, depth = 0) {
  const out = {};
  if (!fields || typeof fields !== "object") return out;
  let n = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (++n > MAX_KEYS) break;
    if (!/^[A-Za-z_][\w.-]{0,40}$/.test(key)) continue;
    if (contentKey(key) && typeof value === "string") { out[`${key}Len`] = value.length; continue; }
    const clean = redactValue(key, value, depth);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

/** a whole event, made safe: the fixed fields stay, everything else is redacted */
export function redactEvent(event) {
  if (!event || typeof event !== "object" || !EVENT_NAME.test(String(event.ev))) return null;
  const { ts, ev, src, ...rest } = event;
  const when = typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? ts : new Date().toISOString();
  return { ts: when, ev, ...(typeof src === "string" && /^[a-z-]{1,20}$/.test(src) ? { src } : {}), ...redactFields(rest) };
}

// ---- the export scrubber: a second, stricter pass over what leaves the computer ----

const KNOWN_HOSTS = /(?:^|\.)(?:madani\.bot|trycloudflare\.com|cloudflare\.com|github\.com|localhost)$/i;
const FILE_EXT = /\.(?:m?[jt]sx?|cjs|json|jsonl|log|txt|md|png|jpe?g|gif|svg|webp|html?|css|sh|py|zip|pdf|csv|ya?ml|toml|lock|node|dylib|so|dll|exe|app|plist|db|sqlite)$/i;
const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const IPV6_LIKE = /(?<![\w:.])[0-9a-f:]{3,39}(?![\w:])/gi;
// a time ("10:00:02") has two colons; an IPv6 address has "::" or at least four
const ipv6 = (found) => /[0-9a-f]/i.test(found) && (found.includes("::") || found.split(":").length > 4) ? "«ip»" : found;
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s"']+/g;
const NAME_KEY = /^(?:name|botname|botnames|username|displayname|fullname|label|owner|person|account|email|emails|hostname|computername|device|devicename)$/i;
const HOST_KEY = /^(?:host|hostname|origin|server|domain|address|node|url|target)$/i;
const ROUTE_WORDS = new Set(["direct", "relay", "cf", "cloudflare", "cloudflare-turn", "our-relay", "ssh", "wss", "rtc", "cloud", "tailscale", "local", "lan", "turn", "webrtc"]);

/** a short, stable stand-in for something that names the person's own machine */
export function hashName(value, salt = "") {
  return `h-${createHash("sha256").update(`${salt}|${String(value).toLowerCase()}`).digest("hex").slice(0, 10)}`;
}

function exportString(key, value, { home, salt }) {
  let out = scrubString(value);
  if (home && home.length > 1) out = out.split(home).join("~");
  out = out.replace(HOME_PATH, "~");
  out = out.replace(EMAIL, "«email»").replace(IPV4, "«ip»").replace(IPV6_LIKE, ipv6);
  out = out.replace(HOSTNAME, (found) => (KNOWN_HOSTS.test(found) || FILE_EXT.test(found) ? found : hashName(found, salt)));
  if (HOST_KEY.test(key) && !ROUTE_WORDS.has(out) && !out.startsWith("/") && !/^h-[0-9a-f]{10}$/.test(out) && !KNOWN_HOSTS.test(out)) {
    // a bare server name with no dot (a tailnet name, "my-mac"): hashed too
    if (/^[A-Za-z0-9._-]+$/.test(out) && !/^(?:vps|local|cloud)\/?/.test(out)) out = hashName(out, salt);
  }
  return out;
}

function exportValue(key, value, options, depth) {
  if (typeof value === "string") return NAME_KEY.test(key) ? undefined : exportString(key, value, options);
  if (Array.isArray(value)) return value.map((item) => exportValue(key, item, options, depth + 1)).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    if (depth >= 3) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (NAME_KEY.test(k)) continue;
      const clean = exportValue(k, v, options, depth + 1);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  return value;
}

/**
 * one event as it may leave this computer: redacted again, then emails, IPs, home paths, the person's own host names
 * (hashed) and anything that names a person or bot taken out. Route words (direct, relay, cf...) stay.
 * @param {unknown} event @param {{ home?: string, salt?: string }} [options]
 */
export function scrubForExport(event, options = {}) {
  const first = redactEvent(event);
  if (!first) return null;
  const { ts, ev, ...rest } = first;
  return { ts, ev, ...exportValue("", rest, { home: options.home ?? "", salt: options.salt ?? "" }, 0) };
}

// ---- ids ----

export const newTrailId = (bytes = 8) => randomBytes(bytes).toString("hex");
export const validTrailId = (value) => typeof value === "string" && TRAIL_ID.test(value);
/** what a lease or link id becomes in the trail: the same on both ends, useless to anyone holding the log */
export const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
export const RUN_ID = newTrailId(4);

// ---- the writer ----

/**
 * an append-only, rotated, capped JSONL file set: <prefix>.jsonl is written, rotated to <prefix>.<ms>.jsonl past a
 * fifth of the cap; past the cap the oldest rotated file first loses its verbose events, then goes; nothing older
 * than `days` stays.
 * @param {{ dir: string, prefix?: string, capBytes?: number, days?: number, fs?: typeof nodeFs, now?: () => number, flushMs?: number }} options
 */
export function createTrailWriter({ dir, prefix = "trail", capBytes = TRAIL_CAP_BYTES.packaged / 2, days = TRAIL_DAYS, fs = nodeFs, now = Date.now, flushMs = FLUSH_MS }) {
  const file = path.join(dir, `${prefix}.jsonl`);
  const fileCap = Math.max(256 * 1024, Math.floor(capBytes / 5));
  let pending = [];
  let pendingBytes = 0;
  let dropped = 0;
  let size = -1;
  let timer = null;
  let chain = Promise.resolve();
  let failures = 0;
  let closed = false;

  async function ready() {
    if (size >= 0) return;
    await fs.promises.mkdir(dir, { recursive: true });
    size = await fs.promises.stat(file).then((s) => s.size, () => 0);
    void prune().catch(() => {});
  }

  async function ownFiles() {
    const names = await fs.promises.readdir(dir).catch(() => []);
    const out = [];
    for (const name of names) {
      const m = FILE.exec(name);
      if (!m || m[1] !== prefix || !m[2]) continue;
      const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
      if (stat?.isFile()) out.push({ name, at: Number(m[2]), compacted: Boolean(m[3]), size: stat.size });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  async function prune() {
    const files = await ownFiles();
    const cutoff = now() - days * DAY_MS;
    let total = Math.max(size, 0);
    const kept = [];
    for (const one of files) {
      if (one.at < cutoff) await fs.promises.unlink(path.join(dir, one.name)).catch(() => {});
      else { kept.push(one); total += one.size; }
    }
    for (let guard = 0; total > capBytes && kept.length && guard < 64; guard++) {
      const oldest = kept[0];
      if (!oldest.compacted) {
        const from = path.join(dir, oldest.name);
        const text = await fs.promises.readFile(from, "utf8").catch(() => "");
        const keep = text.split("\n").filter((line) => line && !/^\{"ts":"[^"]*","ev":"ui\./.test(line)).join("\n");
        const to = path.join(dir, `${prefix}.${oldest.at}.c.jsonl`);
        await fs.promises.writeFile(to, keep ? `${keep}\n` : "").catch(() => {});
        await fs.promises.unlink(from).catch(() => {});
        const next = Buffer.byteLength(keep ? `${keep}\n` : "");
        total -= oldest.size - next;
        Object.assign(oldest, { name: path.basename(to), compacted: true, size: next });
        if (next > 0) continue;
      }
      await fs.promises.unlink(path.join(dir, oldest.name)).catch(() => {});
      total -= oldest.size;
      kept.shift();
    }
  }

  async function rotate() {
    await fs.promises.rename(file, path.join(dir, `${prefix}.${now()}.jsonl`)).catch(() => {});
    size = 0;
    await prune().catch(() => {});
  }

  async function flushNow() {
    if (!pending.length) return;
    const lines = pending;
    pending = [];
    pendingBytes = 0;
    if (dropped) { lines.push(`${JSON.stringify({ ts: new Date(now()).toISOString(), ev: "trail.dropped", src: "trail", n: dropped })}\n`); dropped = 0; }
    try {
      await ready();
      const text = lines.join("");
      const bytes = Buffer.byteLength(text);
      if (size > 0 && size + bytes > fileCap) await rotate();
      await fs.promises.appendFile(file, text, { mode: 0o600 });
      size += bytes;
      failures = 0;
    } catch {
      // a full disk or a removed folder: the trail goes quiet rather than retrying forever
      if (++failures >= 5) closed = true;
      size = -1;
    }
  }

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    chain = chain.then(flushNow, flushNow);
    return chain;
  };

  return {
    file,
    write(event) {
      if (closed) return;
      if (pending.length >= MAX_PENDING) { dropped++; return; }
      let line;
      try { line = `${JSON.stringify(event)}\n`; } catch { return; }
      pending.push(line);
      pendingBytes += line.length;
      if (pending.length >= FLUSH_LINES || pendingBytes > 256 * 1024) void flush();
      else if (!timer) { timer = setTimeout(() => void flush(), flushMs); timer.unref?.(); }
    },
    flush,
    /** at exit only: what is still queued goes out at once, without waiting on the event loop */
    flushSync() {
      if (!pending.length || closed) return;
      try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(file, pending.join(""), { mode: 0o600 }); } catch {}
      pending = [];
      pendingBytes = 0;
    },
    prune,
    close() { void flush(); closed = true; },
  };
}

/** a writer that prints each line to stdout, for a service whose logs are its output (the account service) */
export function createStdoutWriter(out = process.stdout) {
  return {
    write(event) { try { out.write(`${JSON.stringify(event)}\n`); } catch {} },
    flush: () => Promise.resolve(),
    flushSync() {},
    close() {},
  };
}

// ---- the process's trail ----

let sink = null;
let source = "app";
let context = () => null;
const early = [];

/**
 * where this process's trail goes; until called, events wait in a small buffer (tests never configure one)
 * @param {{ src: string, writer: { write(e: object): void, flush(): Promise<void>, flushSync(): void, close(): void }, context?: () => object | null }} options
 */
export function configureTrail({ src, writer, context: ctx }) {
  source = src;
  sink = writer;
  if (ctx) context = ctx;
  for (const event of early.splice(0)) sink.write({ ...event, src: event.src ?? source });
  return sink;
}

export function trailSink() { return sink; }

/** records one event; never throws */
export function trail(ev, fields = {}) {
  try {
    if (typeof ev !== "string" || !EVENT_NAME.test(ev)) return;
    const ctx = context?.() ?? null;
    const event = redactEvent({ ...ctx, ...fields, ts: typeof fields?.ts === "string" ? fields.ts : new Date().toISOString(), ev, src: fields?.src ?? source, run: RUN_ID });
    if (!event) return;
    if (sink) sink.write(event);
    else if (early.length < 200) early.push(event);
  } catch {}
}

/** a caught error with a stable code; the message is scrubbed like everything else */
export function trailError(code, error, fields = {}) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : error == null ? "" : String(error?.message ?? "");
  trail("error", { code: String(code).slice(0, 60), ...(error?.code && typeof error.code === "string" ? { errCode: error.code } : {}), msg: message, ...fields });
}

/** events another process sent (the renderer over IPC): checked one by one, stamped with where they came from */
export function trailFrom(src, events, extra = () => ({})) {
  if (!Array.isArray(events)) return 0;
  let n = 0;
  for (const raw of events.slice(0, 200)) {
    if (!raw || typeof raw !== "object" || typeof raw.ev !== "string" || !EVENT_NAME.test(raw.ev)) continue;
    const { ev, ts, src: _src, run: _run, ...fields } = raw;
    // the sender's own time keeps the timeline in order, when it is a time and a recent one
    const at = typeof ts === "string" ? Date.parse(ts) : NaN;
    const when = Number.isFinite(at) && Math.abs(Date.now() - at) < 5 * 60_000 ? { ts: new Date(at).toISOString() } : {};
    trail(ev, { ...fields, ...extra(ev, fields), ...when, src });
    n++;
  }
  return n;
}

// ---- reading ----

/** every trail file in `dir` with its first event's age, oldest first */
export async function trailFiles(dir, fs = nodeFs) {
  const names = await fs.promises.readdir(dir).catch(() => []);
  return names.filter((name) => FILE.test(name)).map((name) => {
    const m = FILE.exec(name);
    return { name, file: path.join(dir, name), at: m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER };
  }).sort((a, b) => a.at - b.at);
}

/** parsed events from every file in `dir` since `sinceMs`, in time order */
export async function readTrail(dir, { sinceMs = 0, untilMs = Infinity, fs = nodeFs } = {}) {
  const events = [];
  for (const one of await trailFiles(dir, fs)) {
    // a rotated file's name is when it ended: one that ended before the window holds nothing in it
    if (one.at !== Number.MAX_SAFE_INTEGER && one.at < sinceMs) continue;
    const text = await fs.promises.readFile(one.file, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const at = Date.parse(event?.ts);
      if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
      events.push(event);
    }
  }
  return events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
