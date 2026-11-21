// "Your Mac": while this app is linked to its own VPS, it long-polls that server for work its bots want done on this Mac,
// through the same signed-in session the app already holds there (the tunnel or the direct path). No port opens here.
//
// Open risk, by design: whoever controls the linked server can run anything on this Mac as this user while the app is
// linked and the owner's switches are on. Only the app's own vps link is followed, never a team's or another person's
// server; the server refuses any session but the owner's; MADANI_MAC_CONTROL=off turns this off on the Mac.
const MAX_RUNNING = 4;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60_000;
/** an older server without these routes, or one that says this session is not the owner's */
const REFUSED_WAIT_MS = 10 * 60_000;
const PAUSED_MS = 15_000;

/**
 * @param {{
 *   fetch: typeof fetch,
 *   name(): string,
 *   execute(job: any, io: { download(path: string): Promise<Response> }): Promise<unknown>,
 *   log?(line: string): void,
 *   wait?(ms: number, signal: AbortSignal): Promise<void>,
 *   query?(): Array<[string, string]>,
 *   ready?(): boolean,
 *   reauth?(): Promise<boolean>,
 *   open?(body: any): { job: any, wrap(outcome: unknown): unknown } | null,
 *   state?(state: "connected" | "refused" | "connecting", why?: string | null): void,
 * }} deps `query`, `ready`, `reauth`, `open` and `state` are the cloud's (cloud-mac.mjs): extra poll parameters, a
 * pause while it sleeps, signing in again on 401, the sealed job opened (null refuses it) and the outcome sealed back.
 */
export function createMacControlHost(deps) {
  const log = deps.log ?? (() => {});
  const wait = deps.wait ?? ((ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }));
  let origin = null, stop = null;
  const running = new Set();

  async function serve(target, signal) {
    let failures = 0;
    const call = (path, init = {}) => deps.fetch(`${target}${path}`, {
      ...init, redirect: "error", credentials: "include", cache: "no-store", signal,
      headers: { accept: "application/json", origin: target, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    const finish = async (job, wrap) => {
      const outcome = await deps.execute(job, { download: (path) => call(path) });
      const answer = await call(`/api/mac/self/jobs/${encodeURIComponent(job.id)}/result`, { method: "POST", body: JSON.stringify(wrap ? wrap(outcome) : outcome) }).catch(() => null);
      if (answer && !answer.ok && answer.status !== 409) log(`mac control: the server did not take a result (${answer.status})`);
    };
    let reauthed = false;
    while (!signal.aborted) {
      if (deps.ready && !deps.ready()) { await wait(PAUSED_MS, signal); continue; }
      let response;
      const params = [["name", deps.name()], ...(deps.query?.() ?? [])].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
      try { response = await call(`/api/mac/self/jobs?${params}`); }
      catch (error) {
        if (signal.aborted) return;
        failures += 1;
        if (failures === 3) log(`mac control: the server is not answering (${error?.message ?? error})`);
        await wait(Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(failures, 5)), signal);
        continue;
      }
      if (response.status === 401 && deps.reauth && !reauthed) {
        reauthed = true;
        if (await deps.reauth().catch(() => false)) continue;
      }
      if (response.status === 403 || response.status === 404 || response.status === 401 || (deps.open && (response.status === 400 || response.status === 503))) {
        const why = await response.json().then((body) => body?.error, () => null);
        log(`mac control: ${target} does not take this Mac's work (${response.status}${why ? `: ${why}` : ""}); asking again in 10 min`);
        deps.state?.("refused", typeof why === "string" ? why : null);
        await wait(REFUSED_WAIT_MS, signal);
        continue;
      }
      const body = response.ok ? await response.json().catch(() => null) : null;
      if (!body) { failures += 1; await wait(Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(failures, 5)), signal); continue; }
      failures = 0;
      reauthed = false;
      deps.state?.("connected");
      let job = body.job, wrap = null;
      if (deps.open) {
        if (!body.sealed) continue;
        let opened = null;
        try { opened = deps.open(body); } catch (error) { log(`mac control: refused a job (${error?.message ?? error})`); }
        if (!opened) continue;
        ({ job, wrap } = opened);
      }
      if (!job || typeof job.id !== "string") continue;
      const task = finish(job, wrap).catch((error) => log(`mac control: a job failed (${error?.message ?? error})`)).finally(() => running.delete(task));
      running.add(task);
      if (running.size >= MAX_RUNNING) await Promise.race(running);
    }
  }

  return {
    /** the linked server to serve, or null; called whenever the link changes */
    follow(next) {
      const target = typeof next === "string" && /^https?:\/\/[^/]+$/.test(next) ? next : null;
      if (target === origin) return;
      stop?.abort();
      stop = null;
      origin = target;
      if (!target) return;
      const abort = new AbortController();
      stop = abort;
      void serve(target, abort.signal).catch((error) => log(`mac control: ${error?.message ?? error}`));
    },
    serving: () => origin,
    close() { stop?.abort(); stop = null; origin = null; },
  };
}
