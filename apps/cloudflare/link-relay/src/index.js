import { PINNED_GRANT_KEYS, parseGrantKeys, verifyLinkGrant } from "./grant.js";
import { monthOf } from "./fair-use.js";
import { ACCT, HEX64, TUNNEL_ID, bearerOf, json, sameHex, sha256hex } from "./protocol.js";

export { TunnelRelay } from "./tunnel.js";
export { AccountUsage, OpsUsage } from "./accounts.js";

const MONTH = /^\d{4}-\d{2}$/;

async function limited(limiter, key) {
  if (!limiter) return false;
  try { return !(await limiter.limit({ key })).success; } catch { return false; }
}

async function readSmallJson(request, limit = 4096) {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return null;
  const text = await request.text();
  if (text.length > limit) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function opsAllowed(request, env) {
  const token = /^Bearer (\S{16,200})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!env.OPS_TOKEN || !token) return false;
  return sameHex(await sha256hex(token), await sha256hex(env.OPS_TOKEN));
}

export default {
  /** @param {Request} request */
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/health")) return json(200, { ok: true, service: "madani link relay" });

    const tunnelPath = /^\/v1\/t\/([a-z2-7]{10})(?:\/(register|vps|app))?$/.exec(url.pathname);
    if (tunnelPath) {
      const [, id, action] = tunnelPath;
      if (!TUNNEL_ID.test(id)) return json(404, { error: "not found" });
      const stub = env.TUNNELS.get(env.TUNNELS.idFromName(id));
      if (action === "register" && method === "POST") {
        if (await limited(env.REGISTER_LIMITER, ip)) return json(429, { error: "too many requests", code: "rate_limited" }, { "retry-after": "60" });
        const body = await readSmallJson(request);
        if (!body || typeof body.verifier !== "string" || !HEX64.test(body.verifier)) return json(400, { error: "send {grant, verifier}", code: "bad_request" });
        let keys = PINNED_GRANT_KEYS;
        try { keys = parseGrantKeys(env.GRANT_KEYS) ?? PINNED_GRANT_KEYS; } catch { return json(500, { error: "relay misconfigured" }); }
        const grant = await verifyLinkGrant(body.grant, { keys });
        if (!grant.ok) return json(401, { error: "a fresh link grant is needed", code: grant.error });
        const done = await stub.register({ id, acct: grant.acct, verifier: body.verifier });
        return done.ok ? json(200, { ok: true }) : json(done.status, { error: "this tunnel belongs to another account", code: done.code });
      }
      if (!action && method === "DELETE") {
        const token = bearerOf(request);
        return token && (await stub.forget(token)) ? json(200, { ok: true }) : json(404, { error: "not found", code: "unknown_tunnel" });
      }
      if ((action === "vps" || action === "app") && method === "GET") {
        if (await limited(env.CONNECT_LIMITER, ip)) return json(429, { error: "too many requests", code: "rate_limited" }, { "retry-after": "10" });
        if (!bearerOf(request)) return json(404, { error: "not found", code: "unknown_tunnel" });
        return stub.fetch(request);
      }
      return json(405, { error: "method not allowed" });
    }

    // the owner's relay controls, the link service's shape (GET stats, GET/PUT limits); /v1 too, like the other ops routes
    const relayOps = /^(?:\/v1)?\/ops\/relay\/(stats|limits)$/.exec(url.pathname);
    if (relayOps) {
      if (!(await opsAllowed(request, env))) return json(404, { error: "not found" });
      const ops = env.OPS.get(env.OPS.idFromName("ops"));
      if (relayOps[1] === "stats" && method === "GET") return json(200, await ops.stats());
      if (relayOps[1] === "limits" && method === "GET") return json(200, { limits: await ops.limits() });
      if (relayOps[1] === "limits" && method === "PUT") {
        const body = await readSmallJson(request);
        if (!body) return json(400, { error: "send the limits as json", code: "bad_request" });
        const done = await ops.setLimits(body);
        return done.ok ? json(200, { ok: true, limits: done.limits }) : json(400, { error: done.error, code: "bad_limits" });
      }
      return json(405, { error: "method not allowed" });
    }

    const opsPath = /^\/v1\/ops\/(usage|tunnel)(?:\/([0-9a-f]{32}|[a-z2-7]{10}))?$/.exec(url.pathname);
    if (opsPath && method === "GET") {
      if (!(await opsAllowed(request, env))) return json(404, { error: "not found" });
      const [, what, which] = opsPath;
      if (what === "tunnel" && which && TUNNEL_ID.test(which)) return json(200, await env.TUNNELS.get(env.TUNNELS.idFromName(which)).stats());
      if (what === "usage" && which && ACCT.test(which)) return json(200, await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(which)).usage());
      if (what === "usage" && !which) {
        const month = MONTH.test(url.searchParams.get("month") ?? "") ? url.searchParams.get("month") : monthOf(Date.now());
        const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
        return json(200, await env.OPS.get(env.OPS.idFromName("ops")).top({ month, limit }));
      }
    }
    return json(404, { error: "not found" });
  },
};
