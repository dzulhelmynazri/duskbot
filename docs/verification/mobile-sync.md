# Phone sync: pairing, relay and companion routes

One fake phone pairs from the QR payload, lists bots, sends and hears the reply on the event stream, uploads a file and
downloads it back from the chat, opens a websocket, and is refused once the owner revokes it. It runs twice: through an
in-process link service and link agent (a VPS without public ingress) and through the companion sidecar (a Mac).

```sh
node --experimental-strip-types scripts/mobile-sync-e2e.ts
```

It launches its own isolated fixture (`scripts/control-madani.ts launch`) and never touches the live relay or the user's
app. The fixture has no desktop, so the websocket check proves the upgrade reaches the harness's viewer gate with the
phone's session (409), not a live desktop; the byte-for-byte websocket echo is covered by
`apps/link-service/test/phone-hub.test.mjs` and `apps/companion/test/mobile.test.ts`.

## The phone apps already shipped, against this desktop

The connection code of iPhone 1.2 and Android 1.2.1, taken from the commits they were built from
(`scripts/testing/shipped-phone.ts`), against a harness in desktop mode, the desktop's own phone relay
(`electron/phone-relay.mjs` with the link agent's hub), a local link service and the companion's handler: pair by QR and
typed code, chat with a streamed reply, then the relay down (both phones go on over Wi-Fi), a link node restart, a
harness restart (unreachable, never unpaired), a tunnel the link service dropped (made again with the same channels),
a Wi-Fi-only phone, and removal from the desktop and from the phone.

```sh
node --experimental-strip-types scripts/phone-shipped-e2e.ts
```

Everything listens on 127.0.0.1. WebRTC direct is not driven (node has no RTCPeerConnection, so the phones stay on the
relay); `src/mobile/transport/direct.e2e.test.ts` covers it.

## Launch to first content, and a reply heard live

iPhone 1.2's connection code and this tree's, each timed from launch to the chat list against routes that never answer
(a secure access address, a tailnet name) ahead of the computer's Wi-Fi address; then the live stream asked the way the
iPhone's web view asks it (a preflight and a read with `Origin: capacitor://localhost`) of desktop 0.2.20's companion
and of this tree's, with a message sent and its reply waited for on that stream.

```sh
node --experimental-strip-types scripts/phone-cold-start.ts
```

Node's fetch gives up connecting after 10 s, so a route that never answers costs iPhone 1.2 10 to 15 s here where the
device waits its full 15 s.

## Two real clients

The desktop renderer and the phone app, each in its own headless Chrome, on one isolated fixture: a message sent from
either shows on the other with the bot's reply, each stored once; a reply nobody is looking at stays unread and the
phone's list says so, and opening it on the phone reads it for both; a rename and a delete reach both; a message written
with no connection waits in the phone's outbox and is sent exactly once when the connection returns; a phone back from
the background shows what it missed.

```sh
node --experimental-strip-types scripts/mobile-two-client-e2e.ts
```

It starts its own fixture and two dev servers on free ports. The phone page reaches the fixture as a same-origin client,
so the bearer, relay and companion routes stay with the script above and the tests beside `src/mobile/transport`.
Permission asks, group chats, attachments, a workspace restart and push are not driven here.
