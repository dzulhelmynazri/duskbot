// The direct screen path: the live desktop's bytes go peer to peer over a WebRTC data channel between the app and the
// server, with the link relay underneath. Signaling is one authenticated request on the existing link
// (POST /api/desktop-viewer/<target>/direct), so the DTLS fingerprints in both descriptions arrive over the same
// sealed, signed-in channel the relay uses. One rule for the server (server/screen-direct.ts) and the app
// (src/lib/screen-direct.ts).

/** Public STUN on both sides. The app adds short-lived Cloudflare Realtime TURN servers when its account has them
 * (SCREEN_ICE_PATH on the app's link proxy, minted by the account service), so a network that cannot punch still
 * goes through Cloudflare's TURN (UDP, TCP, TLS on 443) before the link relay. */
export const SCREEN_DIRECT_ICE_SERVERS: readonly string[] = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];

/** Each data channel on a peer carries one thing; files can open their own label on the same peer later. */
export const SCREEN_CHANNEL = "screen";

/** Candidates are gathered before each description is sent (no trickle), up to this long; a TURN allocation fits. */
export const SCREEN_DIRECT_GATHER_MS = 1_500;
/** From the answer to an open channel, direct and TURN pairs both tried: past this, the link relay carries the screen. */
export const SCREEN_DIRECT_CONNECT_MS = 5_000;
/** The app's link proxy answers this itself with { iceServers } (electron/vps-link-protocol.mjs). */
export const SCREEN_ICE_PATH = "/__madani/screen-ice";

/** How a screen reached the app: peer to peer, through Cloudflare's TURN, or over our link relay. */
export const SCREEN_PATHS = ["direct", "cloudflare-turn", "our-relay"] as const;
export type ScreenPath = typeof SCREEN_PATHS[number];
/** A failed direct attempt is not repeated on this app for this long; the screen opens over the relay at once. */
export const SCREEN_DIRECT_RETRY_MS = 2 * 60_000;
/** The largest message either side sends; every WebRTC stack takes this much. */
export const SCREEN_DIRECT_MESSAGE = 16 * 1024;

/** Why a screen went over the relay. Counted by the server; nothing personal. */
export const SCREEN_FALLBACK_REASONS = [
  // this app has no WebRTC, or is on the server's own machine
  "unsupported",
  // the server has no direct path (native module missing, turned off, or full)
  "server-off",
  // the signaling request failed or was refused
  "signal-failed",
  // ICE reported failure
  "ice-failed",
  // nothing opened in time
  "timeout",
  // an earlier attempt on this app failed recently
  "recent-failure",
  // the app's whole link to this server already goes direct (ssh, 443 or webrtc), which carries this screen too
  "link-direct",
] as const;
export type ScreenFallbackReason = typeof SCREEN_FALLBACK_REASONS[number];

export const isScreenFallbackReason = (value: unknown): value is ScreenFallbackReason =>
  typeof value === "string" && (SCREEN_FALLBACK_REASONS as readonly string[]).includes(value);

/** The ICE candidate types a direct session can settle on. */
export const SCREEN_CANDIDATE_TYPES = ["host", "srflx", "prflx", "relay"] as const;
export type ScreenCandidateType = typeof SCREEN_CANDIDATE_TYPES[number];

/** A description as it crosses the signaling request; bounded so a request cannot make the server parse megabytes. */
export const SCREEN_SDP_MAX = 64 * 1024;

// ---- a WebSocket carried on a direct peer (the bot browser's stream): POST SOCKET_DIRECT_PATH?path=<socket path> ----

export const SOCKET_DIRECT_PATH = "/api/direct/socket";
export const SOCKET_CHANNEL = "socket";
/** the sockets a peer may carry, path and query as the app would open them */
export const SOCKET_DIRECT_TARGET = /^\/api\/bots\/[\w-]+\/browser\/stream(?:\?[^#\s]{0,2048})?$/;
/** each data-channel message is [kind][payload]; a WebSocket message longer than one piece is sent in parts */
export const SOCKET_PIECE = SCREEN_DIRECT_MESSAGE * 4 - 1;
export const SOCKET_KIND = { textPart: 1, text: 2, binaryPart: 3, binary: 4, close: 5 } as const;
