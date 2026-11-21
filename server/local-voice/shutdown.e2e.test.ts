// A harness holding the built-in voice's models must still stop cleanly: ONNX Runtime 1.23 aborted the process at exit
// ("mutex lock failed") with sessions loaded. Runs where the models are downloaded:
// MADANI_VOICE_MODELS_DIR=... pnpm exec vitest run server/local-voice/shutdown.e2e.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-madani.ts";
import { ModelStore } from "./models.ts";

const ready = Boolean(process.env.MADANI_VOICE_MODELS_DIR) && new ModelStore().status().phase === "ready";

describe.skipIf(!ready)("a harness with the built-in voice loaded", () => {
  it("exits cleanly on SIGTERM, even mid-sentence", async () => {
    const fixture = await launchVerificationServer({ ...process.env });
    try {
      const base = fixture.info.url;
      const prepared = await fetch(`${base}/api/voice/local/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wait: true }) });
      expect(prepared.status).toBe(202);
      const speaking = fetch(`${base}/api/voice/local/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "This sentence is still being spoken when the harness is asked to stop, which is the point." }) }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => fixture.child.once("exit", (code, signal) => resolve({ code, signal })));
      fixture.child.kill("SIGTERM");
      const { code, signal } = await exited;
      await speaking;
      expect(signal === "SIGTERM" || code === 0 || code === 143, `exit code ${code} signal ${signal}`).toBe(true);
      expect(signal).not.toBe("SIGABRT");
      const log = readFileSync(fixture.info.logPath, "utf8");
      expect(log).not.toMatch(/libc\+\+abi|mutex lock failed|terminating due to uncaught/);
    } finally {
      await fixture.close();
    }
  }, 120_000);
});
