import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-madani.ts";
import { serverVersion } from "./environment.ts";

it("offers no upstream binary or install command through the real private-fork server", async () => {
  const fixture = await launchVerificationServer({});
  try {
    const response = await fetch(`${fixture.info.url}/api/updates/check`, {
      headers: { origin: fixture.info.url }, signal: AbortSignal.timeout(10_000),
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ current: serverVersion(), install: "git", available: false });
  } finally {
    await fixture.close();
  }
});
