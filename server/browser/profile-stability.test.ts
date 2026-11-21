// A bot's browser keeps its sign-ins (x.com included) across turns and app restarts: the same bot always lands on the same
// profile folder, which nothing erases, under both browser engines; only a chosen temporary browser is thrown away.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { agentBrowserIntegration, browserProfileDirectory, browserSessionId, isTemporaryBrowserSession } from "../browser-engine.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ensureProfile, profileDir, profileKind } from "./chrome/profile.ts";
import { profileKey } from "./engines.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTempDir)); });
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "madani-profile-stable-")); roots.push(dir); return dir; };

describe("a bot's browser profile", () => {
  it("is the same kept folder on every turn and after a restart, on the Chrome engine", () => {
    const dir = dataDir();
    const key = profileKey("bot1", "bot-bot1", { guest: false, partitionId: null });
    expect(key).toBe("bot:bot1");
    expect(profileKind(key)).toBe("bot");
    const first = ensureProfile(dir, key);
    // a restart reads the same workspace id back, so the same folder
    expect(profileDir(dir, key)).toBe(first.dir);
    expect(ensureProfile(dir, key)).toMatchObject({ dir: first.dir, created: false });
    expect(first.dir).toContain(join("browser", "profiles"));
    expect(profileDir(dir, profileKey("bot1", "guest-x", { guest: true, partitionId: null }))).toContain(join("browser", "temp"));
  });

  it("is the same kept folder with saved cookies on every turn, on the agent-browser engine", () => {
    const dir = dataDir();
    const session = browserSessionId("bot1", "", dir);
    expect(session).toBe("bot-bot1");
    expect(browserSessionId("bot1", "", dir)).toBe(session);
    expect(isTemporaryBrowserSession(session, dir)).toBe(false);
    const spec = agentBrowserIntegration({ binaryPath: "agent-browser", session, encryptionKey: "k", persistent: true, dataDir: dir, env: {} });
    expect(spec.env.AGENT_BROWSER_PROFILE).toBe(browserProfileDirectory(session, dir));
    expect(spec.env.AGENT_BROWSER_RESTORE_SAVE).toBe("auto");
    const guest = agentBrowserIntegration({ binaryPath: "agent-browser", session: browserSessionId("bot1", "guest", dir), encryptionKey: "k", persistent: false, dataDir: dir, env: {} });
    expect(guest.env.AGENT_BROWSER_PROFILE).toBeUndefined();
    expect(guest.env.AGENT_BROWSER_RESTORE_SAVE).toBe("never");
  });
});
