// the app side of a chaos run: the desktop app's own relay code (createTunnelProxy, following its server across nodes)
// in a process the harness can freeze (a laptop asleep) and drive over ipc
import { fileURLToPath } from "node:url";

import { createTunnelProxy } from "../../../electron/vps-link-protocol.mjs";
import { loadDataChannel, rtcConnector } from "../../../electron/vps-link-rtc.mjs";

let proxy = null, through = null;
const log = (line) => console.error(`${new Date().toISOString().slice(11, 23)} ${line}`);
const ops = {
  async start(link) {
    proxy = createTunnelProxy({ base: link.base, id: link.id, key: link.key, token: link.token, log, follow: true, hello: { protocol: 2, app: "chaos" }, proxy: () => through });
    const origin = await proxy.start();
    // MADANI_CHAOS_DIRECT=rtc: the webrtc direct path on top, as the app sets it up for an agent that offers direct-rtc
    if (process.env.MADANI_CHAOS_DIRECT === "rtc") {
      const ndc = loadDataChannel([fileURLToPath(new URL("../../..", import.meta.url))]);
      if (!ndc) throw new Error("node-datachannel is not installed here");
      proxy.useDirect({ connect: rtcConnector({ ndc, signal: (offer) => proxy.control("direct-rtc", { offer }, 15_000) }), pingMs: 2000 });
    }
    return { origin };
  },
  nudge() { proxy?.nudge(); return { ok: true }; },
  /** what the system's proxy setting would say for every url: { host, port } or null (DIRECT) */
  useProxy(value) { through = value ?? null; return { ok: true }; },
  node() { return { node: proxy?.node() ?? null, via: proxy?.directVia?.() ?? null }; },
  control({ op, data, timeoutMs }) { return proxy.control(op, data, timeoutMs); },
  async close() { await proxy?.close(); return { ok: true }; },
};
process.on("message", (message) => {
  if (!message || message.chaos || !ops[message.op]) return;
  Promise.resolve().then(() => ops[message.op](message.data)).then(
    (data) => process.send({ seq: message.seq, data }),
    (error) => process.send({ seq: message.seq, error: error?.message ?? String(error) }),
  );
});
