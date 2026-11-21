# Wire latency: VPS link, relay and live events

How fast a live event (a bot's reply frame) and an API request cross between the bot server on a VPS and the Mac app,
hop by hop, and what each change on `w10/wire-speed` bought. Measured 2026-11-07 on the user's Oracle VPS (Mumbai),
the relay at `link.madani.bot` (Contabo) and this Mac behind Proton VPN.

## The path

```
server /api/events (sse, one write per turn's frames; gzipped when forwarded)
  -> link agent (apps/link-service/agent.mjs): http to 127.0.0.1:8799, seals frames (aes-256-gcm)
  -> relay: POST /v1/tunnels/<id>/to-app  ->  queue  ->  streamed GET (ndjson) to the app
     or the direct path: one ssh channel to the agent's `direct` command (electron/vps-link-direct.mjs)
  -> app proxy (electron/vps-link-protocol.mjs) on http://vps-<id>.localhost:<port>
  -> renderer EventSource (src/lib/live-events.ts) -> state -> React
```

## Fixture

`scripts/bench-wire.mjs` runs a fake server and the real agent (the "vps" thread), the real relay (its own thread)
and the real app proxy with a stand-in renderer (the "mac" thread), each on its own event loop, with every network
leg behind a proxy that delays it like the measured link (vps<->relay 72 ms one way, mac<->relay 210, mac<->vps 158).
Taps on the agent's and app's fetch and on the relay's writes timestamp each hop on one clock.

```sh
node scripts/bench-wire.mjs                      # relay path, plain http relay (keep-alive http/1.1)
node scripts/bench-wire.mjs --h2 --gzip          # tls relay with http/2 (as nginx serves it), gzipped event stream
node scripts/bench-wire.mjs --path direct        # the direct path (ssh stand-in: a delayed tcp socket)
node scripts/bench-wire.mjs --kbps 2000          # also a 2 Mbit/s downlink to the mac
```

Scenarios: single events 0.7 s apart; bursts of 12 bot-sized (2 kB) frames written together; a turn's 12 frames
written 3 ms apart; requests one at a time; 20 requests at once. It reports p50/p95/min per hop and in total.

Two Electron checks back the renderer side:

```sh
SWITCH=localhost ./node_modules/.bin/electron scripts/testing/electron-connection-limit.cjs   # 18 parallel requests
./node_modules/.bin/electron scripts/testing/electron-sse-gzip.cjs                           # gzipped sse per event
```

## Live measurement (read-only)

- Network legs: `curl -w` timings and keep-alive request loops to `https://link.madani.bot/healthz` from the Mac
  and from the VPS; `ssh oracle` exec streams for the direct path.
- Events: a loopback SSE reader on the VPS (`127.0.0.1:8799/api/events`) and an extra EventSource in the user's
  renderer (CDP 9335 `Runtime.evaluate`, no input), matched by `seq`, while a test bot (Moss, Codex) answered a
  message sent over the VPS's loopback API. Both clocks are NTP-synced (VPS offset 7 µs, Mac within 2 ms).
- Requests: the renderer's own resource timings (`queue = requestStart - startTime`, `wait`, `download`), and
  sequential `fetch`es from the renderer.
- Paint: the renderer probe's arrival time to the next and second `requestAnimationFrame`, plus a
  `long-animation-frame` observer.

### What the link is made of

| leg | measured |
|---|---|
| Mac -> Proton VPN exit (TCP handshake; the VPN splits TCP) | 170-250 ms |
| Mac <-> relay, request round trip on a warm connection | 407-476 ms (p50 424) |
| VPS <-> relay, request round trip | 142-147 ms |
| Mac <-> VPS (ssh), one way | min 146-165 ms, about 316 ms round trip |
| relay path floor for a request (Mac -> relay -> VPS -> relay -> Mac) | about 564 ms |
| direct path floor | about 316 ms |

### Findings outside the code

1. **The VPN drops every packet over about 1344 bytes.** `utun7` (Proton WireGuard, 10.2.0.2) says MTU 1420, but
   `ping -D` gets through at 1316 bytes of payload and never at 1320 or more, with or without DF. TCP sends 1380-byte
   segments, so anything bigger than one small packet stalls until the sender gives up on them:
   - every new TLS connection from this Mac takes 4.9-6.6 s (google.com and 1.1.1.1 too, not just the relay),
     because the certificate flight is full-size; a resumed TLS session (no certificate) takes 0.8 s;
   - bursts of live frames (9-12 frames, 13-20 kB) reached the renderer 0.85-2.9 s after the server wrote them,
     while single small frames took 0.25-0.36 s;
   - `nettop` on the app's relay socket: 1.29 MB of 11.9 MB received out of order.
   Fix on the Mac (not ours to change): set the tunnel's MTU to 1340 (`sudo ifconfig utun7 mtu 1340`, until the VPN
   reconnects), or change Proton's protocol, or use a network without the smaller MTU (en0 is "constrained").
2. **The VPN adds the round trip.** Its exit is about 180 ms from the Mac. A split tunnel for the relay and the VPS
   (Proton's split tunneling by IP) would take that off every hop.
3. **The relay sits off the path.** Mac -> relay -> VPS costs about 248 ms more per round trip than Mac -> VPS. A relay
   in Mumbai (on the VPS itself, or any host near it) would bring the relay path to the direct path's ~317 ms; the
   direct ssh path (pending approval) gets the same without a relay. The relay already runs on the user's Contabo
   box, so moving it there saves nothing.

## Results

Fixture numbers are milliseconds, 30 runs per scenario, `before` = `w10/direct-link` merged with `custom` (the base of
this branch), `after` = the branch head with an http/2 relay and the gzipped event stream.

| hop (relay path, fixture) | before | after | before @2 Mbit/s | after @2 Mbit/s | after, relay without h2 |
|---|---|---|---|---|---|
| event: server write -> agent post (p50) | 6.2 | 0.4 * | 6.1 | - | 6.1 |
| event: agent post -> relay streams it (p50) | 73.9 | 73.8 * | 73.8 | - | 73.8 |
| event: relay -> app proxy (p50) | 211.5 | 211.5 * | 213.5 | - | 211.5 |
| event: app proxy -> renderer event (p50) | 0.3 | 0.3 * | 0.3 | - | 0.3 |
| event total p50 | 291.7 | 286.1 | 293.7 | 287.8 | 291.5 |
| event total p95 | 292.7 | 287.3 | 294.6 | 290.2 | 293.3 |
| 12-frame burst, last frame p50 | 291.6 | 285.8 | 384.4 | 289.0 | 291.9 |
| turn spread over 36 ms, each frame p50 | 291.6 | 288.5 | 331.9 | 289.8 | 291.3 |
| turn spread over 36 ms, each frame p95 | 420.1 | 295.1 | 462.7 | 296.9 | 419.3 |
| request rtt p50 | 582.4 | 570.9 | 590.4 | 577.5 | 582.6 |
| request rtt p95 | 583.5 | 574.0 | 592.5 | 580.1 | 584.1 |
| 20 requests at once p50 | 589.1 | 581.8 | 672.7 | 651.9 | 588.8 |
| 20 requests at once p95 | 951.6 | 595.0 | 835.9 | 663.9 | 589.2 |

| direct path (fixture) | before | after |
|---|---|---|
| event total p50 | 160.2 | 160.7 |
| event total p95 | 161.7 | 161.6 |
| 12-frame burst, last frame p50 | 160.2 | 160.0 |
| request rtt p50 | 319.7 | 320.9 |
| request rtt p95 | 320.2 | 322.3 |
| 20 requests at once p95 | 329.6 | 338.2 |

`*` per-hop columns come from the same run without `--gzip` (the taps cannot read compressed bytes). The direct path
was already lean (one write per turn, no outbox timer); its numbers move only by noise.

### Live (relay path, this Mac)

| hop | before | after |
|---|---|---|
| single event, server write -> renderer (p50 of 3 runs) | 313-318 | after the deploy below; fixture: -5.6 ms |
| burst of a turn's frames (13-20 kB), server write -> renderer | 848-2877 | after the deploy; the stream is 8x smaller (32315 -> 4029 B per Codex turn), about 2 packets instead of 15 |
| renderer: event arrival -> next frame painted (p50 / p95) | 11.4 / 14.6 | unchanged (no long animation frames; nothing to win) |
| request round trip, one at a time (`/api/health`, p50) | 577 | after the deploy; fixture: -11.5 ms |
| startup burst waiting for one of Chromium's 6 connections (`queue`) | up to 12402 | 0 (Electron fixture: 18 requests 1508 -> 510 ms) |
| request after a wake or network change (new relay connection) | 5889-8005 | 1491-1501 (measured: TLS session kept) |
| 6 requests at once to the relay (new sockets vs one h2 connection) | 1473 | 605 (measured, read-only `/healthz`) |
| direct path, sshd without `TCP_NODELAY` (no pty) vs with a pty, small frames every 60 ms | p50 236-257, p95 310-341 | p50 229-268, p95 323-414: no gain, the VPN's TCP split bunches them past sshd, so the agent stays pty-less |

## What changed

| commit | change | measured |
|---|---|---|
| outbox posts on the next turn | over http/2 the relay outboxes post on `setImmediate`, not after 5 ms (http/1.1, three posts out, keeps 5 ms: posting early spent its slots on a spread-out turn) | agent hop 6.2 -> 0.6 ms; event p50 291.8 -> 288.3; request p50 584.2 -> 575.5 |
| connection cap | `ignore-connections-limit=localhost` (electron/vps-link-main.mjs) | 18 parallel requests 1508 -> 510 ms; live queue up to 12.4 s |
| tls sessions survive a reset | `keepAliveFetch.reset` keeps its agents | live reconnect 5889-8005 -> 1491-1501 ms |
| gather while posts are out | 2 ms per post out, at most 16 | 20 requests at once p95 1147 -> 585 ms |
| gzipped event stream | server/harness/sse-gzip.ts, one zlib context, one write and flush per turn | Codex turn 32315 -> 4029 B; at 2 Mbit/s burst 377 -> 287 ms |
| http/2 to the relay | `relayFetch` (both ends), 8 posts out | turn frames p50 412.7 -> 289.4 ms; live 6 at once 1473 -> 605 ms |
| next read ahead | the next streamed read goes out 21 s into the current one | across rotations: turn frames p95 532 -> 295 ms, 20 at once p95 980 -> 589 ms |

Measured and left alone: AES-GCM costs 30 µs to seal and 16-19 µs to open a small frame on the VPS (128 kB: 417 / 186
µs); brotli and zstd shrink `/api/bots` (677 kB) only 10% more than gzip (217 -> 196 kB); every socket the link owns
already has `TCP_NODELAY` (node's http client and server default to it; the direct path's ssh socket and websocket
sockets set it); the direct path already writes each turn's records as one write.

## Next, not done here

- Relay frames are base64 inside JSON (a third more bytes). A binary body for posts and the streamed read would need
  the relay and both ends to agree on it; worth it for desktop streams through the relay, little for events now that
  the stream is gzipped.
- The relay holds eight posts that overtook an earlier one (`HELD_POSTS`), which caps posts in flight. Raising it
  would let a busy desktop stream keep more posts out over http/2.
- `/api/bots` is 677 kB (217 kB gzipped) and the renderer read it 8 times in 30 minutes; on this link each read took
  2.1-5.6 s. Narrowing it, or a conditional GET, is the biggest remaining request cost.

## Deploy

Every piece works with an old other side, in any order.

- The Mac app (`electron/main.mjs`, `electron/vps-link-main.mjs`, `electron/vps-link-protocol.mjs`): restart it.
- The VPS's link agent (`apps/link-service/agent.mjs` as `/opt/madanibot-link/agent.mjs`), then restart
  `madanibot-link.service`.
- The VPS's server package (`server/harness/sse-gzip.ts`, `server/index.ts`): the gzipped event stream.
- The link service needs no code change (nginx already offers h2); redeploy it only so new installs fetch the new
  `agent.mjs`.
