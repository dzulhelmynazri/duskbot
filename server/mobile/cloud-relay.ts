// A madani cloud's own phone relay: the same supervisor and link agent hub a desktop runs, in the server's own process, on
// a tunnel made with the link grant the account service sends with each entitlement push.
//
// Security invariant: the tunnel token and the hub's X25519 key stay in `phone-relay.json` in the cloud's data folder,
// owner-only, like its other machine credentials; frames are sealed between each phone and this hub.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createPhoneRelay, PHONE_RELAY_BASE } from "../../electron/phone-relay.mjs";
import { writeFileAtomic } from "../atomic.ts";

/** a link grant lives five minutes on the account service; one older than this is not tried */
const GRANT_FRESH_MS = 4 * 60_000;

export interface CloudPhoneRelayOptions {
  dataDir: string;
  /** this machine: a tunnel saved by another (a moved or restored home's) is never used, and a new one is made */
  machineId: string;
  port: () => number;
  label: () => string;
  /** the in-process channel sync (server/mobile/link.ts relaySync) */
  sync: (input: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (line: string) => void;
  /** tests: the hub module and the fetch the supervisor uses */
  loadHub?: () => Promise<unknown>;
  fetch?: typeof fetch;
  checkMs?: number;
  retryMs?: number[];
}

export function startCloudPhoneRelay(options: CloudPhoneRelayOptions) {
  const env = options.env ?? process.env, now = options.now ?? Date.now, file = join(options.dataDir, "phone-relay.json");
  let grant: { value: string; at: number } | null = null;
  const fresh = () => (grant && now() - grant.at < GRANT_FRESH_MS ? grant.value : null);
  const relay = createPhoneRelay({
    base: (env.MADANI_LINK_BASE || PHONE_RELAY_BASE).replace(/\/+$/, ""),
    wanted: () => true,
    signedIn: () => Boolean(fresh()),
    linkGrant: async () => { const value = fresh(); grant = null; return value; },
    label: options.label,
    store: {
      read: async () => {
        try {
          const saved = JSON.parse(readFileSync(file, "utf8")) as { machineId?: unknown };
          return saved?.machineId === options.machineId ? saved : null;
        } catch { return null; }
      },
      write: async (_at: string, value: unknown) => { writeFileAtomic(file, JSON.stringify({ ...(value as object), machineId: options.machineId }), { mode: 0o600 }); },
    },
    loadHub: options.loadHub ?? (() => import("../../apps/link-service/agent.mjs")),
    port: options.port,
    ownerToken: () => "",
    sync: (input: Record<string, unknown>) => options.sync(input),
    proxy: null,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.checkMs ? { checkMs: options.checkMs } : {}),
    ...(options.retryMs ? { retryMs: options.retryMs } : {}),
    log: (line: string) => options.log?.(line),
  });
  relay.start();
  return {
    /** the account service's link grant, sent with an entitlement push: used only while this cloud has no tunnel */
    grant(value: unknown) {
      if (typeof value !== "string" || !value || value.length > 4096) return;
      grant = { value, at: now() };
      relay.wake();
    },
    state: () => relay.state(),
    ready: (ms?: number) => relay.ready(ms),
    stop: () => relay.stop(),
  };
}
