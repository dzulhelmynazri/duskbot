import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_SIGN_IN_HOLD_MS, createAppSignIns } from "./app-sign-ins.ts";
import { CLOUD_IDLE_WORK_MS, createCloudPower } from "./cloud-power.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("app sign-ins", () => {
  it("hold until the app is connected, or ten minutes at most", () => {
    let clock = 1_800_000_000_000;
    const signIns = createAppSignIns(() => clock);
    expect(signIns.active()).toBe(false);
    signIns.started("Gmail");
    expect(signIns.active()).toBe(true);
    signIns.settled(["slack"]);
    expect(signIns.active()).toBe(true);
    signIns.settled(["gmail"]);
    expect(signIns.active()).toBe(false);
    signIns.started("gmail");
    clock += APP_SIGN_IN_HOLD_MS - 1;
    expect(signIns.active()).toBe(true);
    clock += 1;
    expect(signIns.active()).toBe(false);
  });

  it("keep an idle madani cloud from agreeing to sleep while one is open", () => {
    let clock = 1_800_000_000_000;
    const signIns = createAppSignIns(() => clock);
    const dataDir = mkdtempSync(join(tmpdir(), "madani-sign-in-"));
    dirs.push(dataDir);
    const power = createCloudPower({ dataDir, now: () => clock, broadcast: () => {}, probes: {
      turn: () => false, run: () => false, liveCall: () => false, computer: () => false, maintenance: () => signIns.active(), nextDueAt: () => null } });
    try {
      power.noteActivity();
      signIns.started("gmail");
      // the owner is on Google's consent page: nothing reaches the cloud, and the admin's 3-minute idle window runs out
      for (const end = clock + 5 * 60_000; clock < end; clock += 5_000) power.tick();
      expect(power.prepareSleep(3 * 60_000)).toEqual({ ok: false, busy: ["maintenance"] });
      signIns.settled(["gmail"]);
      for (const end = clock + CLOUD_IDLE_WORK_MS + 1; clock < end; clock += 5_000) power.tick();
      expect(power.prepareSleep(3 * 60_000).ok).toBe(true);
    } finally { power.close(); }
  });
});
