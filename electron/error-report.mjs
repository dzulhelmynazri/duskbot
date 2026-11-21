// errors to a sentry-compatible endpoint (sentry.io or a self-hosted glitchtip), and only when a dsn is configured.
// privacy invariant: an event carries an error's type, a scrubbed message and stack frames, the component, release and
// platform. never a request or message body, a user, breadcrumbs, cookies, headers, env values or local variables.

const MAX_MESSAGE = 200;
const MAX_FRAMES = 30;

/** `https://<public key>@host/<project id>` -> the envelope endpoint and its key, or null */
export function parseDsn(dsn) {
  if (typeof dsn !== "string" || !dsn.trim()) return null;
  let url;
  try { url = new URL(dsn.trim()); } catch { return null; }
  const project = url.pathname.replace(/^\/+|\/+$/g, "");
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || !url.username || !/^\d+$/.test(project.split("/").pop() ?? "")) return null;
  const prefix = project.split("/").slice(0, -1).join("/");
  const id = project.split("/").pop();
  return { endpoint: `${url.protocol}//${url.host}/${prefix ? `${prefix}/` : ""}api/${id}/envelope/`, key: decodeURIComponent(url.username) };
}

const SCRUB = [
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, "[key]"],
  [/\b[Bb]earer\s+[^\s"',;]+/g, "Bearer [redacted]"],
  [/\b(sk-ant-|sk-proj-|sk-|xox[abprs]-|xapp-|ghp_|github_pat_|re_|whsec_|AKIA)[A-Za-z0-9_-]{8,}/g, "[secret]"],
  [/\b([A-Za-z0-9_-]*(token|secret|password|passwd|api[_-]?key|authorization|cookie|session)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1$3[redacted]"],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "[url]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/"[^"\n]{3,}"|'[^'\n]{3,}'|`[^`\n]{3,}`|“[^”\n]{3,}”/g, "[text]"],
  [/(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s]+/g, "~"],
  [/\b\d{1,3}(\.\d{1,3}){3}\b/g, "[ip]"],
  [/\b[A-Za-z0-9_-]{24,}\b/g, "[id]"],
  [/\b\d{6,}\b/g, "[n]"],
];

/** removes secrets, addresses, quoted text (where a user's words would be) and personal paths, then trims */
export function scrubText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SCRUB) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

function frameFile(file) {
  const clean = String(file ?? "").replace(/^file:\/\//, "").replace(/\?.*$/, "").replace(/^.*\/(app\.asar|Resources)(?=\/)/, "");
  const cut = clean.search(/\/(server|dist-server|electron|src|apps|shared|assets|node_modules)\//);
  return scrubText(cut >= 0 ? clean.slice(cut + 1) : clean.split(/[/\\]/).pop());
}

/** v8 and webkit stack lines -> sentry frames, oldest first */
export function stackFrames(stack) {
  const frames = [];
  for (const line of String(stack ?? "").split("\n").slice(1)) {
    const v8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    const webkit = v8 ? null : /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/.exec(line);
    const match = v8 ?? webkit;
    if (!match) continue;
    frames.push({ function: scrubText(match[1] || "?"), filename: frameFile(match[2]), lineno: Number(match[3]), colno: Number(match[4]), in_app: !/node_modules|node:internal/.test(match[2]) });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

// getRandomValues, not randomUUID: a phone or page opened over plain http has only the former
function eventId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** the whole event: nothing else from the error or its surroundings is read */
export function errorEvent(error, context) {
  const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "non-error thrown");
  const type = /^[A-Za-z_$][\w$]{0,60}$/.test(err.name) ? err.name : "Error";
  const tags = { component: context.component };
  for (const [key, value] of Object.entries(context.tags ?? {})) if (/^[a-z][a-z0-9_.-]{0,31}$/.test(key) && /^[\w.:/-]{1,64}$/.test(String(value))) tags[key] = String(value);
  return {
    event_id: eventId(),
    timestamp: context.now() / 1000,
    platform: "javascript",
    level: context.level ?? "error",
    release: context.release,
    environment: context.environment,
    tags,
    exception: { values: [{ type, value: scrubText(err.message), stacktrace: { frames: stackFrames(err.stack) } }] },
  };
}

function envelope(event) {
  return `${JSON.stringify({ event_id: event.event_id, sent_at: new Date(event.timestamp * 1000).toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

/**
 * capture(error) never throws and never waits on the network. at most `maxPerMinute` events leave, and one error
 * (same type, message and top frame) at most once an hour. a fatal event goes to `spool` first, because the
 * process exits before a request could finish; flush() sends what an earlier run left there.
 */
export function createErrorReporter(options) {
  const target = options.enabled === false ? null : parseDsn(options.dsn);
  const now = options.now ?? Date.now;
  const send = options.fetch ?? globalThis.fetch;
  const maxPerMinute = options.maxPerMinute ?? 10;
  const seen = new Map();
  let windowStart = 0, sent = 0;
  return {
    enabled: target !== null,
    capture(error, extra = {}) {
      if (!target) return null;
      try {
        const event = errorEvent(error, { ...extra, component: options.component, release: options.release, environment: options.environment ?? "production", now });
        const top = event.exception.values[0];
        const print = `${top.type}|${top.value}|${top.stacktrace.frames.at(-1)?.filename ?? ""}:${top.stacktrace.frames.at(-1)?.lineno ?? ""}`;
        const time = now();
        if ((seen.get(print) ?? -Infinity) > time - 3_600_000) return null;
        if (time - windowStart >= 60_000) { windowStart = time; sent = 0; }
        if (++sent > maxPerMinute) return null;
        seen.set(print, time);
        if (seen.size > 500) seen.delete(seen.keys().next().value);
        if (event.level === "fatal" && options.spool) try { options.spool.append(JSON.stringify(event)); return event.event_id; } catch {}
        post(event);
        return event.event_id;
      } catch { return null; }
    },
    flush() {
      if (!target || !options.spool) return 0;
      let lines = [];
      try { lines = options.spool.take().slice(-20); } catch { return 0; }
      let count = 0;
      for (const line of lines) try { post(JSON.parse(line)); count++; } catch {}
      return count;
    },
  };
  function post(event) {
    const auth = `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=madanibot/1`;
    void Promise.resolve(send(target.endpoint, { method: "POST", headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": auth }, body: envelope(event), signal: AbortSignal.timeout(10_000) })).catch(() => {});
  }
}

/** a node process's fatal errors, rejections included; a monitor only watches, so the process still exits as before */
export function reportProcessErrors(reporter, proc = process) {
  if (reporter.enabled) proc.on("uncaughtExceptionMonitor", error => reporter.capture(error, { level: "fatal" }));
  return reporter;
}
