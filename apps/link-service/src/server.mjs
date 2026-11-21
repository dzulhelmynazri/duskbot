// `npm start`: the link service on process.env.PORT. config (all optional):
//   LINK_BASE         public address people's servers reach, default https://link.madani.bot
//   LINK_DATA_DIR     where state.json lives, default ./data
//   LINK_PACKAGES_DIR the private server builds install.sh downloads, default $LINK_DATA_DIR/packages
//   LINK_TRUST_PROXY  "0" when nothing sits in front of it (then forwarded headers are ignored), default "1"
//   MADANI_LINK_GRANT_KEYS  kid:x,... the account service's Ed25519 public keys for link grants, default the pinned ones
//   LINK_STATS_TOKEN  bearer token for GET /v1/stats/relay, GET /ops/relay/stats and PUT /ops/relay/limits (the account
//                     service's ops page and admin relays panel); unset hides them
//   MADANI_LINK_OPEN    "1" opens setup sessions to anyone without a madani account (local development only)
//   LINK_NODES        id=https://host@region,... every node, the same on each; the first is the default home (nodes.mjs)
//   LINK_NODE_ID      which of LINK_NODES this is
//   LINK_PEER_TOKEN   32+ characters, the same on every node: the directory's copy between them
//   LINK_ALLOWANCE_TB this box's monthly egress allowance in TB (contabo 32, oracle's free 10), default 32
//   LINK_TURN_SECRET  32+ characters, coturn's static-auth-secret on every node; unset hides the turn routes
//   LINK_TURN_TLS     "1" when the node's turn server also answers tls on 5349
import "./legacy.mjs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createLinkService } from "./app.mjs";
import { createBoxMeter } from "./box-meter.mjs";
import { parseNodes } from "./nodes.mjs";
import { createTurnWatch } from "./turn.mjs";
import { PINNED_GRANT_KEYS, parseGrantKeys } from "./grant.mjs";

export const DEFAULT_BASE = "https://link.madani.bot";
const root = fileURLToPath(new URL("..", import.meta.url));
const base = (process.env.LINK_BASE || DEFAULT_BASE).replace(/\/+$/, "");
if (!/^https?:\/\/[^/\s]+$/.test(base)) throw new Error("LINK_BASE must be an origin like https://link.example.com");
const port = Number(process.env.PORT || 8790);
// where short lines point (madani.bot proxies /s/ here, behind Cloudflare); this service's own base when unset
const shortBase = (process.env.LINK_SHORT_BASE || base).replace(/\/+$/, "");
if (!/^https?:\/\/[^/\s]+$/.test(shortBase)) throw new Error("LINK_SHORT_BASE must be an origin like https://madani.bot");

const dataDir = process.env.LINK_DATA_DIR || `${root}data`;
const nodes = parseNodes(process.env.LINK_NODES, process.env.LINK_NODE_ID);
const peerToken = process.env.LINK_PEER_TOKEN && process.env.LINK_PEER_TOKEN.length >= 32 ? process.env.LINK_PEER_TOKEN : null;
if (nodes && nodes.nodes.length > 1 && !peerToken) throw new Error("LINK_NODES lists other nodes: set LINK_PEER_TOKEN (32+ characters, the same on every node)");
const turnSecret = process.env.LINK_TURN_SECRET && process.env.LINK_TURN_SECRET.length >= 32 ? process.env.LINK_TURN_SECRET : null;
const allowanceTb = Number(process.env.LINK_ALLOWANCE_TB || 32);
const service = createLinkService({
  base,
  shortBase,
  dataDir,
  packagesDir: process.env.LINK_PACKAGES_DIR || `${dataDir}/packages`,
  scriptPath: `${root}install.sh`,
  agentPath: `${root}agent.mjs`,
  trustProxy: process.env.LINK_TRUST_PROXY !== "0",
  grantKeys: process.env.MADANI_LINK_OPEN === "1" ? null : parseGrantKeys(process.env.MADANI_LINK_GRANT_KEYS) ?? PINNED_GRANT_KEYS,
  statsToken: process.env.LINK_STATS_TOKEN && process.env.LINK_STATS_TOKEN.length >= 24 ? process.env.LINK_STATS_TOKEN : null,
  log: (line) => console.error(line),
  nodes, peerToken,
  monthAllowanceBytes: Number.isFinite(allowanceTb) && allowanceTb > 0 ? Math.round(allowanceTb * 1e12) : undefined,
  turn: turnSecret ? { secret: turnSecret, tls: process.env.LINK_TURN_TLS === "1" } : null,
  box: createBoxMeter({ dir: dataDir }),
  turnWatch: turnSecret ? createTurnWatch() : null,
});
service.start();
const server = createServer({ requestTimeout: 300_000, headersTimeout: 30_000 }, (req, res) => void service.handler(req, res));
server.keepAliveTimeout = 65_000;
const sweep = setInterval(() => service.store.sweep(), 60_000);
sweep.unref();
server.listen(port, process.env.HOST || "127.0.0.1", () => console.log(`link service on :${port}, public base ${base}${nodes ? `, node ${nodes.self.id} of ${nodes.nodes.length}` : ""}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { service.close(); server.close(); process.exit(0); });
