// @vitest-environment happy-dom
// The real controller and view run against a fake preload bridge.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { CompanionAccountState } from "../types/madaniDesktop";
import { PhoneSetupFlowView, usePhoneSetupController, type CompanionState } from "./PhoneSetupFlow";

vi.mock("@/state/store", async (actual) => ({ ...(await actual<object>()), useStore: () => ({ dispatch: vi.fn() }) }));

/** Settings' pairing panel: the flow with its own controller, as CompanionSection mounts it. */
function PhoneSetupFlow() {
  return createElement(PhoneSetupFlowView, { controller: usePhoneSetupController() });
}

const HOSTED = "https://c-opaque.cloud.madani.bot";
const FULL =
  "Secure HTTPS links are temporarily full. Try again in 10 minutes, or pair on this Wi-Fi or with Tailscale.";

function desktop() {
  let companion: CompanionState = { enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null };
  let account: CompanionAccountState = { available: true, status: "ready", email: "ada@example.com" };
  let finishPrepare: (outcome: "ready" | "full") => void = () => {};
  const withHosted = () => ({
    ...companion,
    endpoints: [{ kind: "hosted" as const, url: HOSTED, priority: 0 }],
  });
  const bridge = {
    requireUserPresence: vi.fn(async () => true),
    companion: {
      state: vi.fn(async () => companion),
      start: vi.fn(async () => {
        companion = { ...companion, enabled: true, endpoints: [], lan: "192.168.1.34" };
        return companion;
      }),
      stop: vi.fn(async () => companion),
      keepAwake: vi.fn(async () => companion),
      refreshTailscale: vi.fn(async () => companion),
      pairing: vi.fn(async (open: boolean) => {
        companion = {
          ...companion,
          pairing: open
            ? { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: Date.now() + 120_000 }
            : null,
        };
        return companion;
      }),
      cloudDesktop: vi.fn(async () => companion),
      browserControl: vi.fn(async () => companion),
      revoke: vi.fn(async () => companion),
    },
    companionAccount: {
      state: vi.fn(async () => account),
      requestCode: vi.fn(async () => account),
      verifyCode: vi.fn(async () => account),
      retry: vi.fn(async () => account),
      signOut: vi.fn(async () => account),
      prepare: vi.fn(() => new Promise<CompanionAccountState>((resolve) => {
        finishPrepare = (outcome) => {
          if (outcome === "ready") {
            companion = withHosted();
            account = { ...account, endpoint: HOSTED };
          } else {
            account = { available: true, status: "error", email: "ada@example.com", message: FULL };
          }
          resolve(account);
        };
      })),
    },
  };
  return {
    bridge,
    finishPrepare: (outcome: "ready" | "full") => finishPrepare(outcome),
    alreadyHosted() {
      companion = { ...withHosted(), enabled: true };
      account = { ...account, endpoint: HOSTED };
    },
    stopRetrying() {
      account = { available: true, status: "ready", email: "ada@example.com" };
    },
    noHostedService() {
      account = { available: false, status: "signed-out", reason: "unsupported", message: "Secure access is not available right now. Local pairing still works." };
    },
  };
}

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? "";
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) ?? null;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (globalThis as { madaniDesktop?: unknown }).madaniDesktop;
});

async function startPairing(fake: ReturnType<typeof desktop>) {
  (globalThis as { madaniDesktop?: unknown }).madaniDesktop = fake.bridge;
  flushSync(() => root.render(createElement(PhoneSetupFlow)));
  await vi.waitFor(() => expect(button("Pair")?.disabled).toBe(false));
  button("Pair")!.click();
}

describe("pairing on a computer that holds no HTTPS address yet", () => {
  it("creates the address under the spinner, then opens the HTTPS QR", async () => {
    const fake = desktop();
    await startPairing(fake);

    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
    expect(fake.bridge.companion.start).toHaveBeenCalledOnce();
    expect(text()).toContain("Creating secure remote access");
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();

    fake.finishPrepare("ready");
    await vi.waitFor(
      () => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull(),
      { timeout: 5_000 },
    );
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
    flushSync(() => button("Reveal")!.click());
    expect(text()).toContain(`Pairing address${HOSTED}`);
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledTimes(2);
  });

  it("says when to try again when no address is free, and offers Wi-Fi", async () => {
    const fake = desktop();
    await startPairing(fake);
    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());

    fake.finishPrepare("full");
    await vi.waitFor(() => expect(text()).toContain(FULL));
    expect(text()).toContain("Secure access needs attention");
    expect(button("Try secure access again")).not.toBeNull();
    expect(button("Use Wi-Fi")).not.toBeNull();
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();

    flushSync(() => button("Use Wi-Fi")!.click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce();
    expect(fake.bridge.requireUserPresence, "one check covers the whole flow").toHaveBeenCalledOnce();
  });

  it("asks again when the desktop stopped retrying while pairing still waits", async () => {
    const fake = desktop();
    await startPairing(fake);
    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
    fake.finishPrepare("full");
    await vi.waitFor(() => expect(text()).toContain(FULL));

    fake.stopRetrying();
    await vi.waitFor(
      () => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(text()).toContain("Creating secure remote access");
    fake.finishPrepare("ready");
    await vi.waitFor(
      () => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull(),
      { timeout: 5_000 },
    );
  });
});

describe("pairing on a computer that already holds its HTTPS address", () => {
  it("opens the QR at once, and tells the desktop someone is pairing over it", async () => {
    const fake = desktop();
    fake.alreadyHosted();
    await startPairing(fake);

    await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce();
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
  });
});

describe("the person at the computer confirms it is them first", () => {
  it("shows no code and starts nothing when the check fails, and asks again on the next try", async () => {
    const fake = desktop();
    fake.alreadyHosted();
    fake.bridge.requireUserPresence.mockResolvedValueOnce(false);
    await startPairing(fake);

    await vi.waitFor(() => expect(fake.bridge.requireUserPresence).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Device pairing QR code"]')).toBeNull();
    expect(button("Pair")).not.toBeNull();

    button("Pair")!.click();
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
    expect(fake.bridge.requireUserPresence).toHaveBeenCalledTimes(2);
    expect(fake.bridge.requireUserPresence).toHaveBeenCalledWith("show a code that links a phone");
  });
});

describe("pairing when the hosted secure service is not there", () => {
  it("opens the Wi-Fi code at once when this build has no relay", async () => {
    const fake = desktop();
    fake.noHostedService();
    await startPairing(fake);

    await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
    expect(text()).not.toMatch(/Secure access|isn’t offered|Tailscale/);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("asks for a sign-in to pair from anywhere in one line, with Wi-Fi beside it", async () => {
    const fake = desktop();
    fake.noHostedService();
    const relay = { state: vi.fn(async () => ({ status: "signed-out" as const })), ready: vi.fn(async () => ({ status: "signed-out" as const })) };
    await startPairing({ ...fake, bridge: { ...fake.bridge, phoneRelay: relay } as typeof fake.bridge });

    await vi.waitFor(() => expect(text()).toContain("Pair from anywhere"));
    expect(text()).toContain("Sign in to your madani bot account to pair from anywhere");
    expect(button("Sign in")).not.toBeNull();
    expect(button("Use Wi-Fi")).not.toBeNull();
    expect(text()).not.toMatch(/Secure access|isn’t offered|Tailscale/);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
  });

  it("tries the relay again when it could not start", async () => {
    const fake = desktop();
    fake.noHostedService();
    const relay = {
      state: vi.fn(async () => ({ status: "error" as const, code: "unreachable", message: "madani bot could not reach its relay." })),
      ready: vi.fn(async () => ({ status: "error" as const, code: "unreachable", message: "madani bot could not reach its relay." })),
    };
    await startPairing({ ...fake, bridge: { ...fake.bridge, phoneRelay: relay } as typeof fake.bridge });

    await vi.waitFor(() => expect(text()).toContain("Pairing from anywhere could not start"));
    flushSync(() => button("Try again")!.click());
    await vi.waitFor(() => expect(relay.ready).toHaveBeenCalledOnce());
    expect(button("Use Wi-Fi")).not.toBeNull();
  });
});
