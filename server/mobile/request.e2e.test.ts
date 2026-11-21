import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-madani.ts";
import type { MobilePairingResponse, MobileRedeemResponse } from "../../shared/mobile-link.ts";
import { sessionCookieName } from "../request-auth.ts";

it("serves a redeemed phone's JSON, upload, download and SSE with bearer-only CORS", async () => {
  const fixture = await launchVerificationServer({ MADANI_DEV_TRUST_LOCAL_BROWSER: "0" });
  const base = fixture.info.url;
  const origin = "capacitor://localhost";
  const jsonHeaders = { "content-type": "application/json" };
  const checkCors = (response: Response) => {
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  };
  try {
    const pairing = await fetch(`${base}/api/mobile/pairing`, { method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ companion: [{ url: "http://192.168.1.4:8810", kind: "lan", priority: 30 }] }) });
    expect(pairing.status).toBe(200);
    const { payload } = await pairing.json() as MobilePairingResponse;
    const redeemed = await fetch(`${base}/api/mobile/redeem`, { method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ secret: payload.grant.secret, attemptId: "cors-fixture-0001", device: { name: "Fixture phone", platform: "ios" } }) });
    expect(redeemed.status).toBe(200);
    const phone = await redeemed.json() as MobileRedeemResponse;
    const headers = { origin, authorization: `Bearer ${phone.token}` };

    for (const [path, method] of [["/api/bots", "GET"], ["/api/attachments", "POST"], ["/api/events", "GET"]]) {
      const preflight = await fetch(`${base}${path}`, { method: "OPTIONS", headers: { origin,
        "access-control-request-method": method, "access-control-request-headers": "authorization, content-type, last-event-id, x-madani-background" } });
      expect(preflight.status).toBe(204);
      checkCors(preflight);
      expect(preflight.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type, Last-Event-ID, X-Madani-Background");
    }
    const bots = await fetch(`${base}/api/bots`, { headers });
    expect(bots.status).toBe(200);
    checkCors(bots);
    expect((await bots.json() as { bots: unknown[] }).bots).toHaveLength(1);

    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const upload = await fetch(`${base}/api/attachments`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: image });
    expect(upload.status).toBe(201);
    checkCors(upload);
    const attachment = await upload.json() as { path: string };
    const download = await fetch(`${base}/api/attachments/${basename(attachment.path)}`, { headers });
    expect(download.status).toBe(200);
    checkCors(download);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(image);

    const controller = new AbortController();
    try {
      const events = await fetch(`${base}/api/events?screens=off`, { headers: { ...headers, accept: "text/event-stream" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      expect(events.status).toBe(200);
      checkCors(events);
      expect(events.headers.get("content-type")).toContain("text/event-stream");
      const reader = events.body!.getReader();
      let text = "";
      while (!text.includes('"kind":"hello"')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain('"kind":"hello"');
      await reader.cancel();
    } finally { controller.abort(); }

    expect(payload.workspace.environmentId).toBeTruthy();
    const cookieName = sessionCookieName(Number(new URL(base).port), payload.workspace.environmentId!);
    for (const rejectedHeaders of [{ origin }, { origin, cookie: `${cookieName}=${phone.token}` }, { origin: "https://evil.example" }]) {
      const refused = await fetch(`${base}/api/bots`, { headers: rejectedHeaders });
      expect(refused.status).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
      await refused.arrayBuffer();
    }
    const revoked = await fetch(`${base}/api/mobile/devices/${phone.device.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    await revoked.arrayBuffer();
    const refused = await fetch(`${base}/api/bots`, { headers });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    await refused.arrayBuffer();
    expect(readFileSync(fixture.info.logPath, "utf8").includes(phone.token)).toBe(false);
  } finally {
    await fixture.close();
  }
}, 60_000);
