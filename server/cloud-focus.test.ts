import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLOUD_FOCUS_CAP_MS, CLOUD_FOCUS_FRESH_MS, CLOUD_FOCUS_PATH, CLOUD_FOCUS_PING_MS, CLOUD_IDLE_ACTIVITY_MS, CLOUD_IDLE_AWAKE_MS, countsAsActivity, createCloudPower } from "./cloud-power.ts";
import { CLOUD_WAKE_PATH, createCloudPresenceRoutes } from "./routes/cloud-presence.ts";
import { PASS } from "./routes/table.ts";

const START = 1_800_000_000_000;
const dirs: string[] = [];
const powers: { close(): void }[] = [];
afterEach(() => {
  for (const power of powers.splice(0)) power.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home() {
  let clock = START;
  const dataDir = mkdtempSync(join(tmpdir(), "madani-cloud-focus-"));
  dirs.push(dataDir);
  const power = createCloudPower({ dataDir, now: () => clock, broadcast: () => {}, probes: { turn: () => false, run: () => false, liveCall: () => false, computer: () => false, maintenance: () => false, nextDueAt: () => null } });
  powers.push(power);
  const pass = (ms: number) => { for (let left = ms; left > 0; left -= 5_000) { clock += Math.min(5_000, left); power.tick(); } };
  return { power, pass };
}

describe("an app window focused on the home", () => {
  it("reports focus while pinged, and never as someone using the home", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.power.noteFocus();
    expect(h.power.report()).toMatchObject({ idle: false, busy: ["focus"], lastActivityAt: null });
    expect(h.power.prepareSleep()).toEqual({ ok: false, busy: ["focus"] });
    expect(countsAsActivity(CLOUD_FOCUS_PATH, {})).toBe(false);
    // the pings stop (the window lost focus): the hint fades after one missed ping's slack
    h.pass(CLOUD_FOCUS_FRESH_MS);
    expect(h.power.report()).toMatchObject({ idle: true, busy: [] });
  });

  it("is capped at 30 minutes from the later of the focus starting and the last use", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    for (let at = 0; at < CLOUD_FOCUS_CAP_MS - CLOUD_FOCUS_PING_MS; at += CLOUD_FOCUS_PING_MS) { h.power.noteFocus(); h.pass(CLOUD_FOCUS_PING_MS); }
    h.power.noteFocus();
    expect(h.power.report().busy).toEqual(["focus"]);
    h.pass(CLOUD_FOCUS_PING_MS);
    h.power.noteFocus();
    expect(h.power.report().busy).toEqual([]);
    expect(h.power.prepareSleep().ok).toBe(true);
    // someone uses it again: focus counts once more, from that use
    h.power.noteActivity();
    h.power.noteFocus();
    expect(h.power.report(CLOUD_IDLE_ACTIVITY_MS).busy).toEqual(["recent-activity", "focus"]);
  });
});

describe("the presence routes", () => {
  const call = async (route: ReturnType<typeof createCloudPresenceRoutes>, method: string, path: string) => {
    const sent: { status: number; body: unknown }[] = [];
    const out = await route({ res: {} as never, path, method, json: ((_res: unknown, status: number, body: unknown) => { sent.push({ status, body }); }) as never } as never);
    return { out, sent };
  };
  it("notes focus on a Cloud home, answers 404 anywhere else, and passes on what isn't theirs", async () => {
    let focused = 0;
    expect((await call(createCloudPresenceRoutes(() => ({ noteFocus: () => { focused++; } })), "POST", CLOUD_FOCUS_PATH)).sent).toEqual([{ status: 200, body: { ok: true } }]);
    expect(focused).toBe(1);
    expect((await call(createCloudPresenceRoutes(() => null), "POST", CLOUD_FOCUS_PATH)).sent).toEqual([{ status: 404, body: { error: "not_found" } }]);
    expect((await call(createCloudPresenceRoutes(() => null), "POST", CLOUD_WAKE_PATH)).sent).toEqual([{ status: 200, body: { ok: true } }]);
    expect((await call(createCloudPresenceRoutes(() => null), "GET", CLOUD_FOCUS_PATH)).out).toBe(PASS);
    expect(countsAsActivity(CLOUD_WAKE_PATH, {})).toBe(true);
  });
});
