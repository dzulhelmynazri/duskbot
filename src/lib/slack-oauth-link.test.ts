import type { EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/state/api";
import type { SlackBotStatus } from "../../shared/slack.ts";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/api", () => ({ api: vi.fn() }));

import { completeSlackOAuth, SLACK_OAUTH_EVENT, useSlackOAuthLinks, useSlackOAuthResult } from "./slack-oauth-link.ts";

const STATE = "ab".repeat(32);
const CODE = "fixture.code_-123";
const LINK = `madanibot://slack/oauth?code=${CODE}&state=${STATE}`;
const status: SlackBotStatus = { version: 1, botId: "scout", state: "installed" };

beforeEach(() => { vi.stubGlobal("window", new EventTarget()); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); fixture.effects = []; });

describe("completeSlackOAuth", () => {
  it("ignores non-Slack and invalid links without posting or dispatching", async () => {
    const post = vi.fn();
    const dispatch = vi.spyOn(window, "dispatchEvent");
    for (const link of ["madanibot://cloud", "madanibot://bot/scout", `${LINK}&extra=1`]) {
      expect(await completeSlackOAuth(link, post)).toBeNull();
    }
    expect(post).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("posts the code and state and dispatches the returned status", async () => {
    const post = vi.fn().mockResolvedValue({ status });
    const results: unknown[] = [];
    window.addEventListener(SLACK_OAUTH_EVENT, (event) => results.push((event as CustomEvent).detail));
    expect(await completeSlackOAuth(LINK, post)).toEqual({ ok: true, status });
    expect(post).toHaveBeenCalledExactlyOnceWith("/api/slack/oauth", { code: CODE, state: STATE });
    expect(results).toEqual([{ ok: true, status }]);
  });

  it.each([["access_denied", "denied"], ["server_error", "server_error"]])("dispatches a Slack error without posting (%s)", async (error, expected) => {
    const post = vi.fn();
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const result = { ok: false, error: expected };
    expect(await completeSlackOAuth(`madanibot://slack/oauth?error=${error}&state=${STATE}`, post)).toEqual(result);
    expect(post).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
    expect((dispatch.mock.calls[0][0] as CustomEvent).detail).toEqual(result);
  });

  it("propagates the server error string from the API error body", async () => {
    const post = vi.fn().mockRejectedValue(Object.assign(new Error("request refused"), { body: { error: "expired_state" } }));
    const dispatch = vi.spyOn(window, "dispatchEvent");
    expect(await completeSlackOAuth(LINK, post)).toEqual({ ok: false, error: "expired_state" });
    expect((dispatch.mock.calls[0][0] as CustomEvent).detail).toEqual({ ok: false, error: "expired_state" });
  });

  it("accepts a direct server error string from an injected post", async () => {
    expect(await completeSlackOAuth(LINK, vi.fn().mockRejectedValue({ error: "bad_state" }))).toEqual({ ok: false, error: "bad_state" });
  });

  it.each([new Error("connection failed"), { body: { error: { message: "not a string" } } }, null])("uses a fixed fallback for other failures %#", async (cause) => {
    expect(await completeSlackOAuth(LINK, vi.fn().mockRejectedValue(cause))).toEqual({ ok: false, error: "failed" });
  });

  it("uses the renderer API with a JSON POST and a 30 second timeout", async () => {
    vi.mocked(api).mockResolvedValueOnce({ status });
    expect(await completeSlackOAuth(LINK)).toEqual({ ok: true, status });
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/slack/oauth", {
      method: "POST", body: JSON.stringify({ code: CODE, state: STATE }), timeoutMs: 30000,
    });
  });

  it("can complete without a window", async () => {
    vi.stubGlobal("window", undefined);
    expect(await completeSlackOAuth(LINK, vi.fn().mockResolvedValue({ status }))).toEqual({ ok: true, status });
  });
});

describe("Slack OAuth subscriptions", () => {
  it("subscribes to desktop links, completes them, and returns the unsubscribe", async () => {
    let deliver: ((link: string) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal("window", Object.assign(new EventTarget(), {
      madaniDesktop: { onSlackOAuth: (cb: (link: string) => void) => { deliver = cb; return unsubscribe; } },
    }));
    vi.mocked(api).mockResolvedValueOnce({ status });
    const receive = vi.fn();
    window.addEventListener(SLACK_OAUTH_EVENT, (event) => receive((event as CustomEvent).detail));
    useSlackOAuthLinks();
    expect(fixture.effects[0]()).toBe(unsubscribe);
    deliver!(LINK);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledExactlyOnceWith({ ok: true, status }));
  });

  it("does nothing when the desktop bridge is absent", () => {
    useSlackOAuthLinks();
    expect(fixture.effects[0]()).toBeUndefined();
  });

  it("listens for results and removes its listener on cleanup", () => {
    const receive = vi.fn();
    useSlackOAuthResult(receive);
    const cleanup = fixture.effects[0]();
    const result = { ok: false, error: "denied" };
    window.dispatchEvent(new CustomEvent(SLACK_OAUTH_EVENT, { detail: result }));
    expect(receive).toHaveBeenCalledExactlyOnceWith(result);
    if (typeof cleanup === "function") cleanup();
    window.dispatchEvent(new CustomEvent(SLACK_OAUTH_EVENT, { detail: result }));
    expect(receive).toHaveBeenCalledOnce();
  });
});
