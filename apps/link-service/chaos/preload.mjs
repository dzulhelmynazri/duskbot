// loaded into the agent and app processes of a chaos run: a moved clock (MADANI_CHAOS_SKEW_MS) and name lookups that fail
// or answer one address family, switched over ipc ({ chaos: "dns", mode: "fail" | "v4" | "v6" | null })
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const skew = Number(process.env.MADANI_CHAOS_SKEW_MS || 0);
if (skew) {
  const real = Date.now;
  Date.now = () => real() + skew;
}

let mode = null;
const lookup = dns.lookup;
dns.lookup = function chaosLookup(host, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  if (typeof options === "number") options = { family: options };
  if (mode === "fail") {
    const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host });
    process.nextTick(callback, error);
    return {};
  }
  const family = mode === "v4" ? 4 : mode === "v6" ? 6 : options?.family;
  return lookup.call(this, host, { ...options, family }, callback);
};
// `import { lookup } from "node:dns"` elsewhere sees the replacement only after this
syncBuiltinESMExports();
process.on("message", (message) => { if (message?.chaos === "dns") mode = message.mode ?? null; });

// MADANI_CHAOS_PORTS="443:9443,...": this process reaches a port through its own fault proxy, so a fault can hit only the
// app's network or only the server's
const ports = new Map(String(process.env.MADANI_CHAOS_PORTS || "").split(",").filter(Boolean).map((pair) => pair.split(":").map(Number)));
if (ports.size) {
  const { Socket } = await import("node:net");
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function chaosConnect(...args) {
    const first = args[0];
    if (Array.isArray(first) && first[0] && typeof first[0] === "object" && ports.has(Number(first[0].port))) first[0] = { ...first[0], port: ports.get(Number(first[0].port)) };
    else if (first && typeof first === "object" && !Array.isArray(first) && ports.has(Number(first.port))) args[0] = { ...first, port: ports.get(Number(first.port)) };
    else if ((typeof first === "number" || typeof first === "string") && ports.has(Number(first))) args[0] = ports.get(Number(first));
    return connect.apply(this, args);
  };
}

// a chaos run's processes end with it, however it ends
const parent = Number(process.env.MADANI_CHAOS_PARENT || 0);
if (parent) setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 1000).unref();
