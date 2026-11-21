// Madani clouds the edge said were deleted (410 with x-madani-cloud-power: gone). Main's
// background work (settings and connector sync, Files, the inbox counts, the egress link, focus pings) leaves such an
// origin alone for the rest of this run: its fetch answers the same 410 without the network, and the lists the syncers
// walk leave it out, so nothing polls an address that will never answer again.
import { goneAnswer } from "./cloud-power.mjs";

const originOf = (value) => { try { return new URL(String(value)).origin; } catch { return null; } };

/** The edge's own answer, made here for an origin already known to be gone. */
export const goneResponse = () => new Response("This madani bot was deleted.", { status: 410, headers: { "content-type": "text/plain; charset=utf-8", "x-madani-cloud-power": "gone" } });

export function createCloudGone({ log = () => {} } = {}) {
  const gone = new Set();
  const listeners = new Set();
  const isGone = (origin) => { const at = originOf(origin); return at !== null && gone.has(at); };
  function note(origin) {
    const at = originOf(origin);
    if (!at || gone.has(at)) return;
    gone.add(at);
    log(`cloud gone: ${at} was deleted; background work stops calling it`);
    for (const listener of listeners) { try { listener(at); } catch {} }
  }
  return {
    isGone,
    note,
    onCloudGone(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** `origin` itself, or null once it is gone. */
    live: (origin) => (origin && !isGone(origin) ? origin : null),
    /** `entries` without the ones whose origin is gone. */
    keep: (entries) => entries.filter((entry) => !entry?.origin || !isGone(entry.origin)),
    /** A fetch that learns gone origins from their answers and never calls one again. */
    wrap(fetchImpl) {
      return async (input, init) => {
        const at = originOf(typeof input === "string" || input instanceof URL ? input : input?.url);
        if (at && gone.has(at)) return goneResponse();
        const response = await fetchImpl(input, init);
        if (at && goneAnswer(response)) note(at);
        return response;
      };
    },
  };
}
