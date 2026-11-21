// This computer's end of "browse through this computer's connection when a site blocks the cloud" for the person's
// madani cloud home (My Cloud). A linked VPS gets this over its own link (vps-link-egress.mjs, via the link agent); a
// cloud home has no link agent and is reached over its own https, so this keeps one websocket there while the home is
// awake and hands it to the same egress endpoint, which checks and opens every connection on this computer. It never
// wakes a sleeping home and never pairs a new device: it uses the app's own session cookie there.
import { encodeBytes, encodeControl, linkReader } from "./egress-link-codec.mjs";

export const HOME_EGRESS_LINK_PATH = "/api/computer/egress/link";
export const CHECK_MS = 15_000;
export const RETRY_MS = [5_000, 15_000, 30_000, 60_000, 2 * 60_000];

/**
 * @param {{
 *   origin(): string | null,
 *   awake(): boolean,
 *   cookie(origin: string): Promise<string | null>,
 *   connect(url: string, headers: Record<string, string>): Promise<{ readable: import("node:stream").Duplex, close(): void }>,
 *   endpoint(tunnel: { send(frame: object): boolean, bytes(r: string, chunk: Buffer): boolean, queued(): number, onDrain(fn: () => void): void }): { start(): void, handle(frame: object, via?: string): boolean, close(): void },
 *   log?(line: string): void, now?(): number, checkMs?: number,
 * }} deps
 */
export function createHomeEgressLink(deps) {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  let current = null, connecting = false, failures = 0, retryAt = 0, closed = false;

  function drop(why) {
    if (!current) return;
    const { duplex, endpoint, origin } = current;
    current = null;
    endpoint.close();
    duplex.destroy();
    if (why) log(`home egress: ${origin} link closed (${why})`);
  }

  async function open(origin) {
    connecting = true;
    try {
      const cookie = await deps.cookie(origin);
      if (!cookie) return;
      const url = `${origin.replace(/^http/u, "ws")}${HOME_EGRESS_LINK_PATH}`;
      const link = await deps.connect(url, { cookie, origin });
      const duplex = link.readable;
      if (closed || deps.origin() !== origin || !deps.awake()) { duplex.destroy(); return; }
      const endpoint = deps.endpoint({
        send: (frame) => !duplex.destroyed && duplex.write(encodeControl(frame)),
        bytes: (r, chunk) => !duplex.destroyed && duplex.write(encodeBytes(r, chunk)),
        queued: () => duplex.writableLength,
        onDrain: (fn) => duplex.once("drain", fn),
      });
      const entry = { duplex, endpoint, origin };
      current = entry;
      const read = linkReader((frame) => endpoint.handle(frame, "relay"));
      duplex.on("data", (chunk) => { try { read(chunk); } catch (error) { log(`home egress: ${error?.message ?? error}`); duplex.destroy(); } });
      // a home that went to sleep drops the link too: wait a minute, so a stale "awake" never dials it awake again
      duplex.once("close", () => { if (current === entry) { drop("closed"); failures = 0; retryAt = now() + RETRY_MS[3]; } });
      duplex.on("error", () => {});
      endpoint.start();
      failures = 0;
      log(`home egress: ${origin} can browse through this computer`);
    } catch (error) {
      retryAt = now() + RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];
      failures += 1;
      // an older home without the route answers 404: no point asking often
      if (error?.status === 404) retryAt = now() + 30 * 60_000;
      log(`home egress: could not link ${origin} (${error?.message ?? error})`);
    } finally { connecting = false; }
  }

  function check() {
    if (closed) return;
    const origin = deps.origin();
    const awake = deps.awake();
    if (current && (current.origin !== origin || !awake)) drop(awake ? "another home" : "the home sleeps");
    if (!current && !connecting && origin && awake && now() >= retryAt) void open(origin);
  }

  const timer = setInterval(check, deps.checkMs ?? CHECK_MS);
  timer.unref?.();
  return {
    check,
    linked: () => Boolean(current),
    close() { closed = true; clearInterval(timer); drop(null); },
  };
}
