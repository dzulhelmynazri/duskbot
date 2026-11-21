import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asleepAnswer, cloudAsleep, cloudPaused, markCloudAsleep, markCloudAwake, onCloudPower, noteCloudPageActivity, resetCloudPowerForTests, sleepingFrame, IDLE_PAGE_MS } from "./cloud-power";

beforeEach(() => noteCloudPageActivity(0));
afterEach(() => { vi.unstubAllGlobals(); resetCloudPowerForTests(); });

class Target {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, new Set([...this.listeners.get(type) ?? [], listener])); }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(); }
  get size() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

describe("a page of a Cloud home that sleeps", () => {
  it("shows only the owner's own pause: a sleep to save cost reads as live", () => {
    const target = new Target();
    markCloudAsleep(target as unknown as Window);
    expect(cloudAsleep()).toBe(true);
    expect(cloudPaused()).toBe(false);
    target.emit("keydown");
    markCloudAsleep(target as unknown as Window, undefined, { byOwner: true });
    expect(cloudPaused()).toBe(true);
    target.emit("pointerdown");
    expect(cloudPaused()).toBe(false);
  });

  it("goes quiet when told, tells listeners once, and wakes on the person's next action", () => {
    const target = new Target(), heard = vi.fn();
    onCloudPower(heard);
    markCloudAsleep(target as unknown as Window);
    markCloudAsleep(target as unknown as Window);
    expect(cloudAsleep()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    target.emit("keydown");
    expect(cloudAsleep()).toBe(false);
    expect(heard).toHaveBeenLastCalledWith(false);
    expect(target.size).toBe(0);
    markCloudAwake();
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("wakes the home by using it: one request it counts as someone using it, once per wake", () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const target = new Target();
    markCloudAsleep(target as unknown as Window);
    expect(fetch).not.toHaveBeenCalled();
    target.emit("pointerdown");
    markCloudAwake();
    expect(fetch).toHaveBeenCalledOnce();
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe("/api/cloud/wake");
    expect(JSON.parse(String(init?.body))).toEqual({ intent: "click" });
    expect(new Headers(init?.headers).get("x-madani-background")).toBeNull();
  });

  it("knows the home's asleep answer and its sleeping frame", () => {
    expect(asleepAnswer({ status: 503, headers: new Headers({ "x-madani-cloud-power": "asleep" }) })).toBe(true);
    expect(asleepAnswer({ status: 503, headers: new Headers() })).toBe(false);
    expect(asleepAnswer({ status: 200, headers: new Headers({ "x-madani-cloud-power": "asleep" }) })).toBe(false);
    expect(sleepingFrame({ kind: "power", state: "sleeping" })).toBe(true);
    expect(sleepingFrame({ kind: "power", state: "awake" })).toBe(false);
    expect(sleepingFrame({ kind: "message" })).toBe(false);
  });
});

class Visibility extends Target {
  visibilityState: DocumentVisibilityState = "visible";
}

describe("never asleep to the person", () => {
  it("a page someone is using wakes it straight back and never reads as asleep", () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    noteCloudPageActivity();
    const target = new Target(), page = new Visibility(), heard = vi.fn();
    onCloudPower(heard);
    markCloudAsleep(target as unknown as Window, page as unknown as Document);
    expect(cloudAsleep()).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual(["/api/cloud/wake", expect.objectContaining({ method: "POST" })]);
    expect(target.size + page.size).toBe(0);
  });

  it("an untouched page lets it sleep, then any touch wakes it", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    noteCloudPageActivity(Date.now() - IDLE_PAGE_MS - 1);
    const target = new Target(), page = new Visibility();
    markCloudAsleep(target as unknown as Window, page as unknown as Document);
    expect(cloudAsleep()).toBe(true);
    target.emit("touchstart");
    expect(cloudAsleep()).toBe(false);
    expect(target.size + page.size).toBe(0);
  });

  it("a hidden page waits, and wakes it the moment it shows again", () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    noteCloudPageActivity();
    const target = new Target(), page = new Visibility();
    page.visibilityState = "hidden";
    markCloudAsleep(target as unknown as Window, page as unknown as Document);
    expect(cloudAsleep()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    page.emit("visibilitychange");
    expect(cloudAsleep()).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
