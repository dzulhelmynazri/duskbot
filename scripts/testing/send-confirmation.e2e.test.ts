import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { launchVerificationServer, runControlMadani } from "../control-madani.ts";
import { publishLiveFrame } from "../../src/lib/live-events.ts";
import { sendReconciled } from "../../src/state/optimistic-send.ts";
import type { WireBot, WireMessage } from "../../shared/wire.ts";
import { openSse } from "../../server/testing/sse.ts";

it("confirms a send through SSE while its relay response is held, without stopping or duplicating the real turn", async () => {
  const fixture = await launchVerificationServer({});
  const api = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(fixture.info.url + path, { ...init,
      headers: { origin: fixture.info.url, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) });
    const body = await response.json();
    expect(response.ok, JSON.stringify(body)).toBe(true);
    return body as T;
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  let responseAborted = false;
  let responseReleased = false;
  const proxy = createServer(async (req, res) => {
    const request = new AbortController();
    res.once("close", () => { if (!res.writableEnded) { responseAborted = true; request.abort(); } });
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests += 1;
      const upstream = await fetch(fixture.info.url + req.url, {
        method: "POST", body: Buffer.concat(chunks),
        headers: { origin: fixture.info.url, "content-type": "application/json" }, signal: request.signal,
      });
      const body = await upstream.text();
      await held;
      if (!res.destroyed) { responseReleased = true; res.writeHead(upstream.status, { "content-type": "application/json" }); res.end(body); }
    } catch (error) {
      if (!request.signal.aborted) { res.statusCode = 502; res.end(String(error)); }
    }
  });
  let stream: Awaited<ReturnType<typeof openSse>> | undefined;
  const evidence: Record<string, unknown> = { fixture: fixture.info };
  try {
    const { bots } = await api<{ bots: WireBot[] }>("/api/bots?messages=0");
    const bot = bots[0];
    await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ computer: "off", browser: false }) });
    stream = await openSse(`${fixture.info.url}/api/events?screens=off`, { origin: fixture.info.url });
    await stream.until((frame) => frame.kind === "hello");
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/api/bots/${bot.id}/messages`;
    const sendId = randomUUID();
    const text = "Confirm this fixture send while its HTTP receipt is unavailable";
    const started = performance.now();
    const observed = stream.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.sendId === sendId)
      .then((frame) => { evidence.canonicalSseMs = performance.now() - started; publishLiveFrame(frame); return frame; });
    const result = await sendReconciled(async (signal) => {
      const response = await fetch(endpoint, { method: "POST", signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ text, threadId: bot.threadId, sendId }) });
      return response.json();
    }, () => false, undefined, { threadId: bot.threadId, sendId, text });
    const canonical = await observed;
    expect(result).toEqual({ arrived: true });
    expect(responseReleased).toBe(false);
    await vi.waitFor(() => expect(responseAborted).toBe(true));
    const settled = await runControlMadani(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "15", "--url", fixture.info.url]) as { status: string };
    expect(settled.status).toBe("settled");
    const post = { method: "POST", body: JSON.stringify({ text, threadId: bot.threadId, sendId }) };
    const duplicates = await Promise.all(Array.from({ length: 10 }, () => api<{ message?: WireMessage }>(`/api/bots/${bot.id}/messages`, post)));
    expect(duplicates.every((receipt) => receipt.message?.id === canonical.message.id)).toBe(true);
    const { messages } = await api<{ messages: WireMessage[] }>(`/api/threads/${bot.threadId}/messages?limit=200`);
    expect(messages.filter((message: { sendId?: string }) => message.sendId === sendId)).toHaveLength(1);
    expect(messages.some((message: { text?: string }) => message.text === "hello from fake claude")).toBe(true);
    expect(requests).toBe(1);
    evidence.confirmedBeforeHttpRelease = true;
    evidence.transportAborted = responseAborted;
    evidence.providerSettledAfterTransportAbort = settled.status;
    evidence.canonicalCopiesAfterTenRetries = 1;
  } finally {
    release();
    stream?.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    writeFileSync(`${fixture.info.logPath}.send-confirmation.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    await fixture.close();
  }
}, 30_000);
