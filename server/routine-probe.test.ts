import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRoutineProbes, feedItems, pagePrice, withProbes } from "./routine-probe.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { PublicPage } from "./wait-probes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const page = (body: string): PublicPage => ({ ok: true, url: new URL("https://example.com/"), headers: {}, body: Buffer.from(body) });
const routine = (probe: Routine["probe"]): Routine => ({ id: "r1", name: "Watch", prompt: "Tell me what changed.", target: "bot", botId: "b", runOn: "maus", enabled: true,
  schedule: { type: "interval", everyMinutes: 60, anchorAt: 0 }, durationMinutes: 30, checks: ["probe"], probe, nextRunAt: 0, createdAt: 0, updatedAt: 0 });

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), "madani-probe-"));
  dirs.push(dataDir);
  let answer: PublicPage = page("<p>hello</p>");
  const failed: string[] = [];
  const probes = createRoutineProbes({ dataDir, fetch: async () => answer, failed: (_routine, sentence) => failed.push(sentence) });
  return { probes, failed, set: (next: PublicPage) => { answer = next; } };
}

describe("probe checks", () => {
  it("wakes no model for the first reading or an unchanged page, and one run for a change, kept only once it completes", async () => {
    const h = harness();
    const r = routine({ kind: "page", url: "https://example.com/" });
    expect(await h.probes.check(r, { manual: false })).toEqual({});
    expect(await h.probes.check(r, { manual: false })).toEqual({});
    h.set(page("<p>hello <b>world</b></p><script>ignore()</script>"));
    const changed = await h.probes.check(r, { manual: false });
    expect(changed.run?.prompt).toContain("Tell me what changed.");
    expect(changed.run?.prompt).toContain("[Records from example.com, a public web page");
    expect(changed.run?.prompt).toContain("hello world");
    expect(changed.run?.prompt).not.toContain("ignore()");
    // while that run holds the change, checks read nothing
    expect(await h.probes.check(r, { manual: false })).toEqual({ held: true });
    h.probes.settled({ checkKey: changed.run!.key, status: "failed" } as RoutineRun);
    const again = await h.probes.check(r, { manual: false });
    expect(again.run).toBeDefined();
    h.probes.settled({ checkKey: again.run!.key, status: "completed" } as RoutineRun);
    expect(await h.probes.check(r, { manual: false })).toEqual({});
  });

  it("surfaces a failed read every time, and tells the person once per streak", async () => {
    const h = harness();
    const r = routine({ kind: "page", url: "https://example.com/" });
    await h.probes.check(r, { manual: false });
    h.set({ ok: false, refused: false, error: "The page answered 500." });
    expect(await h.probes.check(r, { manual: false })).toEqual({ trouble: "Couldn't check example.com: The page answered 500." });
    expect(await h.probes.check(r, { manual: false })).toEqual({ trouble: "Couldn't check example.com: The page answered 500." });
    expect(h.failed).toHaveLength(1);
    h.set(page("<p>hello</p>"));
    expect(await h.probes.check(r, { manual: false })).toEqual({});
    h.set({ ok: false, refused: false, error: "The page took too long to answer." });
    await h.probes.check(r, { manual: false });
    expect(h.failed).toHaveLength(2);
  });

  it("reads a feed's new items and a price's change", async () => {
    const h = harness();
    const feed = routine({ kind: "feed", url: "https://example.com/feed" });
    h.set(page("<rss><item><title>One</title><link>https://e.com/1</link></item></rss>"));
    await h.probes.check(feed, { manual: false });
    h.set(page("<rss><item><title>Two &amp; more</title><guid>2</guid><link>https://e.com/2</link></item><item><title>One</title><link>https://e.com/1</link></item></rss>"));
    const fresh = await h.probes.check(feed, { manual: false });
    expect(fresh.run?.prompt).toContain("found 1 new item in https://example.com/feed");
    expect(fresh.run?.prompt).toContain("Two & more · https://e.com/2");

    const price = { ...routine({ kind: "price", url: "https://shop.example/p" }), id: "r2" };
    h.set(page('<script type="application/ld+json">{"price": "129.00", "priceCurrency": "USD"}</script>'));
    await h.probes.check(price, { manual: false });
    h.set(page('<script type="application/ld+json">{"price": "119.00", "priceCurrency": "USD"}</script>'));
    expect((await h.probes.check(price, { manual: false })).run?.prompt).toContain("changed from 129.00 USD to 119.00 USD");
  });

  it("does nothing while the routine may not start a run", async () => {
    const h = harness();
    expect(await h.probes.check(routine({ kind: "page", url: "https://example.com/" }), { manual: false, hold: "backoff" })).toEqual({ held: true });
  });

  it("finds prices and feed items in plain markup", () => {
    expect(pagePrice("<span>Now only $1,299.99!</span>", "Now only $1,299.99!")).toBe("$1,299.99");
    expect(pagePrice('<meta property="product:price:amount" content="42.50">', "")).toBe("42.50");
    expect(pagePrice("<p>free</p>", "free")).toBeNull();
    expect(feedItems('<feed><entry><id>tag:1</id><title>A</title><link href="https://a"/></entry></feed>')).toEqual([{ id: "tag:1", title: "A", link: "https://a" }]);
  });

  it("sends probe routines to the probe and every other to the inner checks", async () => {
    const calls: string[] = [];
    const inner = { check: async () => { calls.push("inner"); return {}; }, release: (key: string) => calls.push(`inner:${key}`), settled: () => calls.push("inner:settled") };
    const probe = { check: async () => { calls.push("probe"); return {}; }, release: (key: string) => calls.push(`probe:${key}`), settled: () => calls.push("probe:settled") };
    const both = withProbes(inner, probe);
    await both.check(routine({ kind: "page", url: "https://x.example/" }), { manual: false });
    await both.check({ ...routine(undefined), checks: ["mail"] }, { manual: false });
    both.release("prb-1"); both.release("chk-1");
    both.settled({ checkKey: "prb-2" } as RoutineRun);
    expect(calls).toEqual(["probe", "inner", "probe:prb-1", "inner:chk-1", "probe:settled"]);
  });
});
