import { describe, expect, it, vi } from "vitest";

import { APP_SETTINGS_PATH } from "../drivers/agents-app-settings-tool.ts";
import { createAppSettings } from "./app-settings.ts";

function harness(refusal: string | null = null, team = false) {
  const kept: Record<string, { value: string | null; at: number }> = {};
  const sync = {
    ui: () => kept,
    setUi: vi.fn((name: string, value: string | null, at: number) => { kept[name] = { value, at }; return { ok: true, at }; }),
  };
  const changed = vi.fn();
  const settings = createAppSettings({ sync: () => (team ? null : sync), refusal: () => refusal, changed, now: () => 5 });
  const call = async (body: unknown) => {
    let answer: { status: number; body: Record<string, string> } | undefined;
    await settings.internal({ method: "POST", path: APP_SETTINGS_PATH, res: {} as never, botId: "b", threadId: "t", readBody: async () => body,
      json: ((_res: unknown, status: number, out: Record<string, string>) => { answer = { status, body: out }; }) as never });
    return answer!;
  };
  return { sync, changed, call };
}

describe("app_settings", () => {
  it("sets a preference the person asked for and tells every screen", async () => {
    const h = harness();
    const set = await h.call({ action: "set", setting: "theme", value: "Midnight" });
    expect(set).toMatchObject({ status: 200, body: { text: expect.stringContaining("Set theme to midnight") } });
    expect(h.sync.setUi).toHaveBeenCalledWith("madani-skin", "midnight", 5);
    expect(h.changed).toHaveBeenCalledOnce();
    expect((await h.call({ action: "list" })).body.text).toContain("theme: midnight (one of system,");
  });

  it("refuses unknown settings and values, other people's turns and a Team Cloud, saying why", async () => {
    const h = harness();
    expect((await h.call({ action: "set", setting: "theme", value: "plaid" })).body.error).toMatch(/^theme must be one of system, /);
    expect((await h.call({ action: "set", setting: "wallpaper", value: "x" })).body.error).toMatch(/no app setting "wallpaper"/);
    expect((await harness("An automation run cannot change the person's app preferences.").call({ action: "set", setting: "font", value: "serif" })))
      .toMatchObject({ status: 403, body: { error: expect.stringContaining("automation") } });
    expect((await harness(null, true).call({ action: "set", setting: "font", value: "serif" })).status).toBe(409);
    expect(h.sync.setUi).not.toHaveBeenCalled();
  });
});
