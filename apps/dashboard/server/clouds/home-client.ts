import { createHash, createHmac, randomBytes } from "node:crypto";
import type { HomeClient } from "./types.ts";
import { boundedJson } from "./http.ts";
import { withLegacyHeaders } from "../../../../electron/legacy-names.mjs";

export function signCloudRequest(secret: string, timestamp: string, nonce: string, method: string, target: string, body: string | Buffer): string {
  const hash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\n${method}\n${target}\n${hash}`).digest("base64url");
}

export function createHomeClient(options: { fetch?: typeof fetch; now?: () => number; random?: (size: number) => Buffer } = {}): HomeClient {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now, random = options.random ?? randomBytes;
  async function request(origin: string, secret: string, method: string, target: string, body = ""): Promise<unknown> {
    try {
      const url = new URL(origin);
      if (origin !== url.origin || url.username || url.password || (url.protocol !== "https:" || !url.hostname.includes("."))) throw new Error();
      const timestamp = String(Math.floor(now() / 1000)), nonce = random(24).toString("base64url");
      if (!/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) throw new Error();
      const response = await fetcher(`${origin}${target}`, {
        method, redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: withLegacyHeaders({ "content-type": "application/json", "x-madani-cloud-timestamp": timestamp, "x-madani-cloud-nonce": nonce, "x-madani-cloud-signature": `v1=${signCloudRequest(secret, timestamp, nonce, method, target, body)}` }),
        ...(method === "POST" ? { body } : {}),
      });
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(), { status: response.status }); }
      return await boundedJson(response, method === "POST" ? 4096 : 65_536);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      throw Object.assign(new Error("Cloud home request failed."), typeof status === "number" ? { status } : {});
    }
  }
  return {
    async power(origin, secret, idleMinutes) {
      const value = await request(origin, secret, "GET", `/api/cloud/power?idleMinutes=${Math.round(idleMinutes)}`) as Record<string, unknown> | null;
      if (!value || value.v !== 1 || typeof value.idle !== "boolean" || !Array.isArray(value.busy)) throw new Error("Invalid cloud power answer.");
      const moment = (v: unknown) => Number.isSafeInteger(v) ? v as number : null;
      const upcoming = Array.isArray(value.upcoming) ? value.upcoming.slice(0, 96).flatMap((r: unknown) => {
        const at = moment((r as { at?: unknown })?.at), flex = (r as { flexMs?: unknown })?.flexMs;
        return at === null ? [] : [{ at, flexMs: Number.isSafeInteger(flex) && (flex as number) >= 0 && (flex as number) <= 3_600_000 ? flex as number : 0 }];
      }) : undefined;
      return { idle: value.idle, busy: value.busy.filter((b): b is string => typeof b === "string" && /^[a-z-]{1,32}$/.test(b)), lastActivityAt: moment(value.lastActivityAt), lastWorkAt: moment(value.lastWorkAt), nextDueAt: moment(value.nextDueAt), wokeAt: moment(value.wokeAt),
        ...(upcoming ? { upcoming } : {}),
        ...(Array.isArray(value.stuck) && value.stuck.length ? { stuck: value.stuck.slice(0, 8).filter((b): b is string => typeof b === "string" && /^[a-z-]{1,32}$/.test(b)) } : {}) };
    },
    async sleep(origin, secret, idleMinutes, options) {
      try {
        const value = await request(origin, secret, "POST", "/api/cloud/power/sleep", JSON.stringify({ v: 1, idleMinutes: Math.round(idleMinutes), ...(options?.force ? { force: true } : {}) })) as Record<string, unknown> | null;
        return { ok: value?.ok === true, nextDueAt: Number.isSafeInteger(value?.nextDueAt) ? value!.nextDueAt as number : null };
      } catch { return { ok: false, nextDueAt: null }; }
    },
    async entitle(origin, secret, token, linkGrant) {
      const value = await request(origin, secret, "POST", "/api/cloud/entitlement", JSON.stringify({ v: 1, token, ...(linkGrant ? { linkGrant } : {}) })) as { ok?: unknown; expiresAt?: unknown } | null;
      if (value?.ok !== true || !Number.isSafeInteger(value.expiresAt)) throw new Error("Invalid cloud entitlement answer.");
      return { expiresAt: value.expiresAt as number };
    },
    async update(origin, secret) {
      const value = await request(origin, secret, "GET", "/api/cloud/update") as Record<string, unknown> | null;
      if (!value || value.v !== 1) throw new Error("Invalid cloud update answer.");
      const selfTest = ["running", "passed", "failed"].includes(value.selfTest as string) ? value.selfTest as "running" | "passed" | "failed" : null;
      const runs = Array.isArray(value.runs) ? value.runs.slice(0, 20).flatMap((r: unknown) => {
        const run = r as { id?: unknown; ok?: unknown; at?: unknown };
        return typeof run?.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(run.id) && typeof run.ok === "boolean" && Number.isSafeInteger(run.at) ? [{ id: run.id, ok: run.ok, at: run.at as number }] : [];
      }) : [];
      return { version: typeof value.version === "string" && /^\d+\.\d+\.\d+$/.test(value.version) ? value.version : null, selfTest, runs };
    },
    async plan(origin, secret, input) {
      await request(origin, secret, "POST", "/api/cloud/plan", JSON.stringify({ v: 1, cancelled: input.cancelled }));
    },
    async signIns(origin, secret, items) {
      const value = await request(origin, secret, "POST", "/api/cloud/ai-signins", JSON.stringify({ v: 1, items })) as { ok?: unknown } | null;
      if (value?.ok !== true) throw new Error("Invalid cloud sign-ins answer.");
    },
    async pair(origin, secret, input) {
      const value = await request(origin, secret, "POST", "/api/cloud/pairing", JSON.stringify(input)) as { code?: unknown; expiresAt?: unknown } | null;
      if (!value || typeof value.code !== "string" || !/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(value.code) || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= now() || (value.expiresAt as number) > now() + 600_000) throw new Error("Invalid cloud pairing answer.");
      return { code: value.code, expiresAt: value.expiresAt as number };
    },
    async memberLeft(origin, secret, email) {
      const value = await request(origin, secret, "POST", "/api/cloud/team/member-left", JSON.stringify({ v: 1, email })) as { ok?: unknown } | null;
      if (value?.ok !== true) throw new Error("Invalid cloud member-left answer.");
    },
    async healthy(origin, secret) {
      try {
        const answer = await request(origin, secret, "GET", "/api/cloud/health?after=0") as { v?: unknown } | null;
        return answer?.v === 1;
      } catch { return false; }
    },
  };
}
