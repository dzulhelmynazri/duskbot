import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_DAILY_TOOL_CALLS, INSTALLATION_DAILY_TOOL_CALLS, REGISTRATIONS_PER_IP_DAY, registrationKey, toolCallCount } from "./budgets";
import { runHourly } from "./app-events";
import { brokerHarness, STATS_TOKEN, type Installation } from "./test-harness";

afterEach(() => vi.unstubAllGlobals());

const toolCall = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: {} } });
const day = () => new Date().toISOString().slice(0, 10);

function harness() {
  const h = brokerHarness();
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  const mcp = (owner: Installation, body: unknown) => h.call(owner, "/v1/mcp", { method: "POST", body: JSON.stringify(body) });
  const setCount = (scope: string, key: string, count: number) => h.d1.db.prepare(
    "INSERT INTO usage_counters (scope, key, day, count) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key, day) DO UPDATE SET count = excluded.count",
  ).run(scope, key, day(), count);
  const count = (scope: string, key: string) => h.d1.rows<{ count: number }>(
    "SELECT count FROM usage_counters WHERE scope = ? AND key = ? AND day = ?", scope, key, day())[0]?.count ?? 0;
  return { h, mcp, setCount, count };
}

describe("daily tool-call budget", () => {
  it("counts tools/call messages, single or batched, and nothing else", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(toolCallCount(encode(toolCall(1)))).toBe(1);
    expect(toolCallCount(encode([toolCall(1), { jsonrpc: "2.0", id: 2, method: "tools/list" }, toolCall(3)]))).toBe(2);
    expect(toolCallCount(encode({ jsonrpc: "2.0", id: 1, method: "initialize" }))).toBe(0);
    expect(toolCallCount(new TextEncoder().encode("not json"))).toBe(0);
  });

  it("refuses an installation's calls past its daily limit without reaching Composio", async () => {
    const { h, mcp, setCount, count } = harness();
    const owner = await h.install();
    expect((await mcp(owner, toolCall(1))).status).toBe(200);
    expect(count("tool_calls_installation", owner.id)).toBe(1);
    expect(count("tool_calls_account", owner.userId)).toBe(1);

    setCount("tool_calls_installation", owner.id, INSTALLATION_DAILY_TOOL_CALLS);
    const before = h.composio.callsTo("/tool_router").length;
    const refused = await mcp(owner, toolCall(2));
    expect(refused.status).toBe(429);
    const body = await refused.json() as { error: string; code: string; scope: string };
    expect(body).toMatchObject({ code: "daily_tool_budget", scope: "installation" });
    expect(body.error).toMatch(/^This computer reached today's limit/);
    expect(h.composio.callsTo("/tool_router").filter((call) => call.path.endsWith("/mcp")).length)
      .toBe(h.composio.callsTo("/tool_router").slice(0, before).filter((call) => call.path.endsWith("/mcp")).length);
    // the refused call is not counted against the account
    expect(count("tool_calls_account", owner.userId)).toBe(1);

    // listing tools is never budgeted
    expect((await mcp(owner, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(200);
  });

  it("refuses every installation of one account past the account's limit and puts back what it raised", async () => {
    const { h, mcp, setCount, count } = harness();
    const owner = await h.install();
    setCount("tool_calls_account", owner.userId, ACCOUNT_DAILY_TOOL_CALLS - 1);
    const batch = await mcp(owner, [toolCall(1), toolCall(2)]);
    expect(batch.status).toBe(429);
    expect(await batch.json()).toMatchObject({ scope: "account" });
    expect(count("tool_calls_installation", owner.id)).toBe(0);
    expect(count("tool_calls_account", owner.userId)).toBe(ACCOUNT_DAILY_TOOL_CALLS - 1);
    expect((await mcp(owner, toolCall(3))).status).toBe(200);
    expect((await mcp(owner, toolCall(4))).status).toBe(429);
  });

  it("applies a shared ceiling only when GLOBAL_DAILY_TOOL_CALLS is set", async () => {
    const { h, mcp } = harness();
    const owner = await h.install();
    (h.env as Record<string, unknown>).GLOBAL_DAILY_TOOL_CALLS = "1";
    expect((await mcp(owner, toolCall(1))).status).toBe(200);
    const refused = await mcp(owner, toolCall(2));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ scope: "global" });
  });

  it("prunes counters older than a week in the hourly job", async () => {
    const { h, setCount, count } = harness();
    h.d1.db.prepare("INSERT INTO usage_counters (scope, key, day, count) VALUES ('tool_calls_installation', 'old', '2000-01-01', 5)").run();
    setCount("tool_calls_installation", "today", 3);
    await runHourly(h.env as never);
    expect(h.d1.rows("SELECT * FROM usage_counters WHERE key = 'old'")).toHaveLength(0);
    expect(count("tool_calls_installation", "today")).toBe(3);
  });
});

describe("registration limits", () => {
  const register = (h: ReturnType<typeof brokerHarness>, ip: string, agent = "madani") =>
    h.fetch("/v1/installations", { method: "POST", body: "{}", headers: { "cf-connecting-ip": ip, "user-agent": agent } });

  it("caps new installations per address per day, whatever the user agent", async () => {
    const h = brokerHarness();
    for (let index = 0; index < REGISTRATIONS_PER_IP_DAY; index += 1) {
      expect((await register(h, "203.0.113.9", `agent-${index}`)).status).toBe(201);
    }
    const refused = await register(h, "203.0.113.9", "a-fresh-agent");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "registration_daily_limit" });
    expect((await register(h, "203.0.113.10")).status).toBe(201);
  });

  it("keys the per-minute limiter on the address alone, an IPv6 address by its /64", async () => {
    const h = brokerHarness();
    const keys: string[] = [];
    h.env.REGISTRATION_LIMITER = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } as never;
    await register(h, "203.0.113.9", "one");
    await register(h, "203.0.113.9", "two");
    expect(keys[0]).toBe(keys[1]);

    const v6 = (ip: string) => registrationKey(new Request("https://broker.test", { headers: { "cf-connecting-ip": ip } }));
    expect(v6("2001:db8:1:2:aaaa::1")).toBe(v6("2001:0db8:0001:0002:bbbb:cccc:dddd:eeee"));
    expect(v6("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(v6("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(v6("2001:db8:1:3::1")).not.toBe(v6("2001:db8:1:2::1"));
  });
});

describe("before migration 0006", () => {
  it("registers, relays tool calls and runs the hourly job without the counters table", async () => {
    const h = brokerHarness({ migrations: 5 });
    vi.stubGlobal("fetch", h.composio.fetchImpl);
    const owner = await h.install();
    expect(owner.id).toBeTruthy();
    expect((await h.call(owner, "/v1/mcp", { method: "POST", body: JSON.stringify(toolCall(1)) })).status).toBe(200);
    await expect(runHourly(h.env as never)).resolves.toBeUndefined();
  });
});

describe("usage stats", () => {
  it("gives the ops page tool calls per installation and day, registrations per address and the queue, behind the stats token", async () => {
    const { h, mcp, setCount } = harness();
    const owner = await h.install();
    expect((await mcp(owner, [toolCall(1), toolCall(2)])).status).toBe(200);
    setCount("registrations_ip", "203.0.113.9", 7);
    expect((await h.fetch("/v1/stats/usage")).status).toBe(401);
    expect((await h.fetch("/v1/stats/usage", { headers: { authorization: `Bearer ${owner.token}` } })).status).toBe(401);
    const res = await h.fetch("/v1/stats/usage?days=7", { headers: { authorization: `Bearer ${STATS_TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { days: unknown[]; installations: unknown[]; registrations: unknown[]; queue: unknown };
    expect(body.days).toEqual([{ day: day(), calls: 2 }]);
    expect(body.installations).toEqual([{ id: owner.id, machine: null, days: { [day()]: 2 } }]);
    expect(body.registrations).toEqual(expect.arrayContaining([{ ip: "203.0.113.9", day: day(), count: 7 }]));
    expect(body.queue).toEqual({ events: 0, bytes: 0 });
    expect((await h.fetch("/v1/stats/usage?days=30", { headers: { authorization: `Bearer ${STATS_TOKEN}` } })).status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(owner.token);
  });
});

describe("closed registration", () => {
  it("refuses new installations and keeps the ones that exist", async () => {
    const { h } = harness();
    const owner = await h.install();
    h.env.REGISTRATION_MODE = "closed";
    const refused = await h.fetch("/v1/installations", { method: "POST", body: "{}" });
    expect(refused.status).toBe(503);
    expect((await h.call(owner, "/v1/me")).status).toBe(200);
  });
});
