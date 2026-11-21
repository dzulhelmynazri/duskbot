// the desktop app's own update notice. its server answers GET /api/updates/check from madani.bot's signed release manifest
// (server/update-check.ts); a newer release gets one notification per version, which opens the download page. nothing is
// downloaded or installed for the person.
const DAY_MS = 24 * 60 * 60_000;

export function createUpdateNotice({ request, notify, open, memory, log = () => {}, firstDelayMs = 2 * 60_000, intervalMs = DAY_MS, timers = globalThis }) {
  let timer = null;
  async function check() {
    try {
      const response = await request("/api/updates/check", { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return null;
      const answer = await response.json();
      if (answer?.install !== "desktop" || answer.available !== true || typeof answer.latest !== "string" || typeof answer.releaseUrl !== "string") return null;
      if (!answer.releaseUrl.startsWith("https://madani.bot/")) return null;
      let told = null;
      try { told = memory.read()?.told ?? null; } catch {}
      if (told === answer.latest) return null;
      memory.write({ told: answer.latest });
      notify({ title: `madani bot ${answer.latest} is available`, body: "Click to download it from madani.bot.", click: () => open(answer.releaseUrl) });
      return answer.latest;
    } catch (error) {
      log(`update notice: check failed (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  }
  return {
    check,
    start() {
      if (timer) return;
      const run = (delay) => { timer = timers.setTimeout(() => { void check().finally(() => run(intervalMs)); }, delay); timer?.unref?.(); };
      run(firstDelayMs);
    },
    stop() { if (timer) timers.clearTimeout(timer); timer = null; },
  };
}
