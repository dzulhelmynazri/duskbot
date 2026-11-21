// A server set up with the install line joins the signed-in account's dashboard by itself: the same enrollment this app
// does for this computer (account-enroll.mjs), asked of the server over this app's own owner sign-in there. The grant is
// one-time and goes straight to the server, never into the install line or its link. A server linked while signed out
// joins once the app signs in; one already on an account's dashboard stays there. Forgetting the server takes it off the
// dashboard again (asked again at the next sign-in when the account service can't be reached then).
const RETRIES = [30_000, 120_000, 600_000];
const WORKSPACE = /^ws_[A-Za-z0-9_-]{1,64}$/;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** madanibot://cloud-move/<workspace id>: the dashboard's "move to madani cloud" for a server. An id, never an address. */
export const CLOUD_MOVE_LINK = "madanibot://cloud-move/";
export function cloudMoveLinkWorkspace(value) {
  if (typeof value !== "string" || !value.startsWith(CLOUD_MOVE_LINK)) return null;
  const id = value.slice(CLOUD_MOVE_LINK.length).replace(/\/+$/, "");
  return WORKSPACE.test(id) ? id : null;
}

/**
 * @param {{
 *   client(): { enrollGrant(): Promise<{ enrollToken: string, dashboardUrl: string } | null>, unlinkWorkspace(id: string): Promise<true | null> },
 *   servers(): Array<{ id: string, key: string, name: string }>,
 *   call(id: string, method: string, route: string, body?: unknown): Promise<any>,
 *   store: { read(): unknown, write(value: unknown): void },
 *   log?(line: string): void,
 *   now?(): number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} deps `servers()`: the install-line servers saved here now (`key` the server's own environment id, so a server linked
 * again keeps its place). `call`: this app's owner session at that server.
 */
export function createServerEnroll({ client, servers, call, store, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let accountId = null, connected = false, closed = false, running = null, again = false, timer = null;
  const failures = new Map();

  function read() {
    let value = null;
    try { value = store.read(); } catch {}
    const linked = {};
    if (record(value?.linked)) for (const [key, entry] of Object.entries(value.linked)) {
      if (record(entry) && typeof entry.accountId === "string" && typeof entry.workspaceId === "string" && WORKSPACE.test(entry.workspaceId) && typeof entry.envId === "string") linked[key] = entry;
    }
    const unlink = Array.isArray(value?.unlink) ? value.unlink.filter((entry) => record(entry) && typeof entry.accountId === "string" && typeof entry.workspaceId === "string" && WORKSPACE.test(entry.workspaceId)) : [];
    return { linked, unlink };
  }
  function write(memory) {
    try { store.write({ v: 1, ...memory }); } catch (error) { log(`server enroll: could not save (${error?.message ?? error})`); }
  }
  const current = (id) => !closed && connected && accountId === id;

  function later(ms) {
    if (closed || (timer !== null)) return;
    timer = setTimer(() => { timer = null; kick(); }, ms);
    timer?.unref?.();
  }

  async function pass() {
    const id = accountId;
    if (!current(id)) return;
    for (const owed of read().unlink.filter((entry) => entry.accountId === id)) {
      if (await client().unlinkWorkspace(owed.workspaceId).catch(() => null) !== true) continue;
      const memory = read();
      memory.unlink = memory.unlink.filter((entry) => !(entry.accountId === id && entry.workspaceId === owed.workspaceId));
      write(memory);
    }
    for (const server of servers()) {
      if (!current(id)) return;
      const memory = read();
      // one already on a dashboard stays there, whichever account; the same server saved again keeps its record
      if (memory.linked[server.key]) {
        if (memory.linked[server.key].envId !== server.id) { memory.linked[server.key] = { ...memory.linked[server.key], envId: server.id }; write(memory); }
        continue;
      }
      const tried = failures.get(`${server.key}:${id}`) ?? { count: 0, at: 0 };
      if (tried.count > RETRIES.length || now() < tried.at) continue;
      try {
        const grant = await client().enrollGrant();
        if (!current(id)) return;
        if (!grant) throw new Error("no grant");
        const answer = await call(server.id, "POST", "/api/dashboard/link", { url: grant.dashboardUrl, enrollToken: grant.enrollToken });
        if (!current(id)) return;
        if (answer?.claimed !== true || typeof answer.workspaceId !== "string" || !WORKSPACE.test(answer.workspaceId)) throw new Error("unclaimed");
        const saved = read();
        saved.linked[server.key] = { accountId: id, workspaceId: answer.workspaceId, envId: server.id, at: now() };
        write(saved);
        failures.delete(`${server.key}:${id}`);
        log(`server enroll: ${server.name} joined the account dashboard`);
      } catch {
        if (!current(id)) return;
        const wait = RETRIES[tried.count];
        failures.set(`${server.key}:${id}`, { count: tried.count + 1, at: wait === undefined ? Infinity : now() + wait });
        log(`server enroll: ${server.name} did not join the account dashboard yet`);
        if (wait !== undefined) later(wait);
      }
    }
  }

  function kick() {
    if (closed) return Promise.resolve();
    if (running) { again = true; return running; }
    running = pass().catch((error) => log(`server enroll: ${error?.message ?? error}`)).finally(() => {
      running = null;
      if (again && !closed) { again = false; void kick(); }
    });
    return running;
  }

  return {
    kick,
    onState(state) {
      if (closed) return;
      const id = typeof state?.account?.id === "string" ? state.account.id : null;
      if (id !== accountId) { accountId = id; failures.clear(); }
      connected = state?.status === "connected";
      void kick();
    },
    /** The saved place a dashboard workspace is, while it is still saved here; null for any other. */
    placeFor(workspaceId) {
      const entry = Object.entries(read().linked).find(([, linked]) => linked.workspaceId === workspaceId);
      return entry && servers().some((server) => server.id === entry[1].envId) ? entry[1].envId : null;
    },
    /** The person forgot this saved server: its workspace leaves the dashboard, then the server stops reporting. */
    async forget(envId) {
      const memory = read();
      const key = Object.keys(memory.linked).find((candidate) => memory.linked[candidate].envId === envId);
      if (!key) return;
      const entry = memory.linked[key];
      delete memory.linked[key];
      write(memory);
      const gone = current(entry.accountId) ? await client().unlinkWorkspace(entry.workspaceId).catch(() => null) : null;
      if (gone !== true) {
        const owed = read();
        owed.unlink = [...owed.unlink.filter((item) => item.workspaceId !== entry.workspaceId), { accountId: entry.accountId, workspaceId: entry.workspaceId }];
        write(owed);
      }
      try { await call(envId, "DELETE", "/api/dashboard/link", {}); }
      catch { log("server enroll: the server did not hear it left the dashboard; it stops once the dashboard says so"); }
    },
    close() { closed = true; if (timer !== null) clearTimer(timer); timer = null; },
  };
}
