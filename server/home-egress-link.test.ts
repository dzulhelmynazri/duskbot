import { connect, type Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { encodeBytes, encodeControl, linkReader, type EgressLinkFrame } from "../electron/egress-link-codec.mjs";
import { createHomeEgressLink as createAppLink } from "../electron/home-egress-link.mjs";
import { createHomeEgressLink, listenBoxProxy } from "./home-egress-link.ts";

describe("the egress link's records", () => {
  it("carry control frames and stream bytes across any split, and refuse what is not one", () => {
    const frames: EgressLinkFrame[] = [];
    const read = linkReader((frame) => frames.push(frame));
    const all = Buffer.concat([encodeControl({ t: "dial", r: "abcdefghijkl", host: "x.test", port: 443 }), encodeBytes("abcdefghijkl", Buffer.from("hello"))]);
    for (const byte of all) read(Buffer.from([byte]));
    expect(frames).toEqual([{ t: "dial", r: "abcdefghijkl", host: "x.test", port: 443 }, { t: "bytes", r: "abcdefghijkl", b: Buffer.from("hello") }]);
    expect(() => linkReader(() => {})(Buffer.from([9, 0, 0, 0, 0]))).toThrow(/not an egress link record/);
    expect(() => linkReader(() => {})(encodeControl({ t: "bytes", r: "abcdefghijkl" }))).toThrow(/control frame/);
    expect(() => encodeBytes("../../etc", Buffer.alloc(1))).toThrow();
  });
});

/** A link whose far end is a script standing in for the app. */
function linked(answer: (frame: EgressLinkFrame, reply: (frame: Record<string, unknown>) => void) => void, dialMs = 200) {
  const link = createHomeEgressLink({ dialMs });
  const toApp = new PassThrough(), fromApp = new PassThrough();
  const wire = Duplex.from({ readable: fromApp, writable: toApp } as never) as Duplex;
  link.attach(wire);
  const reply = (frame: Record<string, unknown>) => fromApp.write(encodeControl(frame));
  toApp.on("data", linkReader((frame) => answer(frame, reply)));
  return { link, reply, fromApp };
}

describe("a cloud home's end of the link", () => {
  it("opens nothing until the app says it takes streams, and nothing once it says goodbye", async () => {
    const { link, reply } = linked((frame, answer) => { if (frame.t === "dial") answer({ t: "dialed", r: frame.r, ok: true }); });
    expect(await link.open("x.test", 443)).toBeNull();
    reply({ t: "egress", v: 1, ready: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(link.online()).toBe(true);
    const stream = await link.open("x.test", 443);
    expect(stream).not.toBeNull();
    reply({ t: "egress", v: 1, ready: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(link.online()).toBe(false);
    expect(stream!.destroyed).toBe(true);
    expect(link.stats()).toMatchObject({ relayed: 1, fallbacks: 1, active: 0 });
  });

  it("gives up on a dial the app does not answer, so the connection goes the server's way", async () => {
    const { link, reply } = linked(() => {}, 50);
    reply({ t: "egress", v: 1, ready: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await link.open("x.test", 443)).toBeNull();
    expect(link.online()).toBe(false);
  });

  it("serves the bridge's boxes only, and answers a failure Chromium takes as DIRECT when the link cannot carry it", async () => {
    let opens = 0;
    const proxy = await listenBoxProxy({ link: { open: async () => { opens += 1; return null; } }, host: "127.0.0.1", port: 0, allowed: (address) => address === "127.0.0.1" });
    const ask = () => new Promise<Buffer>((resolve) => {
      const socket: Socket = connect(proxy.port, "127.0.0.1", () => socket.write(Buffer.from([5, 1, 0])));
      let got = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        got = Buffer.concat([got, chunk]);
        if (got.length === 2) socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, 6]), Buffer.from("x.test"), Buffer.from([1, 187])]));
      });
      socket.on("close", () => resolve(got));
    });
    expect([...await ask()]).toEqual([5, 0, 5, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(opens).toBe(1);
    await proxy.close();
    const refused = await listenBoxProxy({ link: { open: async () => { opens += 1; return null; } }, host: "127.0.0.1", port: 0, allowed: () => false });
    const closed = await new Promise<number>((resolve) => { const socket = connect(refused.port, "127.0.0.1"); let n = 0; socket.on("data", (c) => { n += c.length; }); socket.on("close", () => resolve(n)); socket.on("error", () => {}); });
    expect(closed).toBe(0);
    expect(opens).toBe(1);
    await refused.close();
  });
});

describe("the app's end for its cloud home", () => {
  const links: Array<{ close(): void }> = [];
  afterEach(() => { for (const one of links.splice(0)) one.close(); });

  function app(over: Partial<Parameters<typeof createAppLink>[0]> = {}) {
    const dials: string[] = [];
    let origin: string | null = "https://home.madani.test", awake = true, t = 0;
    const deps = {
      origin: () => origin, awake: () => awake, cookie: async () => "s=1", checkMs: 60_000, now: () => t,
      connect: async (url: string) => { dials.push(url); return { readable: new PassThrough() as unknown as Duplex, close: () => {} }; },
      endpoint: () => ({ start: () => {}, handle: () => true, close: () => {} }),
      ...over,
    };
    const link = createAppLink(deps);
    links.push(link);
    return { link, dials, set: (next: { origin?: string | null; awake?: boolean; t?: number }) => { if ("origin" in next) origin = next.origin!; if ("awake" in next) awake = next.awake!; if (next.t) t = next.t; } };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("links only while the home is awake, never waking it, and lets go when it sleeps", async () => {
    const one = app();
    one.set({ awake: false });
    one.link.check();
    await settle();
    expect(one.dials).toEqual([]);
    one.set({ awake: true });
    one.link.check();
    await settle();
    expect(one.dials).toEqual(["wss://home.madani.test/api/computer/egress/link"]);
    expect(one.link.linked()).toBe(true);
    one.set({ awake: false });
    one.link.check();
    expect(one.link.linked()).toBe(false);
  });

  it("does nothing without the app's own session there, and backs off an older home that has no such route", async () => {
    const none = app({ cookie: async () => null });
    none.link.check();
    await settle();
    expect(none.dials).toEqual([]);
    const old = app({ connect: async (url: string) => { throw Object.assign(new Error(`404 at ${url}`), { status: 404 }); } });
    old.link.check();
    await settle();
    old.set({ t: 10 * 60_000 });
    old.link.check();
    await settle();
    expect(old.link.linked()).toBe(false);
  });
});
