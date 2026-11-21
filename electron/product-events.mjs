/** The props each app event may carry. Security: values are names, routes, codes and counts only (no spaces, no free
 * text), so message content, prompts and names people type can never pass through here. */
export const APP_EVENT_PROPS = Object.freeze({
  app_open: ["kind", "platform", "appVersion"],
  app_close: ["ms"],
  app_screen: ["screen"],
  app_feature: ["feature"],
  app_messages: ["sent", "replies", "latencyMs"],
  app_error: ["kind", "code"],
  app_pair_failed: ["reason"],
  app_action: ["name"],
  app_feedback: ["score", "moment"],
});
export const MAX_QUEUE = 500;
export const BATCH = 50;
export const FLUSH_MS = 5_000;
export const MAX_BACKOFF_MS = 30 * 60_000;
const REQUEST_MS = 15_000;
const ID = /^[A-Za-z0-9_-]{16,40}$/;
const VALUE = /^[A-Za-z0-9_.:/+-]{1,120}$/;
const WORD = /^[a-z0-9_]{1,40}$/;
const EXTRA_KEY = /^[a-z][a-z_]{0,19}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;

export function cleanAppEvent(input, at = Date.now()) {
  if (!input || typeof input !== "object" || !Object.hasOwn(APP_EVENT_PROPS, input.name)) return null;
  const allowed = APP_EVENT_PROPS[input.name], props = input.props && typeof input.props === "object" ? input.props : {};
  const clean = {};
  if (input.name === "app_action") {
    if (typeof props.name !== "string" || !WORD.test(props.name)) return null;
    clean.name = props.name;
    let extras = 0;
    for (const [key, value] of Object.entries(props)) {
      if (extras >= 8) break;
      if (key === "name" || !EXTRA_KEY.test(key)) continue;
      if ((typeof value === "string" && WORD.test(value)) || (Number.isSafeInteger(value) && value >= 0 && value < 1e12) || typeof value === "boolean") {
        clean[key] = value;
        ++extras;
      }
    }
  } else {
    if (input.name === "app_feedback" && (!Number.isInteger(props.score) || props.score < 1 || props.score > 5 || typeof props.moment !== "string" || !WORD.test(props.moment))) return null;
    for (const [key, value] of Object.entries(props)) {
      if (!allowed.includes(key)) return null;
      if (typeof value === "string" && VALUE.test(value)) clean[key] = value;
      else if (Number.isSafeInteger(value) && value >= 0 && value < 1e12) clean[key] = value;
      else return null;
    }
  }
  const when = Number.isSafeInteger(input.at) && input.at > at - 7 * 86_400_000 && input.at < at + 300_000 ? input.at : at;
  return { name: input.name, at: when, props: clean };
}

/** Usage analytics leave only an installed (packaged) app, and never a CI, e2e or smoke launch: those set
 * MADANI_ANALYTICS=0 (or run with CI set), so test builds never count as installs. */
export function analyticsAllowed({ packaged, env = process.env, custom = false }) {
  const ci = typeof env.CI === "string" && env.CI !== "" && env.CI !== "0" && env.CI.toLowerCase() !== "false";
  // a verification run against preview (a custom origin) may opt in with MADANI_ANALYTICS=1; never toward madani.bot
  const asked = env.MADANI_ANALYTICS === "1" && custom === true;
  return (packaged === true || asked) && env.MADANI_ANALYTICS !== "0" && !ci;
}

/** Posts the desktop renderer's usage events to the account service from main, with this computer's account token when
 * it is signed in and the renderer's install id either way; batches, retries with backoff and keeps at most MAX_QUEUE
 * events while offline. */
export function createProductEvents({ origin, token = () => null, platform, version, fetch: fetcher = globalThis.fetch, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, enabled = true }) {
  const endpoint = `${new URL(origin).origin}/v1/app/events`;
  const app = { platform: String(platform), version: VERSION.test(String(version)) ? String(version) : "0.0.0" };
  // off (a dev, CI or smoke run): every event is dropped here, nothing is ever posted
  let queue = [], timer = null, sending = null, failures = 0, closed = !enabled;
  /** The install and session of the page's last batch: main's own events ride with them, and wait until one came. */
  let rider = null, waiting = [];

  const stop = () => { if (timer !== null) clearTimer(timer); timer = null; };
  function schedule(delay) {
    if (closed || timer !== null || sending || !queue.length) return;
    timer = setTimer(() => { timer = null; void flush(); }, delay);
    timer?.unref?.();
  }
  const backoff = () => Math.min(MAX_BACKOFF_MS, FLUSH_MS * 2 ** Math.min(failures, 20)) * (0.5 + random() / 2);

  async function post(batch) {
    const bearer = token();
    const response = await fetcher(endpoint, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ install: batch[0].install, ...(batch[0].session ? { session: batch[0].session } : {}), platform: app.platform, version: app.version, events: batch.map(item => item.event) }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    await response.body?.cancel().catch(() => {});
    return response.status;
  }
  /** the next batch: the oldest events of one install and session */
  function next() {
    const first = queue[0], batch = [];
    for (const item of queue) {
      if (batch.length === BATCH) break;
      if (item.install === first.install && item.session === first.session) batch.push(item);
    }
    return batch;
  }
  const retryable = status => status === 408 || status === 429 || status >= 500;

  async function flush() {
    stop();
    if (sending) return sending;
    sending = (async () => {
      while (queue.length) {
        const batch = next();
        let status;
        try { status = await post(batch); } catch { status = 0; }
        if (status === 0 || retryable(status)) { failures++; return false; }
        const sent = new Set(batch);
        queue = queue.filter(item => !sent.has(item));
        failures = 0;
      }
      return true;
    })();
    try { return await sending; }
    finally { sending = null; if (!closed) schedule(failures ? backoff() : FLUSH_MS); }
  }

  function enqueue() {
    if (!failures) schedule(queue.length >= BATCH ? 0 : FLUSH_MS);
    else schedule(backoff());
  }

  return {
    /** One renderer batch: `{ install, session?, events }`; anything malformed is dropped, never sent. */
    send(input) {
      if (closed || !input || typeof input !== "object" || !ID.test(input.install) || !Array.isArray(input.events)) return false;
      const session = typeof input.session === "string" && ID.test(input.session) ? input.session : null;
      const at = now();
      rider = { install: input.install, session };
      for (const event of waiting.splice(0)) queue.push({ ...rider, event });
      for (const raw of input.events.slice(0, MAX_QUEUE)) {
        const event = cleanAppEvent(raw, at);
        if (event) queue.push({ install: input.install, session, event });
      }
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
      enqueue();
      return true;
    },
    /** An `app_action` of main's own (`name`, with `props`): sent with the page's install and session, so only while the
     * page sends its own (usage analytics on); held in memory until it does. */
    action(name, props = {}, at = now()) {
      if (closed) return false;
      const event = cleanAppEvent({ name: "app_action", at, props: { ...props, name } }, now());
      if (!event) return false;
      if (!rider) { waiting.push(event); if (waiting.length > BATCH) waiting.splice(0, waiting.length - BATCH); return true; }
      queue.push({ ...rider, event });
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
      enqueue();
      return true;
    },
    /** The person switched usage analytics off: nothing queued is sent, and main's own events wait for the page again. */
    clear() { queue = []; waiting = []; rider = null; stop(); failures = 0; },
    /** The page's final batch as usage analytics goes off: everything queued is dropped, this one batch is posted once
     * with no retry, and nothing rides after it (main's own events wait for the page again). */
    async last(input) {
      queue = []; waiting = []; rider = null; stop(); failures = 0;
      if (closed || !input || typeof input !== "object" || !ID.test(input.install) || !Array.isArray(input.events)) return false;
      const session = typeof input.session === "string" && ID.test(input.session) ? input.session : null;
      const events = input.events.slice(0, BATCH).map(raw => cleanAppEvent(raw, now())).filter(Boolean);
      if (!events.length) return false;
      if (sending) await sending.catch(() => {});
      try { return (await post(events.map(event => ({ install: input.install, session, event })))) < 300; } catch { return false; }
    },
    flush,
    size: () => queue.length,
    /** the page's install id while it sends events (usage analytics on), else null */
    install: () => rider?.install ?? null,
    /** One last try at up to four batches, without retries. */
    async close() {
      if (closed) return;
      closed = true;
      stop();
      if (sending) await sending.catch(() => {});
      for (let tries = 0; queue.length && tries < 4; tries++) {
        const batch = next();
        try { await post(batch); } catch {}
        const sent = new Set(batch);
        queue = queue.filter(item => !sent.has(item));
      }
    },
  };
}
