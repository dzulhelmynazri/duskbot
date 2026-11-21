import { describe, expect, it, vi } from "vitest";
import { BoxFenceError } from "./bot-box/plan.ts";
import { ProviderAuthSessions } from "./provider-auth-sessions.ts";
import type { ProviderAuthenticationStart } from "./contracts.ts";

function fixture() {
  const auth: ProviderAuthenticationStart = {
    phase: "waiting", flowId: "random-flow", authorizationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-12345", expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const instance = {
    instanceId: "codex", startAuthentication: vi.fn(async () => auth),
    getAuthentication: vi.fn(async () => auth),
    cancelAuthentication: vi.fn(async () => {}),
    completeAuthentication: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  };
  return { sessions: new ProviderAuthSessions(), instance, auth };
}

describe("a finished sign-in", () => {
  it("is told for the AI it signed in to, whichever way it finished, and never for a flow still waiting or one that failed", async () => {
    const { instance, auth } = fixture();
    const signedIn = vi.fn();
    const sessions = new ProviderAuthSessions({ signedIn });
    await sessions.start(instance, "owner");
    await sessions.status("codex", "owner", "random-flow");
    expect(signedIn).not.toHaveBeenCalled();
    instance.getAuthentication.mockResolvedValueOnce({ ...auth, phase: "failed" } as never);
    await sessions.status("codex", "owner", "random-flow");
    expect(signedIn).not.toHaveBeenCalled();

    await sessions.start(instance, "owner");
    instance.getAuthentication.mockResolvedValueOnce({ ...auth, phase: "succeeded" } as never);
    await sessions.status("codex", "owner", "random-flow");
    expect(signedIn).toHaveBeenLastCalledWith("codex");

    await sessions.start(instance, "owner");
    await sessions.complete("codex", "owner", "random-flow", "https://localhost/callback?code=x");
    instance.startAuthentication.mockResolvedValueOnce({ ...auth, phase: "succeeded" });
    await sessions.start({ ...instance, instanceId: "claude" }, "owner");
    expect(signedIn.mock.calls).toEqual([["codex"], ["codex"], ["claude"]]);
  });
});

describe("how a sign-in went, for usage signals", () => {
  it("tells a loopback sign-in's success from the AI's status, and a flow nobody finished as expired", async () => {
    vi.useFakeTimers();
    try {
      const { instance } = fixture();
      const outcomes: string[] = [];
      let signedInNow = false;
      const sessions = new ProviderAuthSessions({ outcome: (id, outcome, error) => outcomes.push(`${id} ${outcome}${error ? ` ${String(error)}` : ""}`), signedInNow: () => signedInNow });
      // the browser came back to the engine's own loopback: the app watches the AI's status, never this flow's
      await sessions.start(instance, "owner");
      sessions.sawSignedIn("codex");
      sessions.sawSignedIn("codex");
      await sessions.status("codex", "owner", "random-flow");
      expect(outcomes).toEqual(["codex started", "codex succeeded"]);

      // the person gave up (chose an API key instead): told once, when it runs out
      outcomes.length = 0;
      const grok = { ...instance, instanceId: "grok", startAuthentication: vi.fn(async () => ({ ...await instance.startAuthentication(), flowId: "grok-flow" })) };
      await sessions.start(grok, "owner");
      await vi.advanceTimersByTimeAsync(61_000);
      expect(outcomes).toEqual(["grok started", "grok expired sign-in timed out"]);

      // a re-sign-in while already signed in: a signed-in status proves nothing about it
      outcomes.length = 0;
      signedInNow = true;
      sessions.clearInstance("codex");
      instance.startAuthentication.mockResolvedValueOnce({ phase: "waiting", flowId: "again", authorizationUrl: null, expiresAt: null });
      await sessions.start(instance, "owner");
      sessions.sawSignedIn("codex");
      expect(outcomes).toEqual(["codex started"]);
    } finally { vi.useRealTimers(); }
  });
});

describe("provider login ownership", () => {
  it("forgets only the replaced provider's login reservation", async () => {
    const { sessions, instance } = fixture();
    const sibling = { ...instance, instanceId: "other" };
    await sessions.start(instance, "owner");
    await sessions.start(sibling, "owner");
    sessions.clearInstance("codex");
    await expect(sessions.status("codex", "owner", "random-flow")).rejects.toMatchObject({ status: 404 });
    await expect(sessions.status("other", "owner", "random-flow")).resolves.toMatchObject({ phase: "waiting" });
    await expect(sessions.start(instance, "another owner")).resolves.toMatchObject({ phase: "waiting" });
  });
  it("does not disclose, complete, or cancel another admin's device flow", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    await expect(sessions.start(instance, "other")).rejects.toMatchObject({ status: 409 });
    await expect(sessions.status("codex", "other", "random-flow")).rejects.toMatchObject({ status: 404 });
    await expect(sessions.complete("codex", "other", "random-flow", "callback")).rejects.toMatchObject({ status: 404 });
    await expect(sessions.cancel("codex", "other", "random-flow")).rejects.toMatchObject({ status: 404 });
    expect(instance.getAuthentication).not.toHaveBeenCalled();
    expect(instance.cancelAuthentication).not.toHaveBeenCalled();
    expect(instance.completeAuthentication).not.toHaveBeenCalled();
  });

  it("requires an exact flow id even for the initiating admin", async () => {
    const { sessions, instance, auth } = fixture();
    await sessions.start(instance, "owner");
    await expect(sessions.status("codex", "owner", "stale")).rejects.toMatchObject({ status: 404 });
    await expect(sessions.cancel("codex", "owner", "")).rejects.toMatchObject({ status: 404 });
    expect(await sessions.status("codex", "owner", "random-flow")).toEqual(auth);
    await sessions.cancel("codex", "owner", "random-flow");
    expect(instance.cancelAuthentication).toHaveBeenCalledOnce();
  });

  it("reserves ownership before the asynchronous CLI start", async () => {
    const { sessions, instance, auth } = fixture();
    let ready!: (value: ProviderAuthenticationStart) => void;
    instance.startAuthentication.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
    const first = sessions.start(instance, "owner");
    await expect(sessions.start(instance, "owner")).rejects.toMatchObject({ status: 409 });
    await expect(sessions.start(instance, "other")).rejects.toMatchObject({ status: 409 });
    ready(auth);
    await first;
    expect(instance.startAuthentication).toHaveBeenCalledOnce();
  });

  it("cancels pending startup when its admin is revoked", async () => {
    const { sessions, instance, auth } = fixture();
    let ready!: (value: ProviderAuthenticationStart) => void;
    instance.startAuthentication.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
    const starting = sessions.start(instance, "owner");
    sessions.revokeOwner("owner");
    ready(auth);
    await expect(starting).rejects.toMatchObject({ status: 409 });
    expect(instance.cancelAuthentication).toHaveBeenCalledOnce();
  });

  it("revokes only the target owner's flow", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    sessions.revokeOwner("other");
    expect(instance.cancelAuthentication).not.toHaveBeenCalled();
    sessions.revokeOwner("owner");
    await expect(sessions.status("codex", "owner", "random-flow")).rejects.toMatchObject({ status: 404 });
    await vi.waitFor(() => expect(instance.cancelAuthentication).toHaveBeenCalledOnce());
  });

  it("preserves the browser-callback provider flow for its owner", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    await sessions.complete("codex", "owner", "random-flow", "callback");
    expect(instance.completeAuthentication).toHaveBeenCalledWith("random-flow", "callback");
    await expect(sessions.status("codex", "owner", "random-flow")).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the original flow recoverable when same-owner resume fails", async () => {
    const { sessions, instance, auth } = fixture();
    await sessions.start(instance, "owner");
    instance.startAuthentication.mockRejectedValueOnce(new Error("temporary failure"));
    await expect(sessions.start(instance, "owner")).rejects.toThrow("temporary failure");
    expect(await sessions.status("codex", "owner", "random-flow")).toEqual(auth);
    await sessions.cancel("codex", "owner", "random-flow");
    expect(instance.cancelAuthentication).toHaveBeenCalledOnce();
  });

  it("releases another admin immediately after confirmed cancellation", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    await sessions.cancel("codex", "owner", "random-flow");
    await expect(sessions.start(instance, "other")).resolves.toMatchObject({ phase: "waiting" });
  });

  it("releases another admin after a terminal status is observed", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    instance.getAuthentication.mockResolvedValue({ phase: "succeeded", flowId: "random-flow", authorizationUrl: null, expiresAt: null });
    await sessions.status("codex", "owner", "random-flow");
    await expect(sessions.start(instance, "other")).resolves.toMatchObject({ phase: "waiting" });
  });

  it("releases failed startup and does not retain already-signed-in flows", async () => {
    const { sessions, instance } = fixture();
    instance.startAuthentication.mockRejectedValueOnce(new Error("missing CLI"));
    await expect(sessions.start(instance, "owner")).rejects.toThrow("missing CLI");
    instance.startAuthentication.mockResolvedValue({ phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null });
    await sessions.start(instance, "other");
    await sessions.start(instance, "owner");
  });

  it("rejects stale polling after fleet disposal", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    sessions.clear();
    await expect(sessions.status("codex", "owner", "random-flow")).rejects.toMatchObject({ status: 404 });
  });
});

describe("provider sign-out", () => {
  it("never pulls away a sign-in another admin is completing", async () => {
    const { sessions, instance } = fixture();
    await sessions.start(instance, "owner");
    await expect(sessions.signOut(instance, "other")).rejects.toMatchObject({ status: 409 });
    expect(instance.signOut).not.toHaveBeenCalled();
    await sessions.signOut(instance, "owner");
    expect(instance.cancelAuthentication).toHaveBeenCalledOnce();
    expect(instance.signOut).toHaveBeenCalledOnce();
    await expect(sessions.status("codex", "owner", "random-flow")).rejects.toMatchObject({ status: 404 });
  });

  it("holds new sign-ins until the credential is removed", async () => {
    const { sessions, instance } = fixture();
    let done!: () => void;
    instance.signOut.mockImplementation(() => new Promise<void>((resolve) => { done = resolve; }));
    const signingOut = sessions.signOut(instance, "owner");
    await expect(sessions.start(instance, "other")).rejects.toMatchObject({ status: 409 });
    await expect(sessions.signOut(instance, "other")).rejects.toMatchObject({ status: 409 });
    done();
    await signingOut;
    await expect(sessions.start(instance, "other")).resolves.toMatchObject({ phase: "waiting" });
  });

  it("releases the slot when the provider's sign-out fails and needs provider support", async () => {
    const { sessions, instance } = fixture();
    instance.signOut.mockRejectedValueOnce(new Error("Codex could not remove the sign-in on this server."));
    await expect(sessions.signOut(instance, "owner")).rejects.toThrow("could not remove");
    await expect(sessions.start(instance, "owner")).resolves.toMatchObject({ phase: "waiting" });
    const { signOut: _unsupported, ...plain } = instance;
    await expect(sessions.signOut(plain, "owner")).rejects.toMatchObject({ status: 404 });
  });
});

describe("a sign-in in progress, as the move and a backup see it (active)", () => {
  it("counts while the person signs in, and stops at its expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { sessions, instance } = fixture();
      await sessions.start(instance, "owner");
      expect(sessions.active).toBe(true);
      vi.setSystemTime(Date.now() + 61_000);
      expect(sessions.active).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("stops counting a start that never returns once it would have expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { sessions, instance } = fixture();
      instance.startAuthentication.mockImplementation(() => new Promise(() => {}));
      void sessions.start(instance, "owner");
      expect(sessions.active).toBe(true);
      vi.setSystemTime(Date.now() + 15 * 60_000 - 1);
      expect(sessions.active).toBe(true);
      vi.setSystemTime(Date.now() + 1);
      expect(sessions.active, "stuck busy past its expiry").toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("stops counting a sign-out that never returns after its minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { sessions, instance } = fixture();
      instance.signOut.mockImplementation(() => new Promise<void>(() => {}));
      void sessions.signOut(instance, "owner");
      expect(sessions.active).toBe(true);
      vi.setSystemTime(Date.now() + 60_000);
      expect(sessions.active).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe("a sign-in the bot box refuses", () => {
  it("tells the person in plain words, never with the server's folder", async () => {
    const { sessions, instance } = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance.startAuthentication.mockRejectedValueOnce(new BoxFenceError("/home/madani/.madanibot/providers/antigravity/ac0a"));
    const refused = await sessions.start(instance, "owner").catch((error: Error & { status?: number }) => error);
    expect(refused).toMatchObject({ status: 500 });
    expect((refused as Error).message).toMatch(/sign-in could not start on this server/);
    expect((refused as Error).message).not.toContain(".madanibot");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/home/madani/.madanibot/providers/antigravity/ac0a"));
    warn.mockRestore();
  });
});
