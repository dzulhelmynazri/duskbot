#!/usr/bin/env node
// Points https://<label>.<domain> at the edge Worker on Cloudflare: a proxied wildcard record, the Worker route
// *.<domain>/*, and a route with no Worker for every other proxied host of the zone so the wildcard route never takes
// them (Cloudflare picks the most specific route). Idempotent; rerun after adding a proxied host to the zone.
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... node apps/cloud-service/scripts/edge-routes.mjs madani.bot madani-edge
const [domain, script] = process.argv.slice(2);
const token = process.env.CLOUDFLARE_API_TOKEN, zone = process.env.CLOUDFLARE_ZONE_ID;
if (!domain || !script || !token || !zone) { console.error("usage: CLOUDFLARE_API_TOKEN=.. CLOUDFLARE_ZONE_ID=.. edge-routes.mjs <domain> <worker>"); process.exit(2); }
const api = async (path, init = {}) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const body = await response.json();
  if (!body.success) throw new Error(`${init.method ?? "GET"} ${path}: ${JSON.stringify(body.errors)}`);
  return body.result;
};
const wildcard = `*.${domain}`;
const records = await api("/dns_records?per_page=500");
const hosts = records.filter(r => ["A", "AAAA", "CNAME"].includes(r.type) && r.proxied && r.name !== wildcard && r.name.endsWith(`.${domain}`)).map(r => r.name);
if (!records.some(r => r.name === wildcard)) {
  await api("/dns_records", { method: "POST", body: JSON.stringify({ type: "A", name: wildcard, content: "192.0.2.1", proxied: true, comment: "managed homes: answered by the edge Worker" }) });
  console.log(`dns: added proxied ${wildcard}`);
} else console.log(`dns: ${wildcard} exists`);
const routes = await api("/workers/routes");
async function ensure(pattern, worker) {
  const found = routes.find(r => r.pattern === pattern);
  if (found && (found.script ?? null) === worker) { console.log(`route: ${pattern} -> ${worker ?? "(no worker)"} ok`); return; }
  if (found) await api(`/workers/routes/${found.id}`, { method: "PUT", body: JSON.stringify({ pattern, ...(worker ? { script: worker } : {}) }) });
  else await api("/workers/routes", { method: "POST", body: JSON.stringify({ pattern, ...(worker ? { script: worker } : {}) }) });
  console.log(`route: ${pattern} -> ${worker ?? "(no worker)"} set`);
}
for (const host of hosts) await ensure(`${host}/*`, null);
await ensure(`${wildcard}/*`, script);
