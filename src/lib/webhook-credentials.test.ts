import { describe, expect, it } from "vitest";

import {
  keptWebhookAddress,
  loadWebhookCredentials,
  removeWebhookCredential,
  saveWebhookCredential,
} from "./webhook-credentials.js";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const credential = {
  endpointUrl: "http://127.0.0.1:8800/hooks/wh_demo",
  secret: "whsec_demo",
  url: "http://127.0.0.1:8800/hooks/wh_demo/whsec_demo",
};

describe("webhook credential storage", () => {
  it("keeps a one-time private URL available after the panel remounts", () => {
    const store = memoryStore();
    saveWebhookCredential(store, "hook-1", credential);
    expect(loadWebhookCredentials(store)).toEqual({ "hook-1": credential });
  });

  it("ignores malformed entries and removes deleted webhooks", () => {
    const store = memoryStore();
    store.setItem("madani-webhook-credentials", JSON.stringify({ broken: { url: 3 }, "hook-1": credential }));
    expect(loadWebhookCredentials(store)).toEqual({ "hook-1": credential });
    removeWebhookCredential(store, "hook-1");
    expect(loadWebhookCredentials(store)).toEqual({});
  });
});

describe("copying a webhook's address", () => {
  const kept = { endpointUrl: "https://x/hook", secret: "s", url: "https://x/hook?s" };
  it("never makes a new address because the read failed", async () => {
    const offline = () => Promise.reject(Object.assign(new Error("Failed to fetch"), { status: undefined }));
    await expect(keptWebhookAddress(offline, undefined)).rejects.toThrow("Failed to fetch");
    const restarting = () => Promise.reject(Object.assign(new Error("503"), { status: 503, body: {} }));
    await expect(keptWebhookAddress(restarting, undefined)).rejects.toThrow("503");
    await expect(keptWebhookAddress(offline, kept)).resolves.toBe(kept);
  });

  it("allows a new one only when the server says none was ever kept", async () => {
    const legacy = () => Promise.reject(Object.assign(new Error("old"), { status: 404, body: { kept: false } }));
    await expect(keptWebhookAddress(legacy, undefined)).resolves.toBeUndefined();
    const gone = () => Promise.reject(Object.assign(new Error("no such webhook"), { status: 404, body: { error: "no such webhook" } }));
    await expect(keptWebhookAddress(gone, undefined)).rejects.toThrow("no such webhook");
    await expect(keptWebhookAddress(() => Promise.resolve({ credential: kept }), undefined)).resolves.toBe(kept);
  });
});
