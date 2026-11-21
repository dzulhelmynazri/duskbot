// What the Worker and its hook queue both ask the account service, and how either one reaches a home.
export const LABEL = /^d[0-9a-f]{20}$/;
/** a home answering with one of these is not up (yet), whatever the route says */
export const DOWN = [502, 503, 504, 521, 522, 523];
/** a hung account service must not pin a Worker request or the queue's alarm: it reads as unavailable */
export const ROUTE_TIMEOUT_MS = 8_000;

/**
 * The account services this edge fronts: ROUTE_URL is one origin or several, comma-separated (preview and production
 * share one public domain); EDGE_TOKEN is one token for all, or one per origin in the same order. A label belongs to
 * exactly one service, so the order only decides who is asked first.
 */
export function routeServices(env) {
  const origins = String(env.ROUTE_URL).split(",").map(item => item.trim()).filter(Boolean);
  const tokens = String(env.EDGE_TOKEN).split(",").map(item => item.trim()).filter(Boolean);
  if (!origins.length || (tokens.length !== 1 && tokens.length !== origins.length)) throw new Error("ROUTE_URL and EDGE_TOKEN do not match");
  return origins.map((origin, i) => ({ origin, token: tokens.length === 1 ? tokens[0] : tokens[i] }));
}
/** which service answered for a label, per isolate, so its wake goes to the same one */
const owners = new Map();
const MAX_OWNERS = 10_000;

/** the account service's answer for a label, never cached: null when no service maps it to a home */
export async function lookupRoute(label, env) {
  let failure = null;
  for (const service of routeServices(env)) {
    const answer = await fetch(`${service.origin}/v1/managed/edge/route?label=${label}`, { headers: { authorization: `Bearer ${service.token}` }, signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS) }).catch(error => { failure = error; return null; });
    if (answer?.status === 404) { await answer.body?.cancel().catch(() => {}); continue; }
    if (answer?.status === 410) { await answer.body?.cancel().catch(() => {}); return { gone: true }; }
    if (!answer?.ok) { if (answer) { await answer.body?.cancel().catch(() => {}); failure = new Error("route lookup failed"); } continue; }
    const body = await answer.json();
    if (typeof body.upstream !== "string" || !body.upstream.startsWith("https://")) return null;
    if (owners.size >= MAX_OWNERS) owners.clear();
    owners.set(label, service.origin);
    return { upstream: body.upstream, awake: body.awake !== false, wakeable: body.wakeable === true };
  }
  // a service that did not answer may be the one that knows the label: not "missing", which would be cached
  if (failure) throw failure;
  return null;
}

/** asks the label's service to wake its home: 200 awake, 202 waking, 429 over its hourly cap, 409 not wakeable, 503 unreachable */
export async function askWake(label, reason, env) {
  const services = routeServices(env);
  if (!owners.has(label) && services.length > 1) await lookupRoute(label, env).catch(() => null);
  const service = services.find(item => item.origin === owners.get(label)) ?? services[0];
  const asked = await fetch(`${service.origin}/v1/managed/edge/wake?label=${label}&reason=${reason}`, { method: "POST", headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS) }).catch(() => null);
  await asked?.body?.cancel().catch(() => {});
  if (!asked) return 503;
  if (asked.status === 429 || asked.status === 409) return asked.status;
  return asked.ok ? asked.status : 503;
}

/** a request to the home as the client sent it, under the public name the home keeps (MADANI_PUBLIC_URL) */
export function upstreamRequest(upstream, host, { method, path, headers, body }) {
  const sent = new Headers(headers);
  sent.set("x-forwarded-host", host);
  const init = { method, headers: sent, redirect: "manual" };
  if (body !== undefined && body !== null) init.body = body;
  return new Request(new URL(path, upstream), init);
}
