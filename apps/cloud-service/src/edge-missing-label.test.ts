// the public edge (edge/worker.js) and labels that map to no home: remembered per colo, and capped per client address
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { MISSES_PER_MINUTE, MISSING_TTL_S, routeFor, type EdgeEnv } from "../edge/worker.js";

const ROUTE_URL = "https://dash.example.test", DOMAIN = "desktops.example.com";
const env: EdgeEnv = { ROUTE_URL, EDGE_TOKEN: "e".repeat(40), PUBLIC_DOMAIN: DOMAIN };
afterEach(() => vi.unstubAllGlobals());

function fakeCache() {
  const entries = new Map<string, { body: string; maxAge: number }>();
  return {
    entries,
    default: {
      async match(key: Request) { const hit = entries.get(key.url); return hit ? new Response(hit.body) : undefined; },
      async put(key: Request, response: Response) {
        const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1] ?? 0);
        entries.set(key.url, { body: await response.text(), maxAge });
      },
      async delete(key: Request) { return entries.delete(key.url); },
    },
  };
}

function setup(answer: (label: string) => Response) {
  const lookups: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin !== ROUTE_URL) throw new Error(`unexpected request to ${url.href}`);
    lookups.push(url.searchParams.get("label")!);
    return answer(url.searchParams.get("label")!);
  });
  const caches = fakeCache();
  vi.stubGlobal("caches", caches);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
  return { lookups, caches, ctx, settle: () => Promise.all(pending) };
}
const label = (n: number) => `d${n.toString(16).padStart(20, "0")}`;

describe("unknown labels at the edge", () => {
  it("asks the account service once about an unknown label, then answers from the cache", async () => {
    const { lookups, caches, ctx, settle } = setup(() => new Response("{}", { status: 404 }));
    expect(await routeFor(label(1), env, ctx)).toBeNull();
    await settle();
    expect(await routeFor(label(1), env, ctx)).toBeNull();
    expect(lookups).toEqual([label(1)]);
    expect([...caches.entries.values()][0]).toEqual({ body: JSON.stringify({ missing: true }), maxAge: MISSING_TTL_S });
  });

  it("a fresh lookup still asks, and a label that gained a home replaces its missing entry", async () => {
    let known = false;
    const { lookups, ctx, settle } = setup(() => known ? Response.json({ upstream: "https://home.example", awake: true }) : new Response("{}", { status: 404 }));
    expect(await routeFor(label(2), env, ctx)).toBeNull();
    await settle();
    known = true;
    expect(await routeFor(label(2), env, ctx, { fresh: true })).toMatchObject({ upstream: "https://home.example" });
    await settle();
    expect(await routeFor(label(2), env, ctx)).toMatchObject({ upstream: "https://home.example", awake: true });
    expect(lookups).toEqual([label(2), label(2)]);
  });

  it("stops looking up made-up labels for one address past its budget, without touching others", async () => {
    const { lookups, ctx } = setup(() => new Response("{}", { status: 404 }));
    const send = (n: number, ip: string) => worker.fetch(new Request(`https://${label(n)}.${DOMAIN}/`, { headers: { "cf-connecting-ip": ip } }), env, ctx);
    for (let n = 100; n < 100 + MISSES_PER_MINUTE; n += 1) expect((await send(n, "203.0.113.7")).status).toBe(404);
    expect(lookups).toHaveLength(MISSES_PER_MINUTE);
    expect((await send(999, "203.0.113.7")).status).toBe(404);
    expect(lookups).toHaveLength(MISSES_PER_MINUTE);
    expect((await send(1000, "203.0.113.8")).status).toBe(404);
    expect(lookups).toHaveLength(MISSES_PER_MINUTE + 1);
  });

  it("says a deleted home is gone, for good, so apps stop asking: 410 with the power header, remembered like a missing label", async () => {
    const { lookups, caches, ctx, settle } = setup(() => Response.json({ error: "gone" }, { status: 410 }));
    const send = () => worker.fetch(new Request(`https://${label(7)}.${DOMAIN}/api/events`, { headers: { origin: "capacitor://localhost" } }), env, ctx);
    const first = await send();
    expect(first.status).toBe(410);
    expect(first.headers.get("x-madani-cloud-power")).toBe("gone");
    expect(first.headers.get("access-control-expose-headers")).toContain("x-madani-cloud-power");
    await settle();
    expect([...caches.entries.values()][0]).toEqual({ body: JSON.stringify({ missing: true, gone: true }), maxAge: MISSING_TTL_S });
    expect((await send()).status).toBe(410);
    expect(lookups).toEqual([label(7)]);
  });
});
