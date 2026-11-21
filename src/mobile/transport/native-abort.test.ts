import { describe, expect, it, vi } from "vitest";
import { honorAbort, installNativeAbort } from "./native-abort";

/** CapacitorHttp's fetch patch: never looks at the signal, answers only when URLSession does */
const nativeFetch = () => {
  let answer!: (response: Response) => void;
  const send = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { answer = resolve; }));
  return { send: send as unknown as typeof fetch & typeof send, answer: (response: Response) => answer(response) };
};

describe("native http that ignores its signal", () => {
  it("settles a hung POST when its signal times out, so a send can ask again", async () => {
    const native = nativeFetch();
    const controller = new AbortController();
    const result = honorAbort(native.send)("http://192.168.1.20:8810/api/bots/b/messages", { method: "POST", body: "{}", signal: controller.signal });
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    native.answer(new Response("late"));
  });

  it("reads the signal of a Request too, and refuses an already aborted one without sending", async () => {
    const native = nativeFetch();
    const controller = new AbortController();
    const result = honorAbort(native.send)(new Request("https://link.madani.bot/v1/channels/c/to-vps", { method: "POST", body: "{}", signal: controller.signal }));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    const before = native.send.mock.calls.length;
    await expect(honorAbort(native.send)("https://x.test/", { signal: AbortSignal.abort() })).rejects.toBeDefined();
    expect(native.send.mock.calls.length).toBe(before);
  });

  it("passes the answer through unchanged, with or without a signal", async () => {
    for (const signal of [undefined, new AbortController().signal]) {
      const native = nativeFetch();
      const result = honorAbort(native.send)("https://x.test/", signal ? { signal } : undefined);
      const response = new Response("ok", { status: 201 });
      native.answer(response);
      await expect(result).resolves.toBe(response);
    }
  });

  it("wraps a page's fetch once", () => {
    const target = { fetch: nativeFetch().send };
    installNativeAbort(target);
    const first = target.fetch;
    installNativeAbort(target);
    expect(target.fetch).toBe(first);
  });
});
