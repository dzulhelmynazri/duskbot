import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_TIMEOUTS, ConnectFlow, INSTALL_POLL_MS, LOST_AFTER, POLL_MS, connectsInApp, loopbackOf, type ConnectDeps, type ConnectInstance, type ConnectState } from "./connect-flow";

type Route = (init?: { method?: string; body?: string; signal?: AbortSignal }) => unknown;

const codex = (snapshot: ConnectInstance["snapshot"], extra: Partial<ConnectInstance> = {}): ConnectInstance => ({
  instanceId: "codex", driverKind: "codex", snapshot, authentication: { method: "device-code" }, install: { server: { standalone: { downloadBytes: 40 * 1024 * 1024 } } }, ...extra,
});
const plan = (snapshot: ConnectInstance["snapshot"]): ConnectInstance => ({
  instanceId: "chatgpt", driverKind: "codex", snapshot, authentication: { method: "browser-pkce" }, install: { server: {} },
});
const waking = () => Object.assign(new Error("My Cloud is waking up"), { status: 503, body: { error: "waking" } });
const refused = () => Object.assign(new Error("Continue with ChatGPT on the computer running madani bot."), { status: 403, body: {} });

function harness(lists: Array<ConnectInstance[] | (() => ConnectInstance[])>, routes: Record<string, Route>, extra: Partial<ConnectDeps> = {}) {
  const calls: string[] = [];
  const trail: Array<[string, Record<string, unknown>]> = [];
  const opened: string[] = [];
  let read = 0;
  const deps: ConnectDeps = {
    api: async (path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      const key = Object.keys(routes).find((pattern) => `${init?.method ?? "GET"} ${path}`.startsWith(pattern));
      if (!key) throw new Error(`unrouted ${path}`);
      const answer = routes[key]!(init);
      return (answer instanceof Promise ? answer : Promise.resolve(answer)) as never;
    },
    refresh: async () => {
      const next = lists[Math.min(read++, lists.length - 1)]!;
      return typeof next === "function" ? next() : next;
    },
    open: async (link) => { opened.push(link); return true; },
    trail: (ev, fields) => { trail.push([ev, fields]); },
    ...extra,
  };
  const flow = new ConnectFlow(deps);
  const seen: ConnectState["stage"][] = [];
  flow.subscribe((state) => { if (seen.at(-1) !== state.stage) seen.push(state.stage); });
  return { flow, calls, trail, opened, seen };
}

const never = (init?: { signal?: AbortSignal }) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
const device = { auth: { phase: "waiting", flowId: "f1", authorizationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-12345" } };
const target = { tile: "chatgpt", candidates: ["chatgpt", "codex"] };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("connect flow stages", () => {
  it("reuses a login that already works without starting a sign-in", async () => {
    const { flow, calls, seen, trail } = harness([[plan({ state: "available", authenticated: false }), codex({ state: "available", authenticated: true })]], {});
    flow.start(target);
    await vi.runAllTimersAsync();
    expect(flow.state).toEqual({ stage: "connected", reused: true });
    expect(seen).toEqual(["preparing", "connected"]);
    expect(calls).toEqual([]);
    expect(trail.find(([ev]) => ev === "connect.done")?.[1]).toMatchObject({ tile: "chatgpt", reused: true });
  });

  it("installs a missing helper, shows the device code without opening the page, waits for it and confirms", async () => {
    let signedIn = false;
    const { flow, seen, opened, calls } = harness([
      [codex({ state: "unavailable", reason: "codex CLI not found" })],
      [codex({ state: "available", authenticated: false })],
      () => [codex({ state: "available", authenticated: signedIn })],
    ], {
      "POST /api/instances/codex/install": () => ({ instances: [] }),
      "POST /api/instances/codex/auth/start": () => device,
      "GET /api/instances/codex/auth/status": () => ({ auth: { phase: signedIn ? "succeeded" : "waiting" } }),
    });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "waiting", kind: "device", code: "ABCD-12345", link: "https://auth.openai.com/codex/device", opened: false });
    expect(opened, "the code shows first; the page opens from Copy code and open").toEqual([]);
    signedIn = true;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(seen).toEqual(["preparing", "installing", "opening", "waiting", "confirming", "connected"]);
    expect(flow.state).toEqual({ stage: "connected", reused: false });
    expect(calls.filter((call) => call.includes("/install"))).toHaveLength(1);
  });

  it("reads the install's measured progress while it runs and stops asking once it ends", async () => {
    let finish!: () => void;
    const readings = [null, { phase: "download", received: 100, total: 400 }, { phase: "setup", received: 400, total: 400 }];
    let read = 0;
    const { flow, calls } = harness([
      [codex({ state: "unavailable", reason: "codex CLI not found" })],
      [codex({ state: "available", authenticated: true })],
    ], {
      "POST /api/instances/codex/install": () => new Promise((resolve) => { finish = () => resolve({ instances: [] }); }),
      "GET /api/instances/codex/install": () => ({ progress: readings[Math.min(read++, readings.length - 1)] }),
    });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "installing", progress: null });
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS * 2);
    expect(flow.state).toMatchObject({ stage: "installing", progress: { phase: "download", received: 100, total: 400 } });
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS);
    expect(flow.state).toMatchObject({ stage: "installing", progress: { phase: "setup" } });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    const asked = calls.filter((call) => call === "GET /api/instances/codex/install").length;
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS * 5);
    expect(calls.filter((call) => call === "GET /api/instances/codex/install")).toHaveLength(asked);
    expect(flow.state).toEqual({ stage: "connected", reused: false });
  });

  it("keeps the elapsed-time fallback against a server with no progress reading", async () => {
    const { flow, calls } = harness([[codex({ state: "unavailable", reason: "codex CLI not found" })]], {
      "POST /api/instances/codex/install": never,
      "GET /api/instances/codex/install": () => Promise.reject(Object.assign(new Error("not found"), { status: 404 })),
    });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS * 5);
    expect(calls.filter((call) => call === "GET /api/instances/codex/install")).toHaveLength(1);
    expect(flow.state).toMatchObject({ stage: "installing", progress: null });
    flow.cancel();
  });

  it("says how big the official helper is while it downloads", async () => {
    const { flow } = harness([[codex({ state: "unavailable", reason: "codex CLI not found" })]], { "POST /api/instances/codex/install": never });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "installing", downloadBytes: 40 * 1024 * 1024 });
  });

  it("never downloads again while the server is still reading the status", async () => {
    const { flow, calls } = harness([
      [codex({ state: "unavailable", reason: "Checking engine status" })],
      [codex({ state: "available", authenticated: false })],
    ], { "POST /api/instances/codex/auth/start": () => device, "GET /api/instances/codex/auth/status": () => ({ auth: { phase: "waiting" } }) });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flow.state.stage).toBe("waiting");
    expect(calls.some((call) => call.includes("/install"))).toBe(false);
  });

  it("falls back to the code sign-in when the ChatGPT plan sign-in is refused on this machine", async () => {
    const { flow, trail } = harness([[plan({ state: "available", authenticated: false }), codex({ state: "available", authenticated: false })]], {
      "POST /api/instances/chatgpt/auth/start": () => Promise.reject(refused()),
      "POST /api/instances/codex/auth/start": () => device,
      "GET /api/instances/codex/auth/status": () => ({ auth: { phase: "waiting" } }),
    });
    flow.start(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "waiting", code: "ABCD-12345" });
    expect(flow.instance).toBe("codex");
    expect(trail.some(([ev]) => ev === "connect.fallback")).toBe(true);
  });

  it("passes over an instance that can't sign in here (the ChatGPT plan on a hosted cloud)", () => {
    expect(connectsInApp(plan({ state: "unavailable", authenticated: false, authenticationUnavailableReason: "hosted" }))).toBe(false);
    expect(connectsInApp(codex({ state: "available", authenticated: false }))).toBe(true);
  });

  it("waits for a cloud that is waking, then carries on", async () => {
    let awake = false;
    const { flow, seen } = harness([() => { if (!awake) throw waking(); return [codex({ state: "available", authenticated: false })]; }],
      { "POST /api/instances/codex/auth/start": () => device, "GET /api/instances/codex/auth/status": () => ({ auth: { phase: "waiting" } }) });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state.stage).toBe("waking");
    awake = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen).toEqual(["preparing", "waking", "preparing", "opening", "waiting"]);
  });

  it("starts in the waking stage when the cloud is asleep", async () => {
    let asleep = true;
    const { flow } = harness([[codex({ state: "available", authenticated: true })]], {}, { waking: () => asleep });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state.stage).toBe("waking");
    asleep = false;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(flow.state).toEqual({ stage: "connected", reused: true });
  });

  it("keeps the link to copy when the browser would not open", async () => {
    const { flow } = harness([[plan({ state: "available", authenticated: false })]], {
      "POST /api/instances/chatgpt/auth/start": () => ({ auth: { phase: "waiting", flowId: "f2", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?x=1" } }),
      "GET /api/instances/chatgpt/auth/status": () => ({ auth: { phase: "waiting" } }),
    }, { open: async () => false });
    flow.start({ tile: "chatgpt", candidates: ["chatgpt"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "waiting", kind: "browser", opened: false, link: "https://auth.openai.com/api/accounts/authorize?x=1" });
  });

  it("takes a pasted code back for Claude", async () => {
    let done = false;
    const { flow, calls } = harness([
      [{ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false }, authentication: { method: "paste-code" } }],
      () => [{ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: done } }],
    ], {
      "POST /api/instances/claude/auth/start": () => ({ auth: { phase: "waiting", flowId: "c1", authorizationUrl: "https://claude.ai/oauth/authorize?x=1" } }),
      "POST /api/instances/claude/auth/complete": () => { done = true; return { ok: true }; },
    });
    flow.start({ tile: "claude", candidates: ["claude"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "waiting", kind: "paste" });
    flow.submit(" CODE#123 ");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain("POST /api/instances/claude/auth/complete");
    expect(flow.state.stage).toBe("connected");
  });

  it("keeps the paste box with the server's reason when it turns a pasted code away, and takes another", async () => {
    let done = false;
    let tries = 0;
    const { flow, calls } = harness([
      [{ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false }, authentication: { method: "paste-code" } }],
      () => [{ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: done } }],
    ], {
      "POST /api/instances/claude/auth/start": () => ({ auth: { phase: "waiting", flowId: "c1", authorizationUrl: "https://claude.ai/oauth/authorize?x=1" } }),
      "POST /api/instances/claude/auth/complete": () => {
        tries += 1;
        if (tries === 1) throw Object.assign(new Error("Paste the whole code shown on Anthropic's page after signing in."), { status: 400 });
        done = true;
        return { ok: true };
      },
    });
    flow.start({ tile: "claude", candidates: ["claude"] });
    await vi.advanceTimersByTimeAsync(0);
    flow.submit("bad");
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "waiting", kind: "paste", flowId: "c1", problem: "Paste the whole code shown on Anthropic's page after signing in." });
    flow.submit("GOODCODE#123");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call === "POST /api/instances/claude/auth/complete")).toHaveLength(2);
    expect(flow.state.stage).toBe("connected");
  });

  it("one at a time: starting another cancels the sign-in under way on the server", async () => {
    const { flow, calls, seen } = harness([[codex({ state: "available", authenticated: false }), { ...codex({ state: "available", authenticated: false }), instanceId: "githubCopilot", driverKind: "copilotAgent" }]], {
      "POST /api/instances/codex/auth/start": () => device,
      "GET /api/instances/codex/auth/status": () => ({ auth: { phase: "waiting" } }),
      "POST /api/instances/codex/auth/cancel": () => ({ ok: true }),
      "POST /api/instances/githubCopilot/auth/start": () => ({ auth: { phase: "waiting", flowId: "g1", authorizationUrl: "https://github.com/login/device", userCode: "WXYZ-1234" } }),
      "GET /api/instances/githubCopilot/auth/status": () => ({ auth: { phase: "waiting" } }),
    });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    flow.start({ tile: "copilot", candidates: ["githubCopilot"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain("POST /api/instances/codex/auth/cancel");
    expect(flow.state).toMatchObject({ stage: "waiting", code: "WXYZ-1234", link: "https://github.com/login/device" });
    expect(flow.target?.tile).toBe("copilot");
    expect(seen.at(-1)).toBe("waiting");
  });

  it("cancel leaves nothing running", async () => {
    const { flow, trail } = harness([[codex({ state: "unavailable", reason: "codex CLI not found" })]], { "POST /api/instances/codex/install": never });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    flow.cancel();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUTS.installing * 2);
    expect(flow.state).toEqual({ stage: "idle" });
    expect(trail.some(([ev]) => ev === "connect.timeout")).toBe(false);
    expect(trail.find(([ev]) => ev === "connect.cancel")?.[1]).toMatchObject({ stage: "installing" });
  });
});

describe("an AI installed by its vendor's own script (Cursor)", () => {
  const cursor = (snapshot: ConnectInstance["snapshot"]): ConnectInstance => ({
    instanceId: "cursor", driverKind: "cursorAgent", snapshot, authentication: { method: "device-code" }, install: { server: { script: true } },
  });
  const cursorTarget = { tile: "cursor", candidates: ["cursor"] };
  const cursorCode = { auth: { phase: "waiting", flowId: "c1", authorizationUrl: "https://cursor.com/loginDeepControl?challenge=x", userCode: undefined } };

  it("connects in the app once the server can run the script", () => {
    expect(connectsInApp(cursor({ state: "unavailable", reason: "`cursor-agent` CLI not found" }))).toBe(true);
    expect(connectsInApp({ ...cursor({ state: "unavailable", reason: "`cursor-agent` CLI not found" }), install: {} })).toBe(false);
  });

  it("installs on the bots' computer and goes straight into sign-in", async () => {
    const { flow, seen, calls } = harness([
      [cursor({ state: "unavailable", reason: "`cursor-agent` CLI not found" })],
      [cursor({ state: "available", authenticated: false })],
    ], {
      "POST /api/instances/cursor/install": () => ({ instances: [] }),
      "POST /api/instances/cursor/auth/start": () => cursorCode,
      "GET /api/instances/cursor/auth/status": () => ({ auth: { phase: "waiting" } }),
    });
    flow.start(cursorTarget);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["preparing", "installing", "opening", "waiting"]);
    expect(flow.state).toMatchObject({ stage: "waiting", kind: "device" });
    expect(calls.filter((call) => call.endsWith("/install"))).toEqual(["POST /api/instances/cursor/install"]);
  });

  it("ends a failed install at the install step, and Try again installs again", async () => {
    let fail = true;
    const { flow, calls } = harness([
      [cursor({ state: "unavailable", reason: "`cursor-agent` CLI not found" })],
      [cursor({ state: "unavailable", reason: "`cursor-agent` CLI not found" })],
      [cursor({ state: "available", authenticated: false })],
    ], {
      "POST /api/instances/cursor/install": () => {
        if (fail) { fail = false; return Promise.reject(new Error("The installer stopped before it finished.\ncurl: (6) Could not resolve host")); }
        return { instances: [] };
      },
      "POST /api/instances/cursor/auth/start": () => cursorCode,
      "GET /api/instances/cursor/auth/status": () => ({ auth: { phase: "waiting" } }),
    });
    flow.start(cursorTarget);
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "failed", at: "installing", reason: "error" });
    flow.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state.stage).toBe("waiting");
    expect(calls.filter((call) => call.endsWith("/install"))).toHaveLength(2);
  });

  it("ends an install that runs past its deadline", async () => {
    const { flow } = harness([[cursor({ state: "unavailable", reason: "`cursor-agent` CLI not found" })]], { "POST /api/instances/cursor/install": never });
    flow.start(cursorTarget);
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "installing", downloadBytes: null });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUTS.installing + 1);
    expect(flow.state).toMatchObject({ stage: "failed", at: "installing", reason: "timeout" });
  });
});

describe("connect flow timeouts", () => {
  const stuck = (stage: keyof typeof CONNECT_TIMEOUTS, lists: ConnectInstance[][], routes: Record<string, Route>, extra: Partial<ConnectDeps> = {}) => async () => {
    const { flow, trail } = harness(lists, routes, extra);
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUTS[stage] + POLL_MS);
    expect(flow.state).toMatchObject({ stage: "failed", at: stage, reason: "timeout" });
    expect(trail.find(([ev]) => ev === "connect.timeout")?.[1]).toMatchObject({ stage, tile: "chatgpt" });
  };

  it("ends a status read that never answers", async () => {
    const { flow } = harness([], {}, { refresh: () => new Promise(() => {}) });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUTS.preparing + 1);
    expect(flow.state).toMatchObject({ stage: "failed", at: "preparing", reason: "timeout" });
  });
  it("ends a download that runs too long", stuck("installing", [[codex({ state: "unavailable", reason: "codex CLI not found" })]], { "POST /api/instances/codex/install": never }));
  it("ends a sign-in that never starts", stuck("opening", [[codex({ state: "available", authenticated: false })]], { "POST /api/instances/codex/auth/start": never }));
  it("ends a sign-in nobody finishes, and stops it on the server", async () => {
    const { flow, calls } = harness([[codex({ state: "available", authenticated: false })]], {
      "POST /api/instances/codex/auth/start": () => device,
      "GET /api/instances/codex/auth/status": () => ({ auth: { phase: "waiting" } }),
      "POST /api/instances/codex/auth/cancel": () => ({ ok: true }),
    });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUTS.waiting + POLL_MS);
    expect(flow.state).toMatchObject({ stage: "failed", at: "waiting", reason: "timeout", link: "https://auth.openai.com/codex/device" });
    expect(calls).toContain("POST /api/instances/codex/auth/cancel");
  });
  it("ends a sign-in that finished but never shows up as ready", stuck("confirming", [[codex({ state: "available", authenticated: false })]], {
    "POST /api/instances/codex/auth/start": () => ({ auth: { phase: "succeeded" } }),
  }));
  it("ends a cloud that never wakes", async () => {
    const { flow } = harness([], {}, { refresh: () => Promise.reject(waking()) });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUTS.waking + 3_000);
    expect(flow.state).toMatchObject({ stage: "failed", at: "waking", reason: "timeout" });
  });
  it("says it lost track after status checks in a row get no answer", async () => {
    const { flow } = harness([[codex({ state: "available", authenticated: false })]], {
      "POST /api/instances/codex/auth/start": () => device,
      "GET /api/instances/codex/auth/status": () => Promise.reject(new TypeError("unreachable")),
    });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(POLL_MS * LOST_AFTER + 10);
    expect(flow.state).toMatchObject({ stage: "failed", at: "waiting", reason: "lost" });
  });
  it("Try again starts over from the top", async () => {
    let start = 0;
    const { flow } = harness([[codex({ state: "available", authenticated: false })]], {
      "POST /api/instances/codex/auth/start": () => (++start === 1 ? Promise.reject(new Error("Codex could not start")) : device),
      "GET /api/instances/codex/auth/status": () => ({ auth: { phase: "waiting" } }),
    });
    flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "failed", at: "opening", reason: "error", message: "Codex could not start" });
    flow.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state.stage).toBe("waiting");
  });
});

describe("the provider's normal browser sign-in, relayed by this desktop for a remote workspace", () => {
  const claude = (authenticated: boolean): ConnectInstance => ({ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated }, authentication: { method: "paste-code" } });
  const browserLink = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback&state=s";
  const claudeStart = (sameMachine: boolean) => () => ({
    sameMachine,
    auth: { phase: "waiting", flowId: "c1", authorizationUrl: "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback", loopback: { authorizationUrl: browserLink, port: 54321, path: "/callback" } },
  });
  const fakeRelay = (portFree = true) => {
    let deliver: (url: string | null) => void = () => {};
    const log: string[] = [];
    const relay = {
      open: vi.fn(async (port: number, path: string) => { log.push(`open ${port}${path}`); return portFree; }),
      next: vi.fn(() => new Promise<string | null>((resolve) => { deliver = resolve; })),
      done: vi.fn(async (_port: number, result: { ok: boolean; location?: string | null }) => { log.push(`done ${result.ok} ${result.location ?? ""}`); }),
      close: vi.fn(async (port: number) => { log.push(`close ${port}`); }),
    };
    return { relay, log, browserReturns: (url: string) => deliver(url) };
  };

  it("Claude on a remote workspace: one click, the browser comes back here, nothing to paste", async () => {
    let done = false;
    let completeBody = "";
    const { relay, log, browserReturns } = fakeRelay();
    const { flow, opened, calls } = harness([[claude(false)], () => [claude(done)]], {
      "POST /api/instances/claude/auth/start": claudeStart(false),
      "GET /api/instances/claude/auth/status": () => ({ auth: { phase: "waiting" } }),
      "POST /api/instances/claude/auth/complete": (init) => { completeBody = init?.body ?? ""; done = true; return { ok: true, location: "https://platform.claude.com/oauth/code/success?app=claude-code" }; },
    }, { relay });
    flow.start({ tile: "claude", candidates: ["claude"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "waiting", kind: "browser", link: browserLink, code: null });
    expect(opened).toEqual([browserLink]);
    expect(log).toContain("open 54321/callback");
    browserReturns("http://localhost:54321/callback?code=fixture&state=s");
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(JSON.parse(completeBody)).toEqual({ flowId: "c1", callbackUrl: "http://localhost:54321/callback?code=fixture&state=s" });
    expect(log).toContain("done true https://platform.claude.com/oauth/code/success?app=claude-code");
    expect(flow.state).toEqual({ stage: "connected", reused: false });
    expect(calls.filter((call) => call.startsWith("POST /api/instances/claude/auth/start"))).toHaveLength(1);
  });

  it("asks the server for the browser sign-in only when this desktop can relay it", async () => {
    const bodies: string[] = [];
    const { flow } = harness([[claude(false)]], {
      "POST /api/instances/claude/auth/start": (init) => { bodies.push(init?.body ?? ""); return claudeStart(false)(); },
    });
    flow.start({ tile: "claude", candidates: ["claude"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(bodies[0]!)).toEqual({ browser: false });
    expect(flow.state).toMatchObject({ stage: "waiting", kind: "paste" });
  });

  it("on the same machine the browser reaches the CLI directly, with no relay", async () => {
    const { relay, log } = fakeRelay();
    const { flow, opened } = harness([[claude(false)]], {
      "POST /api/instances/claude/auth/start": claudeStart(true),
      "GET /api/instances/claude/auth/status": () => ({ auth: { phase: "waiting" } }),
    }, { relay });
    flow.start({ tile: "claude", candidates: ["claude"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "waiting", kind: "browser", link: browserLink });
    expect(opened).toEqual([browserLink]);
    expect(log).toEqual([]);
  });

  it("keeps the paste fallback when this computer's port is taken", async () => {
    const { relay } = fakeRelay(false);
    const { flow } = harness([[claude(false)]], { "POST /api/instances/claude/auth/start": claudeStart(false) }, { relay });
    flow.start({ tile: "claude", candidates: ["claude"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state).toMatchObject({ stage: "waiting", kind: "paste" });
  });

  it("ChatGPT on a remote workspace signs in on ChatGPT's own page, and gets a device code if the port is taken here", async () => {
    const codexBrowser = { sameMachine: false, auth: { phase: "waiting", flowId: "b1", authorizationUrl: "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback", loopback: { authorizationUrl: "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback", port: 1455, path: "/auth/callback" } } };
    const routes = (bodies: string[]) => ({
      "POST /api/instances/codex/auth/start": (init?: { body?: string }) => { bodies.push(init?.body ?? ""); return JSON.parse(init?.body ?? "{}").browser ? codexBrowser : device; },
      "POST /api/instances/codex/auth/cancel": () => ({ ok: true }),
      "GET /api/instances/codex/auth/status": () => ({ auth: { phase: "waiting" } }),
    });
    const free = fakeRelay();
    const first: string[] = [];
    const one = harness([[codex({ state: "available", authenticated: false })]], routes(first), { relay: free.relay });
    one.flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(one.flow.state).toMatchObject({ stage: "waiting", kind: "browser", code: null, link: codexBrowser.auth.loopback.authorizationUrl });
    one.flow.cancel();

    const taken = fakeRelay(false);
    const second: string[] = [];
    const two = harness([[codex({ state: "available", authenticated: false })]], routes(second), { relay: taken.relay });
    two.flow.start({ tile: "chatgpt", candidates: ["codex"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.map((body) => JSON.parse(body).browser)).toEqual([true, false]);
    expect(two.calls).toContain("POST /api/instances/codex/auth/cancel");
    expect(two.flow.state).toMatchObject({ stage: "waiting", kind: "device", code: "ABCD-12345" });
  });

  describe("Gemini (Antigravity) on a remote workspace", () => {
    const gemini = (authenticated: boolean): ConnectInstance => ({ instanceId: "antigravity", driverKind: "antigravity", snapshot: { state: "available", authenticated }, authentication: { method: "browser" } });
    const googleLink = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2F&state=s";
    // what a 0.2.8 cloud answers: no loopback, no sameMachine
    const oldServer = () => ({ auth: { phase: "waiting", flowId: "g1", authorizationUrl: googleLink } });

    it("reads the loopback from the link when the server is older than the relay", () => {
      expect(loopbackOf(googleLink)).toEqual({ authorizationUrl: googleLink, port: 51121, path: "/" });
      expect(loopbackOf("https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fexample.com%2F")).toBeNull();
      expect(loopbackOf("http://127.0.0.1:51121/")).toBeNull();
    });

    it("an old cloud server still connects: the desktop listens on the link's port and hands back the 127.0.0.1 callback", async () => {
      let done = false;
      let completeBody = "";
      const { relay, log, browserReturns } = fakeRelay();
      const { flow, opened } = harness([[gemini(false)], () => [gemini(done)]], {
        "POST /api/instances/antigravity/auth/start": oldServer,
        "POST /api/instances/antigravity/auth/complete": (init) => { completeBody = init?.body ?? ""; done = true; return { ok: true }; },
      }, { relay });
      flow.start({ tile: "gemini", candidates: ["antigravity"] });
      await vi.advanceTimersByTimeAsync(0);
      expect(log).toContain("open 51121/");
      expect(flow.state).toMatchObject({ stage: "waiting", kind: "callback", link: googleLink });
      expect(opened).toEqual([googleLink]);
      browserReturns("http://127.0.0.1:51121/?state=s&code=fixture");
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
      expect(JSON.parse(completeBody)).toEqual({ flowId: "g1", callbackUrl: "http://127.0.0.1:51121/?state=s&code=fixture" });
      expect(flow.state).toEqual({ stage: "connected", reused: false });
    });

    it("a remote server in a browser, or a taken port here: Google's page opens and the address it lands on is pasted back", async () => {
      for (const relay of [fakeRelay(false).relay, undefined]) {
        let done = false;
        let completeBody = "";
        const { flow, opened, calls } = harness([[gemini(false)], () => [gemini(done)]], {
          "POST /api/instances/antigravity/auth/start": oldServer,
          "POST /api/instances/antigravity/auth/complete": (init) => { completeBody = init?.body ?? ""; done = true; return { ok: true }; },
        }, relay ? { relay } : {});
        flow.start({ tile: "gemini", candidates: ["antigravity"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(opened).toEqual([googleLink]);
        expect(calls).not.toContain("POST /api/instances/antigravity/auth/cancel");
        expect(flow.state).toMatchObject({ stage: "waiting", kind: "redirect", link: googleLink });
        flow.submit(" http://127.0.0.1:51121/?state=s&code=fixture ");
        await vi.advanceTimersByTimeAsync(POLL_MS * 2);
        expect(JSON.parse(completeBody)).toEqual({ flowId: "g1", callbackUrl: "http://127.0.0.1:51121/?state=s&code=fixture" });
        expect(flow.state).toEqual({ stage: "connected", reused: false });
      }
    });

    it("a redirect wait ends by itself when the sign-in reached the server without a paste", async () => {
      let done = false;
      const { flow, calls } = harness([[gemini(false)], () => [gemini(done)]], {
        "POST /api/instances/antigravity/auth/start": oldServer,
      });
      flow.start({ tile: "gemini", candidates: ["antigravity"] });
      await vi.advanceTimersByTimeAsync(0);
      expect(flow.state).toMatchObject({ stage: "waiting", kind: "redirect" });
      done = true;
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(flow.state).toEqual({ stage: "connected", reused: false });
      expect(calls.some((call) => call.includes("/auth/complete"))).toBe(false);
    });

    it("on this machine the browser reaches the CLI directly", async () => {
      const { relay, log } = fakeRelay();
      const { flow, opened } = harness([[gemini(false)]], {
        "POST /api/instances/antigravity/auth/start": () => ({ ...oldServer(), sameMachine: true }),
      }, { relay });
      flow.start({ tile: "gemini", candidates: ["antigravity"] });
      await vi.advanceTimersByTimeAsync(0);
      expect(flow.state).toMatchObject({ stage: "waiting", kind: "callback", link: googleLink });
      expect(opened).toEqual([googleLink]);
      expect(log).toEqual([]);
    });
  });
});
