// @vitest-environment happy-dom
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/state/api";
import { setLocale } from "@/lib/i18n";
import { SLACK_OAUTH_EVENT } from "@/lib/slack-oauth-link";
import type { Bot } from "@/state/store";
import type { SlackBotStatus, SlackWorkspaceStatus } from "../../../shared/slack.ts";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ dispatch: fixture.dispatch }) }));
vi.mock("@/state/api", async (original) => ({ ...await original<typeof import("@/state/api")>(), api: fixture.api }));
const { SlackBotPage } = await import("./SlackBotPage");
const { useSlackAvailable, useSlackBot, useSlackBotState } = await import("./use-slack");
let host: HTMLDivElement;
let root: Root;
let workspace: SlackWorkspaceStatus;
let status: SlackBotStatus;
const bot = { id: "b1", name: "Scout" } as Bot;
const authorizeUrl = "https://slack.com/oauth/v2/authorize?client_id=fixture";
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const microtasks = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
const mount = async (next = bot) => { flushSync(() => root.render(createElement(SlackBotPage, { bot: next }))); await settle(); };
const button = (text: string) => [...host.querySelectorAll("button")].find((item) => (item.querySelector("[data-row-title]")?.textContent ?? item.textContent) === text)!;
const click = async (text: string) => { flushSync(() => button(text).click()); await settle(); };
const write = (label: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
};
const reads = () => fixture.api.mock.calls.filter(([path, init]) => path === "/api/slack/bots/b1" && !init?.method).length;

beforeEach(() => {
  setLocale("en");
  workspace = { version: 1, state: "connected", teamName: "Acme", apps: 1, ready: true };
  status = { version: 1, botId: "b1", state: "not_linked", teamName: "Acme", handle: "scout", appTokenUrl: "https://api.slack.com/apps/A1/general", openUrl: "https://app.slack.com/client/T1/D1" };
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/slack/workspace") return workspace;
    if (path.endsWith("/provision")) { status = { ...status, state: "provisioned" }; return { status, authorizeUrl }; }
    if (path.endsWith("/app-token")) { status = { ...status, state: "online" }; return { status }; }
    if (path === "/api/slack/oauth") { status = { ...status, state: "installed" }; return { status }; }
    if (init?.method === "DELETE") status = { ...status, state: "not_linked" };
    return status;
  });
  vi.spyOn(window, "open").mockReturnValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("a bot's Slack setup", () => {
  it("points to Connections when the workspace is not connected", async () => {
    workspace.state = "not_connected";
    await mount();
    expect(host.textContent).toContain("Connect a Slack workspace first.");
    await click("Open connections");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "connections" });
    expect(button("Add to Slack")).toBeUndefined();
  });

  it("provisions the bot, opens Slack, then offers the fallback link inline", async () => {
    await mount();
    expect(host.textContent).toContain("Scout gets its own Slack app, name and DMs.");
    await click("Add to Slack");
    expect(fixture.api).toHaveBeenCalledWith("/api/slack/bots/b1/provision", { method: "POST" });
    expect(window.open).toHaveBeenCalledWith(authorizeUrl, "_blank", "noopener,noreferrer");
    expect(host.textContent).toContain("Waiting for Slack…");
    expect(host.textContent).toContain("paste the link from the Slack page here");
    expect(button("Continue").disabled).toBe(true);
    const state = "a".repeat(64);
    write("Link from Slack", `madanibot://slack/oauth?code=fixture-code&state=${state}`);
    await click("Continue");
    expect(fixture.api).toHaveBeenCalledWith("/api/slack/oauth", expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "fixture-code", state }) }));
    expect(host.textContent).toContain("One more step.");
  });

  it("shows a provisioned bot's waiting state on reopening", async () => {
    status.state = "provisioned";
    await mount();
    expect(host.textContent).toContain("Waiting for Slack…");
    expect(button("Add to Slack")).toBeTruthy();
  });

  it("guides the app token step and saves the pasted token", async () => {
    status.state = "installed";
    await mount();
    expect(host.textContent).toContain("One more step. Slack has no way to do this for us.");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(status.appTokenUrl);
    expect(host.textContent).toContain("connections:write");
    expect(button("Save").disabled).toBe(true);
    write("App token", "xapp-fixture");
    await click("Save");
    expect(fixture.api).toHaveBeenCalledWith("/api/slack/bots/b1/app-token", { method: "POST", body: JSON.stringify({ token: "xapp-fixture" }) });
    expect(host.textContent).toContain("Online as @scout in Acme");
    expect(host.innerHTML).not.toContain("xapp-fixture");
  });

  it("shows online identity, a Slack link and the channel invitation", async () => {
    status.state = "online";
    await mount();
    expect(host.textContent).toContain("Online as @scout in Acme");
    expect(host.textContent).toContain("/invite @scout in each channel Scout should read");
    await click("Open in Slack");
    expect(window.open).toHaveBeenCalledWith(status.openUrl, "_blank", "noopener,noreferrer");
  });

  it("does not open an unsafe Slack URL", async () => {
    status.state = "online";
    status.openUrl = "javascript:alert(1)";
    await mount();
    expect(button("Open in Slack")).toBeUndefined();
  });

  it("shows offline status and reconnecting copy", async () => {
    status.state = "offline";
    await mount();
    expect(host.textContent).toContain("Offline");
    expect(host.textContent).toContain("Reconnecting to Slack…");
    expect(button("Remove from Slack")).toBeTruthy();
  });

  it("shows the Slack error with a replacement token field and Remove", async () => {
    status.state = "error";
    status.error = "Slack refused the app-level token.";
    await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(status.error);
    expect(host.querySelector('input[type="password"]')).toBeTruthy();
    expect(button("Remove from Slack")).toBeTruthy();
  });

  it("confirms removal inline, can cancel, and only then deletes the app", async () => {
    status.state = "online";
    await mount();
    await click("Remove from Slack");
    expect(host.textContent).toContain("Remove Scout from Slack? Its Slack app is deleted.");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(fixture.api.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await click("Cancel");
    expect(button("Remove from Slack")).toBeTruthy();
    await click("Remove from Slack");
    await click("Remove");
    expect(fixture.api).toHaveBeenCalledWith("/api/slack/bots/b1", { method: "DELETE" });
    expect(button("Add to Slack")).toBeTruthy();
  });

  it("reloads on an OAuth result for this bot and ignores another bot", async () => {
    status.state = "provisioned";
    await mount();
    const before = reads();
    window.dispatchEvent(new CustomEvent(SLACK_OAUTH_EVENT, { detail: { ok: true, status: { ...status, botId: "b2" } } }));
    await settle();
    expect(reads()).toBe(before);
    status = { ...status, state: "installed" };
    window.dispatchEvent(new CustomEvent(SLACK_OAUTH_EVENT, { detail: { ok: true, status } }));
    await settle();
    expect(reads()).toBe(before + 1);
    expect(host.textContent).toContain("One more step.");
  });

  it("shows server errors from failed actions", async () => {
    await mount();
    fixture.api.mockRejectedValueOnce(new ApiError("Refused", 422, { error: "Workspace needs reconnecting" }));
    await click("Add to Slack");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Workspace needs reconnecting");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("ignores a late bot read after moving to another bot", async () => {
    let resolve!: (value: SlackBotStatus) => void;
    const late = new Promise<SlackBotStatus>((done) => { resolve = done; });
    fixture.api.mockImplementation(async (path: string) => path === "/api/slack/workspace" ? workspace : path.endsWith("b1") ? late : { ...status, botId: "b2" });
    flushSync(() => root.render(createElement(SlackBotPage, { bot })));
    await settle();
    await mount({ ...bot, id: "b2", name: "Other" });
    resolve({ ...status, state: "online" });
    await settle();
    expect(host.textContent).toContain("Other gets its own Slack app");
    expect(host.textContent).not.toContain("online as");
  });

  it("polls after Add to Slack and stops at installed", async () => {
    await mount();
    vi.useFakeTimers();
    flushSync(() => button("Add to Slack").click());
    await microtasks();
    const before = reads();
    await vi.advanceTimersByTimeAsync(4000);
    await microtasks();
    expect(reads()).toBe(before + 1);
    status = { ...status, state: "installed" };
    await vi.advanceTimersByTimeAsync(4000);
    await microtasks();
    const installed = reads();
    await vi.advanceTimersByTimeAsync(8000);
    expect(reads()).toBe(installed);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds offline polling to ten minutes", async () => {
    status.state = "offline";
    vi.useFakeTimers();
    flushSync(() => root.render(createElement(SlackBotPage, { bot })));
    await microtasks();
    const before = reads();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await microtasks();
    expect(reads() - before).toBe(150);
    const stopped = reads();
    await vi.advanceTimersByTimeAsync(12000);
    expect(reads()).toBe(stopped);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an active poll on unmount", async () => {
    status.state = "offline";
    vi.useFakeTimers();
    flushSync(() => root.render(createElement(SlackBotPage, { bot })));
    await microtasks();
    expect(vi.getTimerCount()).toBe(2);
    const before = reads();
    flushSync(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(8000);
    expect(reads()).toBe(before);
  });

  it("does not poll a provisioned bot before Add to Slack is clicked", async () => {
    status.state = "provisioned";
    vi.useFakeTimers();
    flushSync(() => root.render(createElement(SlackBotPage, { bot })));
    await microtasks();
    const before = reads();
    await vi.advanceTimersByTimeAsync(8000);
    expect(reads()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses friendly fallback copy if completing OAuth fails without a server error", async () => {
    status.state = "provisioned";
    await mount();
    const implementation = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation((path: string, init?: RequestInit) => path === "/api/slack/oauth" ? Promise.reject(new Error("private diagnostic")) : implementation(path, init));
    write("Link from Slack", `madanibot://slack/oauth?code=fixture-code&state=${"a".repeat(64)}`);
    await click("Continue");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not update Slack. Try again.");
    expect(host.textContent).not.toContain("private diagnostic");
  });

  it("shares route availability for sixty seconds and reads the row state without polling", async () => {
    function Probe() { return createElement("span", null, `${useSlackAvailable()}:${useSlackBotState("b1")}`); }
    vi.useFakeTimers();
    flushSync(() => root.render(createElement(Probe)));
    await microtasks();
    expect(host.textContent).toBe("true:not_linked");
    expect(fixture.api.mock.calls.filter(([path]) => path === "/api/slack/workspace")).toHaveLength(1);
    flushSync(() => root.render(null));
    flushSync(() => root.render(createElement(Probe)));
    await microtasks();
    expect(fixture.api.mock.calls.filter(([path]) => path === "/api/slack/workspace")).toHaveLength(1);
    const before = reads();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(reads()).toBe(before);
    fixture.api.mockImplementation(async (path: string) => { if (path === "/api/slack/workspace") throw new ApiError("Not found", 404); return status; });
    flushSync(() => root.render(null));
    flushSync(() => root.render(createElement(Probe)));
    await microtasks();
    expect(host.textContent).toBe("false:not_linked");
    expect(fixture.api.mock.calls.filter(([path]) => path === "/api/slack/workspace")).toHaveLength(2);
  });

  it("a hook that changes bot ids ignores a late provision answer", async () => {
    let resolve!: (value: { status: SlackBotStatus; authorizeUrl: string }) => void;
    let hook!: ReturnType<typeof useSlackBot>;
    function Probe({ id }: { id: string }) { hook = useSlackBot(id); return createElement("span", null, hook.status?.botId); }
    flushSync(() => root.render(createElement(Probe, { id: "b1" })));
    await settle();
    fixture.api.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const provision = hook.provision();
    fixture.api.mockResolvedValue({ ...status, botId: "b2" });
    flushSync(() => root.render(createElement(Probe, { id: "b2" })));
    await settle();
    resolve({ status: { ...status, state: "provisioned" }, authorizeUrl });
    expect(await provision).toBeNull();
    await settle();
    expect(host.textContent).toBe("b2");
  });
});
