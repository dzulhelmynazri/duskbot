// The app's side of the direct screen: every failure is a reason for the relay, never an error the person sees.
import { beforeEach, expect, it, vi } from "vitest";
import { directScreenWanted, openDirectScreen, resetDirectScreen } from "./screen-direct";

class FakeChannel extends EventTarget {
  binaryType = "blob";
  readyState = "connecting";
  close = vi.fn();
}
let behaviour: "open" | "fail" | "silent" = "open";
class FakePeer extends EventTarget {
  static made: FakePeer[] = [];
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: { type: string; sdp: string } | null = null;
  channel = new FakeChannel();
  closed = false;
  config: RTCConfiguration;
  constructor(config: RTCConfiguration) { super(); this.config = config; FakePeer.made.push(this); }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
  async setLocalDescription(description: { type: string; sdp: string }) { this.localDescription = description; }
  async setRemoteDescription() {
    setTimeout(() => {
      if (behaviour === "open") { this.channel.readyState = "open"; this.channel.dispatchEvent(new Event("open")); }
      if (behaviour === "fail") { this.connectionState = "failed"; this.dispatchEvent(new Event("connectionstatechange")); }
    }, 5);
  }
  close() { this.closed = true; this.connectionState = "closed"; }
}
const Peer = FakePeer as unknown as typeof RTCPeerConnection;
const answering = (status = 200, body: unknown = { type: "answer", sdp: "v=0 answer" }) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const open = (fetcher: typeof fetch, extra: Partial<Parameters<typeof openDirectScreen>[1]> = {}) =>
  openDirectScreen("/api/desktop-viewer/vps/scout/direct?rfb=server", { signal: new AbortController().signal, fetch: fetcher, RTCPeerConnection: Peer, connectMs: 50, ...extra });

beforeEach(() => { resetDirectScreen(); behaviour = "open"; FakePeer.made = []; });

it("tries direct only for a server on another machine", () => {
  expect(directScreenWanted("vps-abc.localhost")).toBe(true);
  expect(directScreenWanted("home.example.com")).toBe(true);
  expect(directScreenWanted("localhost")).toBe(false);
  expect(directScreenWanted("127.0.0.1")).toBe(false);
});

it("signals over the link once and hands back the open channel", async () => {
  const fetch = answering();
  const result = await open(fetch);
  expect("channel" in result && result.channel.binaryType).toBe("arraybuffer");
  const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
  expect(url).toBe("/api/desktop-viewer/vps/scout/direct?rfb=server");
  expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
  expect(JSON.parse(init.body)).toEqual({ type: "offer", sdp: "v=0 offer" });
});

it("says unsupported without WebRTC", async () => {
  expect(typeof globalThis.RTCPeerConnection).toBe("undefined");
  expect(await openDirectScreen("/x", { signal: new AbortController().signal, fetch: answering() })).toEqual({ fallback: "unsupported" });
});

it.each([
  ["server-off", 503, { reason: "server-off" }],
  ["unsupported", 409, { reason: "unsupported" }],
])("falls back as %s when the server says so, and then skips the attempt", async (reason, status, body) => {
  expect(await open(answering(status, body))).toEqual({ fallback: reason });
  const again = answering();
  expect(await open(again)).toEqual({ fallback: "recent-failure" });
  expect(again).not.toHaveBeenCalled();
});

it("falls back on a refused or broken signal without blocking the next try", async () => {
  expect(await open(answering(403, { error: "forbidden" }))).toEqual({ fallback: "signal-failed" });
  expect(await open(vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).toEqual({ fallback: "signal-failed" });
  expect("channel" in await open(answering())).toBe(true);
});

it("falls back when ICE fails or nothing opens in time, and closes the peer", async () => {
  behaviour = "fail";
  expect(await open(answering())).toEqual({ fallback: "ice-failed" });
  resetDirectScreen();
  behaviour = "silent";
  expect(await open(answering())).toEqual({ fallback: "timeout" });
});

it("remembers a path that drops after opening, so the reconnect takes the relay", async () => {
  const result = await open(answering());
  if (!("channel" in result)) throw new Error("expected a channel");
  const peer = FakePeer.made[0]!;
  peer.connectionState = "failed";
  peer.dispatchEvent(new Event("connectionstatechange"));
  expect(peer.channel.close).toHaveBeenCalled();
  expect(await open(answering())).toEqual({ fallback: "recent-failure" });
});

it("adds the account's TURN servers to STUN, and goes on without them when they are slow or missing", async () => {
  const turn = { urls: ["turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" };
  expect("channel" in await open(answering(), { turn: async () => [turn] })).toBe(true);
  expect(FakePeer.made[0]!.config.iceServers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }, turn]);
  expect("channel" in await open(answering(), { turn: async () => { throw new Error("signed out"); } })).toBe(true);
  expect(FakePeer.made[1]!.config.iceServers).toHaveLength(1);
});

it("reads TURN servers only from the app's link proxy", async () => {
  const { linkProxyTurn, onLinkProxy } = await import("./screen-direct");
  expect(onLinkProxy("vps-abc123.localhost")).toBe(true);
  expect(onLinkProxy("home.example.com")).toBe(false);
  const fetcher = vi.fn(async () => Response.json({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }, "junk"] })) as unknown as typeof fetch;
  expect(await linkProxyTurn(fetcher)).toHaveLength(1);
  expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("/__madani/screen-ice");
});

it("makes no second peer when the app's whole link already goes direct", async () => {
  const fetcher = answering();
  expect(await open(fetcher, { linkDirect: async () => true })).toEqual({ fallback: "link-direct" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(FakePeer.made).toHaveLength(0);
  expect("channel" in await open(answering(), { linkDirect: async () => false })).toBe(true);
});

it("lets the caller's abort win", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(open(answering(), { signal: controller.signal })).rejects.toThrow();
});
