import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCloudPowerForTests } from "../lib/cloud-power";
import { t } from "../lib/i18n";
import { api, ApiError } from "./store";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetCloudPowerForTests(); });

const answer = (status: number, body: unknown, statusText = "") => vi.fn(async () => new Response(JSON.stringify(body), { status, statusText }));

describe("api() errors a person reads", () => {
  it("keeps a plain server sentence as it is", async () => {
    vi.stubGlobal("fetch", answer(400, { error: "That name is taken." }));
    await expect(api("/api/bots")).rejects.toMatchObject({ message: "That name is taken.", status: 400 });
  });

  it("turns an errno or a stack into plain words, keeping the raw text as detail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", answer(500, { error: "EACCES: permission denied, open '/Users/x/.madanibot/a.json'" }));
    const error = await api("/api/bots").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(t("error.plain.permission"));
    expect((error as ApiError).detail).toContain("EACCES");
    expect((error as ApiError).status).toBe(500);
  });

  it("never shows a bare status line", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502, statusText: "Bad Gateway" })));
    await expect(api("/api/bots")).rejects.toMatchObject({ message: t("error.plain.server"), status: 502 });
  });

  it("says the app can't be reached when the request never arrives", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const error = await api("/api/bots").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(t("error.plain.unreachable"));
  });

  it("keeps a cancel a cancel and a timeout a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted.", "AbortError"); }));
    await expect(api("/api/bots")).rejects.toMatchObject({ name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("signal timed out", "TimeoutError"); }));
    await expect(api("/api/bots", { timeoutMs: 10 })).rejects.toMatchObject({ name: "TimeoutError", message: t("error.plain.timeout") });
  });
});
