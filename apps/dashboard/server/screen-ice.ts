import { createHmac } from "node:crypto";

// Short-lived TURN credentials for the direct screen path (shared/screen-direct.ts): a signed-in app asks, this service
// asks Cloudflare Realtime TURN (generate-ice-servers) with its long-lived key, and only the minted credentials leave.
// MADANI_CF_TURN_KEY_ID and MADANI_CF_TURN_KEY_TOKEN come from Cloudflare's dashboard (Realtime, TURN Server, Create key).
// MADANI_TURN_SECRET and MADANI_TURN_HOSTS name the coturn beside each link node (static-auth-secret, the TURN REST API
// shape: username "<unix expiry>:<label>", credential base64 hmac-sha1(secret, username)); its servers follow Cloudflare's.
// With neither the app is told there is no TURN and the screen tries direct, then the link relay.
export const SCREEN_ICE_TTL_S = 4 * 60 * 60;

export interface IceServer { urls: string[]; username?: string; credential?: string }
export interface ScreenIceAnswer { v: 1; iceServers: IceServer[]; expiresAt: number }

export interface ScreenIceMinter { mint(now: number): Promise<ScreenIceAnswer | null> }

const TURN_URL = /^(?:stuns?|turns?):[a-z0-9.-]+(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i;

/** Cloudflare's answer, kept to well-formed turn.cloudflare.com entries; port 53 is dropped (browsers time out on it). */
export function cleanIceServers(value: unknown): IceServer[] {
  // a list today; an older answer had one object
  const given = (value as { iceServers?: unknown } | null)?.iceServers;
  const list: unknown[] = Array.isArray(given) ? given : given ? [given] : [];
  const out: IceServer[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { urls, username, credential } = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const kept = (Array.isArray(urls) ? urls : [urls]).filter((url): url is string =>
      typeof url === "string" && TURN_URL.test(url) && /cloudflare\.com/.test(url) && !/:53(?:\?|$)/.test(url));
    if (!kept.length) continue;
    const turn = kept.some((url) => /^turns?:/.test(url));
    if (turn && (typeof username !== "string" || typeof credential !== "string" || username.length > 512 || credential.length > 512)) continue;
    out.push(turn ? { urls: kept, username: username as string, credential: credential as string } : { urls: kept });
  }
  return out;
}

const TURN_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Credentials for our own coturn servers, valid on every host that shares the secret. */
export function ownTurnServers(secret: string, hosts: readonly string[], now: number): IceServer[] {
  const username = `${Math.floor(now / 1000) + SCREEN_ICE_TTL_S}:screen`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return [{ urls: hosts.flatMap((host) => [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`]), username, credential }];
}

function ownTurnFromEnv(env: NodeJS.ProcessEnv): ((now: number) => IceServer[]) | null {
  const secret = env.MADANI_TURN_SECRET?.trim();
  const hosts = (env.MADANI_TURN_HOSTS ?? "").split(",").map((host) => host.trim()).filter((host) => TURN_HOST.test(host)).slice(0, 4);
  if (!secret || secret.length < 32 || !hosts.length) return null;
  return (now) => ownTurnServers(secret, hosts, now);
}

function cloudflareFromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): ((now: number) => Promise<IceServer[]>) | null {
  const keyId = env.MADANI_CF_TURN_KEY_ID?.trim();
  const token = env.MADANI_CF_TURN_KEY_TOKEN?.trim();
  if (!keyId || !token || !/^[A-Za-z0-9_-]{8,128}$/.test(keyId)) return null;
  return async () => {
    const response = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: SCREEN_ICE_TTL_S }), signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    const iceServers = cleanIceServers(await response.json().catch(() => null));
    return iceServers.some((server) => server.username) ? iceServers : [];
  };
}

export function screenIceMinterFromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): ScreenIceMinter | null {
  const cloudflare = cloudflareFromEnv(env, fetchImpl);
  const own = ownTurnFromEnv(env);
  if (!cloudflare && !own) return null;
  return {
    async mint(now) {
      const iceServers = [...(cloudflare ? await cloudflare(now).catch(() => []) : []), ...(own ? own(now) : [])];
      return iceServers.length ? { v: 1, iceServers, expiresAt: now + SCREEN_ICE_TTL_S * 1000 } : null;
    },
  };
}
