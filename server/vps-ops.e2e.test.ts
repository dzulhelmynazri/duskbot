import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-madani.ts";
import { collectVpsOpsStatus, type VpsOpsOptions } from "./vps-ops.ts";

it("reads the isolated server's real health and still returns service diagnostics after it stops", async () => {
  const fixture = await launchVerificationServer({});
  const options: VpsOpsOptions = { action: "doctor", port: Number(new URL(fixture.info.url).port), dataDir: fixture.info.dataDir, service: "server", lines: 100, json: true };
  const command = async (command: string) => command === "docker"
    ? { ok: true, stdout: "running\n" }
    : { ok: true, stdout: "LoadState=loaded\nActiveState=active\nMainPID=123\nNRestarts=0\n" };
  try {
    const live = await collectVpsOpsStatus(options, { command });
    expect(live.http.ready).toBe(true);
    expect(live.healthy).toBe(true);
    expect(live.computers.running).toBe(1);
  } finally {
    await fixture.close();
  }
  const stopped = await collectVpsOpsStatus(options, { command });
  expect(stopped.http.ready).toBe(false);
  expect(stopped.healthy).toBe(false);
  expect(stopped.services.server.state).toBe("active");
  expect(stopped.hints.join("\n")).toContain("--service server");
});
