// A phone paired through this computer's relay (electron/phone-relay.mjs) holds a harness session the sidecar never saw
// redeemed. When the relay is down it falls back to its Wi-Fi or Tailscale address here, and apps 1.2 and 1.2.1 unpair
// themselves on a 401 from /api/auth/session, so an unknown session is asked about at the harness instead of refused.
//
// Security invariants:
// - a session is admitted only when the harness itself says it is a live paired phone (`/api/mobile/device` 200, which
//   needs that session); every later request is still authorized by the harness as that remote session.
// - lookups are capped per minute and refusals remembered, so a LAN client cannot use the sidecar to test tokens at speed;
//   the harness sees the phone's own address (x-forwarded-for), never loopback trust.
// - a 401 reaches the phone only for a session this workspace really ended: a session the running workspace has never
//   known (another local workspace is open) answers 503, which every app version reads as "try again later".
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";

const LOOKUPS_PER_MINUTE = 30;
/** one address's share of the lookups, so one LAN client cannot spend them all */
const LOOKUPS_PER_ADDRESS = 10;
const REFUSED_MS = 60_000;
const REFUSED_MAX = 256;

export type Admission =
  | { kind: "phone"; deviceId: string; environmentId: string | null }
  | { kind: "not-phone" }
  | { kind: "unknown" }
  | { kind: "limited" }
  | { kind: "down" };

interface Answer { status: number; body: unknown }

/** a phone told it may try later; not 401 (unpairs every app version) and not 403/404 (Android 1.2.1 took those as ok) */
export const NOT_HERE = {
  status: 503,
  body: { error: "This phone is paired with a workspace that is not open on this computer.", code: "not_here" },
} as const;

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

function ask(port: number, path: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, method: "GET", path, headers: { accept: "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) { req.destroy(new Error("answer too large")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        let body: unknown = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        resolve({ status: res.statusCode ?? 502, body });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error("harness timed out")));
    req.on("error", reject);
    req.end();
  });
}

const environmentIdOf = (body: unknown): string | null => {
  const value = (body as { environmentId?: unknown } | null)?.environmentId;
  return typeof value === "string" && value.length <= 200 ? value : null;
};

export function createMobileAdmission({ harnessPort, now = Date.now }: { harnessPort: number; now?: () => number }) {
  const lookups: Array<{ at: number; from: string }> = [];
  const refused = new Map<string, number>();
  const asking = new Map<string, Promise<Admission>>();

  return {
    /** asks the harness whether `token` is one of its live paired phones; `from` is the client's own address, and
     * requests carrying the same token at once share one lookup */
    admit(token: string, remote: Record<string, string>, from: string): Promise<Admission> {
      const hash = hashOf(token);
      const t = now();
      for (const [key, until] of refused) if (until <= t) refused.delete(key);
      if ((refused.get(hash) ?? 0) > t) return Promise.resolve({ kind: "unknown" });
      const pending = asking.get(hash);
      if (pending) return pending;
      while (lookups.length && lookups[0].at <= t - 60_000) lookups.shift();
      if (lookups.length >= LOOKUPS_PER_MINUTE || lookups.filter((one) => one.from === from).length >= LOOKUPS_PER_ADDRESS) return Promise.resolve({ kind: "limited" });
      lookups.push({ at: t, from });
      const lookup = this.lookup(hash, token, remote).finally(() => asking.delete(hash));
      asking.set(hash, lookup);
      return lookup;
    },
    async lookup(hash: string, token: string, remote: Record<string, string>): Promise<Admission> {
      const t = now();
      const headers = { ...remote, authorization: `Bearer ${token}` };
      let device: Answer, session: Answer;
      try {
        [device, session] = await Promise.all([ask(harnessPort, "/api/mobile/device", headers), ask(harnessPort, "/api/auth/session", headers)]);
      } catch {
        return { kind: "down" };
      }
      if (device.status === 401 || session.status === 401) {
        if (refused.size >= REFUSED_MAX) refused.delete(refused.keys().next().value!);
        refused.set(hash, t + REFUSED_MS);
        return { kind: "unknown" };
      }
      const deviceId = (device.body as { device?: { id?: unknown } } | null)?.device?.id;
      if (device.status === 200 && session.status === 200 && typeof deviceId === "string" && /^[\w-]{1,128}$/.test(deviceId)) {
        return { kind: "phone", deviceId, environmentId: environmentIdOf(session.body) };
      }
      return device.status === 404 && session.status === 200 ? { kind: "not-phone" } : { kind: "down" };
    },
    /** the running workspace's id, or null when the harness did not say */
    async environment(): Promise<string | null> {
      try {
        const answer = await ask(harnessPort, "/.well-known/madanibot/environment", {});
        return answer.status === 200 ? environmentIdOf(answer.body) : null;
      } catch {
        return null;
      }
    },
  };
}

/** a remembered phone's 401 ends it only when the workspace that paired it is known to be the one answering; a phone
 * remembered without its workspace keeps the plain 401 */
export async function sessionEndedHere(remembered: string | null, current: () => Promise<string | null>): Promise<boolean> {
  if (!remembered) return true;
  return (await current()) === remembered;
}
