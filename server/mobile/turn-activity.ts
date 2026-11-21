// The iPhone Live Activities a turn keeps up to date by push: the ones a phone started for a thread (and registered its
// token for), and, when a bot needs the person and no phone shows that thread, one started by push (iOS 17.2+).
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

import {
  nextTurnActivity, replyFirstLine, turnActivityEnded, turnActivityStart, TURN_ACTIVITY_DISMISS_S, TURN_LINE_SEAL,
  type TurnActivityAttributes, type TurnActivityEvent, type TurnActivityRegistration, type TurnActivityState,
} from "../../shared/phone-activity.ts";
import { madaniBody } from "../../shared/body-migration.ts";
import type { ActivityPush, PushOutcome } from "./push.ts";

/** ActivityKit ends an activity after eight hours whatever it is told */
const ACTIVITY_MAX_MS = 8 * 60 * 60_000;
/** a step changes far more often than anyone reads the lock screen; one push per this at most */
export const STEP_PUSH_GAP_MS = 5_000;
const MAX_PER_THREAD = 8;
const B64URL_KEY = /^[A-Za-z0-9_-]{43}$/;

export interface ActivityTarget { token: string; environment?: "sandbox" | "production" }

interface Activity extends ActivityTarget {
  deviceId: string;
  key?: string;
  state: TurnActivityState;
  createdAt: number;
  sentAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export function turnActivityAttributes(bot: { id: string; name: string; color: string; mascotBody?: string | null }, threadId: string, groupId?: string): TurnActivityAttributes {
  return { botId: bot.id, botName: [...bot.name].slice(0, 80).join(""), threadId, ...(groupId ? { groupId } : {}), color: bot.color, body: madaniBody(bot.mascotBody) };
}

/** The reply's first line, readable only with the private half of `key` (X25519, base64url). */
export function sealTurnLine(key: string, line: string): string {
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: key }, format: "jwk" }) });
  const aesKey = Buffer.from(hkdfSync("sha256", shared, TURN_LINE_SEAL.salt, TURN_LINE_SEAL.info, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const sealed = Buffer.concat([cipher.update(line, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const pub = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x!, "base64url");
  return Buffer.concat([pub, iv, sealed]).toString("base64url");
}

export function createTurnActivities(deps: {
  send(target: ActivityTarget, push: ActivityPush): Promise<PushOutcome>;
  /** the push-to-start tokens of phones an ask may open an activity on */
  startTargets(): Array<ActivityTarget & { deviceId: string }>;
  now?: () => number;
  log?: (line: string) => void;
}) {
  const now = deps.now ?? Date.now;
  const threads = new Map<string, Activity[]>();
  const startedFor = new Set<string>();
  const seconds = () => Math.floor(now() / 1000);

  function drop(threadId: string, activity: Activity) {
    clearTimeout(activity.timer);
    const list = (threads.get(threadId) ?? []).filter((one) => one !== activity);
    if (list.length) threads.set(threadId, list); else threads.delete(threadId);
  }

  function push(threadId: string, activity: Activity, priority: 5 | 10) {
    clearTimeout(activity.timer);
    activity.timer = undefined;
    activity.sentAt = now();
    const ended = turnActivityEnded(activity.state);
    const { line: _line, ...state } = activity.state;
    const message: ActivityPush = {
      event: ended ? "end" : "update", state, timestamp: seconds(), priority,
      ...(ended ? { dismissAt: seconds() + TURN_ACTIVITY_DISMISS_S } : {}),
    };
    if (ended) drop(threadId, activity);
    void deps.send(activity, message).catch(() => "failed" as const).then((outcome) => {
      if (outcome === "gone") drop(threadId, activity);
    });
  }

  function prune() {
    for (const [threadId, list] of threads) for (const one of list) if (now() - one.createdAt > ACTIVITY_MAX_MS) drop(threadId, one);
  }

  function startByPush(threadId: string, requestId: string, kind: "approve" | "answer", attributes: TurnActivityAttributes) {
    const once = `${threadId}:${requestId}`;
    if (startedFor.has(once)) return;
    startedFor.add(once);
    if (startedFor.size > 500) startedFor.delete(startedFor.values().next().value!);
    const state = nextTurnActivity(turnActivityStart(seconds()), { type: "ask", kind, requestId });
    for (const target of deps.startTargets()) {
      void deps.send(target, { event: "start", state, attributes, timestamp: seconds(), priority: 10 }).catch(() => "failed" as const);
    }
  }

  return {
    register(deviceId: string, registration: TurnActivityRegistration & { startedAt?: number }) {
      prune();
      const others = (threads.get(registration.threadId) ?? []).filter((one) => one.deviceId !== deviceId);
      for (const old of threads.get(registration.threadId) ?? []) if (old.deviceId === deviceId) clearTimeout(old.timer);
      const startedAt = typeof registration.startedAt === "number" && registration.startedAt > 0 && registration.startedAt <= seconds() ? registration.startedAt : seconds();
      const activity: Activity = {
        deviceId, token: registration.token, ...(registration.environment ? { environment: registration.environment } : {}),
        ...(registration.key && B64URL_KEY.test(registration.key) ? { key: registration.key } : {}),
        state: turnActivityStart(startedAt), createdAt: now(), sentAt: 0,
      };
      threads.set(registration.threadId, [...others, activity].slice(-MAX_PER_THREAD));
    },
    unregister(deviceId: string, threadId: string) {
      for (const one of threads.get(threadId) ?? []) if (one.deviceId === deviceId) drop(threadId, one);
    },
    forgetDevice(deviceId: string) {
      for (const [threadId, list] of threads) for (const one of list) if (one.deviceId === deviceId) drop(threadId, one);
    },
    /** `attributes` lets an ask start an activity by push where no phone shows the thread; `reply` is the done turn's text */
    event(threadId: string, event: TurnActivityEvent, context: { attributes?: TurnActivityAttributes; reply?: string } = {}) {
      const list = threads.get(threadId);
      if (!list?.length) {
        if (event.type === "ask" && context.attributes) startByPush(threadId, event.requestId, event.kind, context.attributes);
        return;
      }
      const line = event.type === "done" && context.reply ? replyFirstLine(context.reply) : "";
      for (const activity of list) {
        let sealed: string | undefined;
        if (line && activity.key) {
          try { sealed = sealTurnLine(activity.key, line); } catch { sealed = undefined; }
        }
        const next = nextTurnActivity(activity.state, event.type === "done" ? { type: "done", ...(sealed ? { sealed } : {}) } : event);
        if (next === activity.state) continue;
        const phaseChanged = next.phase !== activity.state.phase;
        activity.state = next;
        if (phaseChanged) { push(threadId, activity, next.phase === "working" ? 5 : 10); continue; }
        const wait = activity.sentAt + STEP_PUSH_GAP_MS - now();
        if (wait <= 0) { push(threadId, activity, 5); continue; }
        if (!activity.timer) {
          activity.timer = setTimeout(() => { if (threads.get(threadId)?.includes(activity)) push(threadId, activity, 5); }, wait);
          activity.timer.unref?.();
        }
      }
    },
    /** for tests */
    state: (threadId: string) => (threads.get(threadId) ?? []).map((one) => ({ deviceId: one.deviceId, state: one.state })),
  };
}
