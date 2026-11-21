import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Message } from "@/state/store";

const dispatch = vi.fn();
const fixture = vi.hoisted(() => ({ counting: false, values: [] as unknown[], index: 0, api: vi.fn(), track: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      if (!(index in fixture.values)) fixture.values[index] = initial;
      return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
    },
  };
});
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ dispatch }),
}));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));
vi.mock("@/lib/card-seal", () => ({ SealTrustError: class SealTrustError extends Error {}, sealCardSecret: vi.fn(async (_value: string, key: { keyId: string }, context: { remember: boolean }) => ({ keyId: key.keyId, encapsulatedKey: "E", ciphertext: `sealed-${context.remember ? "save" : "once"}` })) }));

import { SecretRequestCard, SecretRequestCardBody } from "./SecretRequestCard";

const secretCard = (secret: Record<string, unknown>): Message => ({
  id: "secret-card",
  role: "bot",
  kind: "secret",
  at: 1,
  text: "Securely provide the OpenAI API key.",
  secret: {
    target: "openaiImageApiKey",
    label: "OpenAI API key",
    description: "Generate a key at platform.openai.com. Scout can use it but never read it back.",
    placeholder: "sk-…",
    helpUrl: "https://platform.openai.com/api-keys",
    requestKey: "request-key-1",
    ...secret,
  },
});

const view = (secret: Record<string, unknown>) => renderToStaticMarkup(createElement(SecretRequestCard, {
  botId: "bot-1",
  threadId: "thread-1",
  message: secretCard(secret),
}));

beforeEach(() => {
  vi.stubGlobal("window", {});
  dispatch.mockReset();
});

describe("SecretRequestCard superseded requests", () => {
  it("keeps a retired persisted request visible without accepting a credential", () => {
    const html = view({ target: "boxToken", label: "Retired desktop key" });
    expect(html).toContain("Retired desktop key");
    expect(html).toContain("This credential request is no longer supported.");
    expect(html).toContain('data-ask-card="settled"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Save securely");
  });
  it("still offers entry while the newest request is pending", () => {
    const html = view({});
    expect(html).toContain("Save securely");
    expect(html).toContain("Private. Your bot never sees it.");
  });

  it("stops offering entry and names its replacement once superseded", () => {
    const html = view({ superseded: true });
    expect(html).toContain("Replaced by a newer request · OpenAI API key");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Save securely");
    expect(html).not.toContain("type=\"password\"");
    expect(html).not.toContain("Not now");
    expect(html).not.toContain("Waiting to resume safely");
  });
});

describe("SecretRequestCard on a page reached through a desktop paired to another computer", () => {
  const remote = (secret: Record<string, unknown>) => {
    vi.stubGlobal("window", { madaniDesktop: { remoteClient: { active: true } } });
    return view(secret);
  };

  it("offers the field for a secret the server keeps: a custom one, or a provider key", () => {
    for (const secret of [
      { target: "customSecret", label: "mailbox password", delivery: "ref", placeholder: "", helpUrl: "" },
      { target: "openaiApiKey", label: "OpenAI API key" },
    ]) {
      const html = remote(secret);
      expect(html, secret.target).toContain('type="password"');
      expect(html, secret.target).not.toContain("must be saved on the host computer");
    }
  });

  it("sends a key the host computer keeps in its own encrypted store to that computer", () => {
    const html = remote({ target: "ttsKey", label: "Speech key" });
    expect(html).toContain("must be saved on the host computer");
    expect(html).not.toContain('type="password"');
  });
});

describe("SecretRequestCard ask card", () => {
  it("waits as a compact ask card with a masked field", () => {
    const html = view({});
    expect(html).toContain('data-ask-card="pending"');
    expect(html).toContain("text-accent-text");
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
  });

  it("sits in the chat's flow like any message, never pinned over the messages above it", () => {
    for (const html of [view({}), view({ target: "customSecret", label: "instagram.com", delivery: "login", reason: "To post your photo.", helpUrl: "" })]) {
      expect(html).toContain('data-ask-card="pending"');
      const frame = /data-ask-card="pending" class="([^"]*)"/.exec(html)![1];
      expect(frame).not.toMatch(/\b(sticky|absolute|fixed)\b/);
      expect(html).not.toMatch(/\s-m[xytblr]?-\d/);
    }
  });

  it("says the bot's purpose quietly and the privacy promise once, beside the lock", () => {
    const html = view({ target: "customSecret", label: "instagram.com", delivery: "login", reason: "To post your photo.", description: "To post your photo.", helpUrl: "" });
    expect(html).toMatch(/line-clamp-2 text-\[13px\][^"]*text-ink-tertiary">To post your photo\./);
    expect(html.match(/never shown to your bot/g)).toHaveLength(1);
    expect(html).toContain("Private. Filled in for you, never shown to your bot.");
  });

  it("folds into one line that names the key once it is saved and the bot resumed", () => {
    const html = view({ provided: true, resumed: true });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain(">Secrets</span>");
    expect(html).toContain("Saved · OpenAI API key");
    expect(html).toContain('data-icon-name="key"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<form");
  });

  it("keeps a retry on the line when resuming after the save failed", () => {
    const html = view({ provided: true, error: "The bot could not be resumed." });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain("Try again");
    expect(html).toContain("The bot could not be resumed.");
    expect(html).not.toContain('type="password"');
  });
});

describe("SecretRequestCard mailbox", () => {
  const email = { target: "customSecret", delivery: "email", label: "connect your mailbox", placeholder: "mailbox password", helpUrl: "", description: "Ledger never sees the password." };

  it("asks for the address and the password on one card, with the address the bot knew", () => {
    const html = view({ ...email, address: "me@shop.example" });
    expect(html).toContain('type="email"');
    expect(html).toContain('value="me@shop.example"');
    expect(html).toContain('type="password"');
    expect(html).toContain("mailbox password");
    expect(html).toContain("Private. Your bot never sees it.");
  });

  it("asks for the server only once one could not be found, and other cards have no address field", () => {
    expect(view(email)).not.toContain("Incoming mail server");
    expect(view({})).not.toContain('type="email"');
  });

  it("says the bot goes on once connected, without the address field", () => {
    const html = view({ ...email, provided: true, resumed: true, address: "me@shop.example" });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).not.toContain("<input");
  });
});

describe("SecretRequestCard key analytics", () => {
  const KEY = "retired_ZZtestSECRET0123456789abcdef";
  type Props = { children?: ReactNode; type?: string; onChange?: (event: { target: { value: string } }) => void; onSubmit?: (event: { preventDefault(): void }) => void };
  const nodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
  const card = (target: string, extra: Record<string, unknown> = {}) => {
    fixture.counting = true;
    fixture.index = 0;
    try {
      return nodes(SecretRequestCardBody({ botId: "bot-1", threadId: "thread-1", message: secretCard({ target, label: "key", ...extra }) }));
    } finally {
      fixture.counting = false;
    }
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  async function submit(target: string, typed = KEY, extra: Record<string, unknown> = {}) {
    card(target, extra).find((node) => node.type === "input")!.props.onChange!({ target: { value: typed } });
    card(target, extra).find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: () => {} });
    await flush();
  }

  beforeEach(() => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.track.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports a voice key saved over the desktop bridge once, even when only the resume is retried", async () => {
    const setCredential = vi.fn().mockResolvedValue({ tts: { configured: true } });
    vi.stubGlobal("window", { madaniDesktop: { setCredential } });
    fixture.api.mockRejectedValueOnce(new Error("resume failed")).mockResolvedValueOnce({ ok: true });
    await submit("ttsKey");
    card("ttsKey").find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: () => {} });
    await flush();
    expect(setCredential).toHaveBeenCalledExactlyOnceWith("ttsKey", KEY);
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "elevenlabs", via: "chat_request", result: "ok" }]]);
    for (const fragment of [KEY, KEY.slice(0, 6), KEY.slice(-6), String(KEY.length)]) expect(JSON.stringify(fixture.track.mock.calls)).not.toContain(fragment);
  });

  it("reports a voice key the provider refused as rejected", async () => {
    vi.stubGlobal("window", { madaniDesktop: { setCredential: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'credential:set': KeyRejected: The voice provider rejected that key")) } });
    await submit("ttsKey");
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "elevenlabs", via: "chat_request", result: "rejected" }]]);
  });

  // Even with the desktop bridge, the 1Password token goes to this server's Logins (which checks it with 1Password),
  // never the bridge's settings-file store: on My Cloud no bridge exists, and the Cloud's Logins is where bots read it.
  it("saves a 1Password token through Logins, never the settings bridge, then resumes the bot", async () => {
    const setCredential = vi.fn();
    vi.stubGlobal("window", { madaniDesktop: { setCredential } });
    fixture.api.mockResolvedValueOnce({ onePassword: { connected: true } }).mockResolvedValueOnce({ ok: true });
    await submit("onePasswordToken", "ops_ZZtestSECRET0123456789");
    expect(setCredential).not.toHaveBeenCalled();
    expect(fixture.api.mock.calls[0]).toEqual(["/api/logins/1password", { method: "POST", body: JSON.stringify({ token: "ops_ZZtestSECRET0123456789" }) }]);
    expect(fixture.api.mock.calls[1]![0]).toBe("/api/bots/bot-1/secret-cards/secret-card/provided");
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.track.mock.calls)).not.toContain("ZZtestSECRET");
  });

  it("reports an xAI key saved from chat as unverified: nothing checks it before it is used", async () => {
    fixture.api.mockResolvedValueOnce({ xai: { configured: true } }).mockResolvedValueOnce({ ok: true });
    await submit("xaiApiKey", "xai-ZZtestSECRET0123456789");
    expect(fixture.api.mock.calls[0]).toEqual(["/api/config", { method: "PUT", body: JSON.stringify({ xai: { key: "xai-ZZtestSECRET0123456789" } }) }]);
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "xai", via: "chat_request", result: "unverified" }]]);
  });

  // Settings keeps an AI provider key in the server's settings, not the desktop's store: the card does the same.
  it("saves an Anthropic key where Settings does, never through the desktop store, keeping Claude sign-ins", async () => {
    const setCredential = vi.fn();
    vi.stubGlobal("window", { madaniDesktop: { setCredential } });
    fixture.api.mockResolvedValueOnce({ anthropic: { configured: true } }).mockResolvedValueOnce({ ok: true });
    await submit("anthropicApiKey", "sk-ant-ZZtestSECRET0123456789");
    expect(setCredential).not.toHaveBeenCalled();
    expect(fixture.api.mock.calls[0]).toEqual(["/api/config", { method: "PUT", body: JSON.stringify({ anthropic: { key: "sk-ant-ZZtestSECRET0123456789", everyClaudeBot: false } }) }]);
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "anthropic", via: "chat_request", result: "unverified" }]]);
  });

  it("saves the Composio key in the desktop store's slot, as Settings does", async () => {
    const setCredential = vi.fn().mockResolvedValue({ composio: { configured: true } });
    vi.stubGlobal("window", { madaniDesktop: { setCredential } });
    fixture.api.mockResolvedValueOnce({ ok: true });
    await submit("composioApiKey", "ak_ZZtestSECRET0123456789");
    expect(setCredential).toHaveBeenCalledExactlyOnceWith("composioApiKey", "ak_ZZtestSECRET0123456789");
  });

  // A custom secret goes only to its own card's save, which resumes the bot: never Settings, the desktop store or an event.
  it("keeps a custom secret behind its card, with no product event naming it", async () => {
    const setCredential = vi.fn();
    vi.stubGlobal("window", { madaniDesktop: { setCredential } });
    fixture.api.mockResolvedValueOnce({ sealKey: { version: 1, keyId: "k1", x: "x", y: "y" } }).mockResolvedValueOnce({ provided: true, resumed: true });
    await submit("customSecret", "sk_live_ZZtestSECRET0123456789", { delivery: "ref", helpUrl: "" });
    expect(setCredential).not.toHaveBeenCalled();
    expect(fixture.api.mock.calls).toEqual([
      ["/api/bots/bot-1/secret-cards/secret-card/save", { method: "POST", body: JSON.stringify({ threadId: "thread-1", prepare: true }) }],
      ["/api/bots/bot-1/secret-cards/secret-card/save", { method: "POST", body: JSON.stringify({ threadId: "thread-1", sealed: { keyId: "k1", encapsulatedKey: "E", ciphertext: "sealed-save" }, remember: true }) }],
    ]);
    expect(JSON.stringify(fixture.api.mock.calls)).not.toContain("ZZtestSECRET");
    expect(fixture.track).not.toHaveBeenCalled();
  });

  it("never shows a raw technical error, keeps what was typed, and sends again on the next press", async () => {
    const extra = { delivery: "ref", helpUrl: "" };
    const alert = () => card("customSecret", extra).find((node) => (node.props as { role?: string }).role === "alert")?.props.children;
    fixture.api.mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module: http://localhost:5173/node_modules/.vite/deps/@hpke_core.js?v=1"));
    await submit("customSecret", "sk_live_ZZtestSECRET0123456789", extra);
    expect(alert()).toBe("Couldn't send that securely. Try again.");
    const field = card("customSecret", extra).find((node) => node.type === "input" && (node.props as { type?: string }).type === "password");
    expect((field!.props as { value?: string }).value, "what was typed stays for the retry").toBe("sk_live_ZZtestSECRET0123456789");
    // the server's own plain words still say what went wrong
    fixture.api.mockRejectedValueOnce(new ApiError("That key was refused.", 400, { error: "That key was refused." }));
    card("customSecret", extra).find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: () => {} });
    await flush();
    expect(alert()).toBe("That key was refused.");
    fixture.api.mockResolvedValueOnce({ sealKey: { version: 1, keyId: "k1", x: "x", y: "y" } }).mockResolvedValueOnce({ provided: true });
    card("customSecret", extra).find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: () => {} });
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(4);
    expect(alert()).toBeUndefined();
  });

  it("seals again for a server that restarted between the two steps", async () => {
    fixture.api.mockResolvedValueOnce({ sealKey: { version: 1, keyId: "k1", x: "x", y: "y" } })
      .mockRejectedValueOnce(Object.assign(new Error("restarted"), { body: { sealKey: { version: 1, keyId: "k2", x: "x", y: "y" } } }))
      .mockResolvedValueOnce({ provided: true });
    await submit("customSecret", "sk_live_ZZtestSECRET0123456789", { delivery: "file", helpUrl: "" });
    expect(fixture.api).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fixture.api.mock.calls[2]![1].body).sealed.keyId).toBe("k2");
  });
});

describe("SecretRequestCard custom secrets", () => {
  it("says what the bot may do with it, in the bot's words and plainly, with no key link", () => {
    const file = view({ target: "customSecret", label: "Stripe secret key", reason: "To create test charges.", description: "To create test charges. Scout's commands can read it.", helpUrl: "", delivery: "file" });
    expect(file).toContain("To create test charges.");
    expect(file).not.toContain("Scout&#x27;s commands can read it.");
    expect(file).toContain("Private. Your bot&#x27;s commands can use it for 24 hours.");
    expect(file).not.toContain("Where to get this key");
    const ref = view({ target: "customSecret", label: "Notion key", reason: "For Notion.", helpUrl: "", delivery: "ref" });
    expect(ref).toContain("Private. Your bot never sees it.");
    expect(ref).not.toContain("one-use reference");
    expect(ref).toContain('data-secret-remember=""');
    expect(ref).toMatch(/role="switch" aria-checked="true"/u);
    expect(ref).not.toContain('type="checkbox"');
    expect(ref).toContain("Save to vault");
  });

  it("settles into Grok's Secrets line: saved, used once, or cancelled", () => {
    const custom = { target: "customSecret", label: "OpenRouter API key", helpUrl: "", delivery: "ref" };
    expect(view({ ...custom, provided: true, resumed: true, kept: "vault" })).toContain("Saved · OpenRouter API key");
    expect(view({ ...custom, provided: true, resumed: true, kept: "once" })).toContain("Used once · OpenRouter API key");
    const cancelled = view({ ...custom, dismissed: true, resumed: true });
    expect(cancelled).toContain("Cancelled · OpenRouter API key");
    expect(cancelled).not.toContain("<input");
  });
});
