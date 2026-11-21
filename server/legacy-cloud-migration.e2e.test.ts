import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-madani.ts";

it("drops a legacy desktop token from disk, never shows it, and normalizes old client backend values through HTTP", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as Record<string, any>;
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  try {
    const configPath = join(fixture.info.dataDir, "config.json");
    const legacyToken = "legacy-desktop-fixture-secret";
    const stored = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...stored, box: { token: legacyToken } }));
    const changed = await api("PATCH", "/api/config", { features: { showToolCalls: true } });
    expect(JSON.stringify(changed)).not.toContain(legacyToken);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).not.toHaveProperty("box");
    const rejected = await api("PUT", "/api/config", { box: { token: "replacement-fixture-secret" } }, 400);
    expect(rejected.error).toContain("Paid desktop provider settings are no longer supported");
    expect(readFileSync(configPath, "utf8")).not.toContain("replacement-fixture-secret");
    const status = await api("GET", "/api/config");
    expect(status).not.toHaveProperty("box");
    expect(JSON.stringify(status)).not.toContain(legacyToken);
    const legacy = await api("POST", "/api/bots", { name: "Legacy client", settings: { cloudBackend: "box", computer: "off" } }, 201);
    expect(legacy.bot).toMatchObject({ cloudBackend: "vps", computer: "off" });
    const patched = await api("PATCH", `/api/bots/${legacy.bot.id}`, { cloudBackend: "box" });
    expect(patched.bot).toMatchObject({ cloudBackend: "vps", computer: "off" });
  } finally {
    await fixture.close();
  }
}, 60_000);
