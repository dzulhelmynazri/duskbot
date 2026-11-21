import { describe, expect, it } from "vitest";
import { CLOUD_OPENED_HERE, cloudOpenedHere, lateCloudDue, ownCloudStage } from "./late-cloud";

const done = { completedAt: "2026-11-17T10:00:00.000Z", version: 1, reelSeen: false, hintsSeen: ["met-chief-v1"] };
const mine = (status: string) => ({ status: "connected", clouds: [{ primary: true, runsOn: "cloud", role: "owner", status }] });
const base = { local: true, canSave: true, config: { onboarding: done }, account: mine("setting_up"), welcomeShown: false };

describe("a madani cloud plan that comes after the first run", () => {
  it("takes the person into the cloud being made, once, after the first run ended here", () => {
    expect(lateCloudDue(base)).toBe("making");
    expect(lateCloudDue({ ...base, config: { onboarding: { ...done, hintsSeen: [...done.hintsSeen, CLOUD_OPENED_HERE] } } }), "once only").toBeNull();
    expect(lateCloudDue({ ...base, config: { onboarding: { ...done, completedAt: "" } } }), "the first run itself handles it").toBeNull();
    expect(lateCloudDue({ ...base, welcomeShown: true })).toBeNull();
    expect(lateCloudDue({ ...base, local: false }), "never on a remote page").toBeNull();
    expect(lateCloudDue({ ...base, config: { onboarding: done, team: { id: "t" } } })).toBeNull();
    expect(lateCloudDue({ ...base, switched: true }), "a switch of place shows the place chosen").toBeNull();
  });

  it("a cloud that already exists is only recorded, never shown as being made, switch or not", () => {
    for (const status of ["ready", "stopped", "offline", "payment_problem"]) {
      expect(lateCloudDue({ ...base, account: mine(status) }), status).toBe("made");
      expect(lateCloudDue({ ...base, account: mine(status), switched: true }), status).toBe("made");
    }
    expect(lateCloudDue({ ...base, account: { status: "connected", machine: { status: "ready" }, renewal: { renewsAt: 1 } } })).toBe("made");
    expect(lateCloudDue({ ...base, account: { status: "connected", machine: { status: "ready" }, purchase: {} } })).toBe("made");
  });

  it("never for a team member on someone else's plan", () => {
    expect(ownCloudStage({ status: "connected", clouds: [{ primary: false, runsOn: "cloud", role: "member", status: "setting_up" }] })).toBeNull();
    expect(ownCloudStage({ status: "connected", clouds: [{ primary: true, runsOn: "cloud", role: "member", status: "setting_up" }] })).toBeNull();
    expect(ownCloudStage({ status: "connected", machine: { status: "ready" } }), "an older Admin's machine without a renewal of their own").toBeNull();
    expect(ownCloudStage({ status: "connected", machine: { status: "provisioning" }, renewal: { renewsAt: 1 } })).toBe("making");
    expect(ownCloudStage({ status: "connected", purchase: {} }), "paid, no cloud yet").toBe("making");
    expect(ownCloudStage({ status: "signed-out", purchase: {} })).toBeNull();
    expect(ownCloudStage(mine("ended"))).toBeNull();
    expect(ownCloudStage(mine("checkout")), "not paid yet").toBeNull();
  });

  it("a first run that went the madani cloud way is kept as the one that made it, with every hint it had", () => {
    expect(cloudOpenedHere({ onboarding: { completedAt: "x", version: 1 } as { completedAt: string; version: number; hintsSeen?: string[] } }, true, ["a"]).onboarding.hintsSeen).toEqual(["a", CLOUD_OPENED_HERE]);
    expect(cloudOpenedHere({ onboarding: { completedAt: "x", version: 1, hintsSeen: ["a", "b"] } }, true).onboarding.hintsSeen).toEqual(["a", "b", CLOUD_OPENED_HERE]);
    expect(cloudOpenedHere({ onboarding: { completedAt: "x", version: 1 } as { completedAt: string; version: number; hintsSeen?: string[] } }, false).onboarding.hintsSeen).toBeUndefined();
  });
});
