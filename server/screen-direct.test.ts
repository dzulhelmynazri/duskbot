import { PassThrough } from "node:stream";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { expect, it } from "vitest";
import { bridgeScreen, createScreenDirect, directPortRange, DirectRefused, loadDataChannel, screenOffer, type ScreenChannel } from "./screen-direct.ts";
import { readFrame, writeFrame } from "./routes/rfb-handshake.ts";

const FINGERPRINT = `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => "AB").join(":")}`;
const offerSdp = (extra = "") => `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n${FINGERPRINT}\r\n${extra}`;

it("takes only a bounded data-channel offer with a fingerprint", () => {
  expect(screenOffer({ type: "offer", sdp: offerSdp() })).toBe(offerSdp());
  expect(screenOffer({ type: "answer", sdp: offerSdp() })).toBeNull();
  expect(screenOffer({ type: "offer", sdp: offerSdp().replace(FINGERPRINT, "") })).toBeNull();
  expect(screenOffer({ type: "offer", sdp: offerSdp("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n") })).toBeNull();
  expect(screenOffer({ type: "offer", sdp: offerSdp("a=x:" + "y".repeat(70_000)) })).toBeNull();
  expect(screenOffer("v=0")).toBeNull();
});

it("reads a firewall port range and ignores anything else", () => {
  expect(directPortRange("50000-50100")).toEqual({ portRangeBegin: 50000, portRangeEnd: 50100 });
  expect(directPortRange("80-90")).toBeUndefined();
  expect(directPortRange("6000-5000")).toBeUndefined();
  expect(directPortRange(undefined)).toBeUndefined();
});

it("turns the direct path off without the native module, and on request", async () => {
  expect(loadDataChannel({ MADANI_SCREEN_DIRECT: "off" })).toBeNull();
  const off = createScreenDirect({ load: () => null });
  expect(off.available()).toBe(false);
  await expect(off.answer({ type: "offer", sdp: offerSdp() }, () => {})).rejects.toMatchObject({ status: 503 });
  expect(off.stats().available).toBe(false);
  expect(loadDataChannel({})).not.toBeNull();
});

it("refuses a malformed offer before making a peer", async () => {
  const direct = createScreenDirect({ iceServers: [] });
  await expect(direct.answer({ type: "offer", sdp: "v=0\r\n" }, () => {})).rejects.toBeInstanceOf(DirectRefused);
  expect(direct.stats().direct.failed).toBe(0);
});

it("answers a real offer, opens the screen channel only for its fingerprint holder, and counts the candidate type", async () => {
  const direct = createScreenDirect({ iceServers: [], gatherMs: 500 });
  const app = new RTCPeerConnection({ iceServers: [] } as ConstructorParameters<typeof RTCPeerConnection>[0]);
  const channel = app.createDataChannel("screen");
  await app.setLocalDescription(await app.createOffer());
  await new Promise((resolve) => setTimeout(resolve, 300));
  const got: Buffer[] = [];
  let server: ScreenChannel | undefined;
  const peer = await direct.answer({ type: "offer", sdp: app.localDescription!.sdp }, (screen) => {
    server = screen;
    screen.onMessage((bytes) => { got.push(bytes); screen.send(Buffer.from("pong")); });
  });
  expect(peer.answer.sdp).toMatch(/^a=fingerprint:sha-256 /m);
  await app.setRemoteDescription(peer.answer);
  const reply = new Promise<string>((resolve) => channel.addEventListener("message", (event) => resolve(Buffer.from((event as MessageEvent).data).toString())));
  await new Promise<void>((resolve) => channel.addEventListener("open", () => resolve()));
  channel.send(Buffer.from("ping"));
  expect(await reply).toBe("pong");
  expect(Buffer.concat(got).toString()).toBe("ping");
  let stats = direct.stats();
  expect(stats.direct).toMatchObject({ sessions: 1, open: 1, bytesSent: 4, bytesReceived: 4 });
  // a burst far beyond what goes out at once is queued, never a reason to end the screen
  let received = 0;
  channel.addEventListener("message", (event) => { received += Buffer.from((event as MessageEvent).data).length; });
  expect(server!.send(Buffer.alloc(4 * 1024 * 1024, 1))).toBe(true);
  await expect.poll(() => received, { timeout: 10_000 }).toBe(4 * 1024 * 1024);
  stats = direct.stats();
  expect(stats.direct.candidates.host).toBe(1);
  expect(stats.paths).toEqual({ direct: 1, "cloudflare-turn": 0, "our-relay": 0 });
  expect(stats.pairs).toEqual({ "host/host": 1 });
  peer.close();
  app.close();
  expect(direct.stats().direct.open).toBe(0);
  direct.closeAll();
});

function fakeChannel() {
  const sent: Buffer[] = [];
  const handlers: { message?: (bytes: Buffer) => void; close: Array<() => void>; drain?: () => void } = { close: [] };
  let closed = false;
  const channel: ScreenChannel = {
    send: (bytes) => { if (closed) return false; sent.push(Buffer.from(bytes)); return true; },
    sendMessage: (bytes) => { if (closed) return false; sent.push(Buffer.from(bytes)); return true; },
    buffered: () => 0,
    onDrain: (callback) => { handlers.drain = callback; },
    onMessage: (callback) => { handlers.message = callback; },
    onClose: (callback) => { handlers.close.push(callback); },
    close: () => { if (closed) return; closed = true; for (const close of handlers.close) close(); },
  };
  return { channel, sent, handlers, closed: () => closed };
}

it("bridges the desktop's frames to channel bytes and the app's bytes to masked frames, after the opening", async () => {
  const { channel, sent, handlers } = fakeChannel();
  const upstream = new PassThrough();
  const written: Buffer[] = [];
  upstream.write = ((chunk: Buffer) => { written.push(chunk); return true; }) as typeof upstream.write;
  let ended = 0;
  bridgeScreen(channel, upstream, { head: writeFrame(Buffer.from("leftover"), false), opening: [Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])], payload: Buffer.from("rest"), skip: 14 }, () => ended++);
  expect(sent.map((bytes) => bytes.toString("latin1"))).toEqual(["RFB 003.008\n", "\x01\x01", "rest", "leftover"]);
  upstream.emit("data", writeFrame(Buffer.from("frame"), false));
  upstream.emit("data", writeFrame(Buffer.from("hi"), false, 9));
  expect(sent.at(-1)!.toString()).toBe("frame");
  expect(readFrame(written[0]!)!.frame).toMatchObject({ opcode: 10 });
  // the app's own opening is dropped, the key press after it reaches the desktop
  handlers.message!(Buffer.concat([Buffer.alloc(14, 7), Buffer.from("key")]));
  const input = readFrame(written[1]!)!;
  expect(written[1]![1]! & 0x80).toBe(0x80);
  expect(input.frame.payload.toString()).toBe("key");
  upstream.emit("data", writeFrame(Buffer.alloc(0), false, 8));
  expect(ended).toBe(1);
});

it("ends the desktop connection when the channel closes", () => {
  const { channel } = fakeChannel();
  const upstream = new PassThrough();
  let ended = 0;
  bridgeScreen(channel, upstream, { head: Buffer.alloc(0) }, () => ended++);
  channel.close();
  expect(upstream.destroyed).toBe(true);
  expect(ended).toBe(1);
});

it("counts relay screens by why they were not direct, with no personal data", () => {
  const direct = createScreenDirect({ load: () => null });
  direct.relayOpened("ice-failed");
  direct.relayOpened(null);
  direct.relayClosed(1000, 20);
  const stats = direct.stats();
  expect(stats.relay).toMatchObject({ sessions: 2, open: 1, bytesSent: 1000, bytesReceived: 20 });
  expect(stats.relay.reasons).toMatchObject({ "ice-failed": 1, none: 1, timeout: 0 });
  expect(stats.paths["our-relay"]).toBe(2);
  // a screen on a link that already goes direct counts as direct
  direct.relayCounted("link-direct");
  expect(direct.stats().paths).toMatchObject({ direct: 1, "our-relay": 2 });
});
