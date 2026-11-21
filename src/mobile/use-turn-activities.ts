import { useCallback, useEffect, useRef } from "react";

import type { AppState, Bot } from "@/state/store";
import { onAnyTurnLive, turnLive } from "@/state/turn-status";
import { madaniBody } from "../../shared/body-migration";
import { turnActivityEnded, turnActivityStart, type TurnActivityRegistration, type TurnActivityState } from "../../shared/phone-activity";
import { liveActivityEnabled, subscribeLiveActivity } from "./live-activity-setting";
import type { MobilePlatform } from "./platform";
import { localTurnActivity, sameTurnActivity, turnUnderway } from "./turn-activity";

/** a turn the bot never picked up in this long is not coming; its activity goes */
const NEVER_STARTED_MS = 90_000;

interface Tracked { id: string; botId: string; threadId: string; state: TurnActivityState; underway: boolean; createdAt: number }

const environment = import.meta.env.DEV ? "sandbox" : "production";

async function put(path: string, body: object, method: "PUT" | "DELETE" = "PUT"): Promise<void> {
  try {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
  } catch {}
}

/** The Live Activity of a turn the person started from this phone: started as the message leaves, kept current from the
 * app's own state while it is open, and handed to the bot host's pushes (by its token) once it is not. Returns the
 * function that starts one. */
export function useTurnActivities(platform: MobilePlatform, state: AppState): (bot: Bot) => void {
  const bridge = platform.turnActivity;
  const tracked = useRef(new Map<string, Tracked>());
  const latest = useRef(state);
  latest.current = state;

  const refresh = useCallback(() => {
    if (!bridge) return;
    for (const one of Array.from(tracked.current.values())) {
      const bot = latest.current.bots.find((candidate) => candidate.id === one.botId);
      if (!bot) continue;
      const live = turnLive(one.threadId);
      if (turnUnderway(bot, live)) one.underway = true;
      if (!one.underway) {
        if (Date.now() - one.createdAt > NEVER_STARTED_MS) { tracked.current.delete(one.id); void bridge.end(one.id, one.state, true).catch(() => {}); }
        continue;
      }
      const next = localTurnActivity(one.state, bot, live);
      if (sameTurnActivity(next, one.state)) continue;
      one.state = next;
      if (turnActivityEnded(next)) { tracked.current.delete(one.id); void bridge.end(one.id, next).catch(() => {}); }
      else void bridge.update(one.id, next).catch(() => {});
    }
  }, [bridge]);

  useEffect(() => { refresh(); }, [state, refresh]);
  useEffect(() => (bridge ? onAnyTurnLive(refresh) : undefined), [bridge, refresh]);

  useEffect(() => {
    if (!bridge) return;
    let startToken: string | null = null;
    const stops = [
      bridge.onToken(({ id, threadId, token, startedAt }) => {
        if (!liveActivityEnabled()) { void bridge.end(id, turnActivityStart(startedAt), true).catch(() => {}); return; }
        void (async () => {
          const key = await bridge.lineKey().catch(() => null);
          const body: TurnActivityRegistration & { startedAt: number } = { threadId, token, environment, startedAt, ...(key ? { key } : {}) };
          await put("/api/mobile/activity", body);
        })();
        if (!tracked.current.has(id)) {
          void bridge.list().then((all) => {
            const found = all.find((one) => one.id === id);
            if (found && !tracked.current.has(id)) tracked.current.set(id, { id, botId: found.botId, threadId, state: turnActivityStart(found.startedAt), underway: true, createdAt: Date.now() });
          }).catch(() => {});
        }
      }),
      bridge.onStartToken((token) => {
        startToken = token;
        if (liveActivityEnabled()) void put("/api/mobile/activity-start", { token, environment });
      }),
      // off: what is on the Lock Screen goes now and an ask no longer starts one by push; reply notifications are untouched
      subscribeLiveActivity(() => {
        if (liveActivityEnabled()) {
          if (startToken) void put("/api/mobile/activity-start", { token: startToken, environment });
          return;
        }
        void put("/api/mobile/activity-start", {}, "DELETE");
        for (const one of Array.from(tracked.current.values())) {
          tracked.current.delete(one.id);
          void put("/api/mobile/activity", { threadId: one.threadId }, "DELETE");
          void bridge.end(one.id, one.state, true).catch(() => {});
        }
        void bridge.list().then((all) => { for (const one of all) void bridge.end(one.id, turnActivityStart(one.startedAt), true).catch(() => {}); }).catch(() => {});
      }),
    ];
    return () => { for (const stop of stops) stop(); };
  }, [bridge]);

  return useCallback((bot: Bot) => {
    if (!bridge || !liveActivityEnabled() || Array.from(tracked.current.values()).some((one) => one.threadId === bot.threadId)) return;
    const startedAt = Math.floor(Date.now() / 1000);
    const initial = turnActivityStart(startedAt);
    void bridge.start({ botId: bot.id, botName: bot.name, threadId: bot.threadId, color: bot.color, body: madaniBody(bot.mascotBody) }, initial).then((id) => {
      if (id) tracked.current.set(id, { id, botId: bot.id, threadId: bot.threadId, state: initial, underway: false, createdAt: Date.now() });
    }).catch(() => {});
  }, [bridge]);
}
