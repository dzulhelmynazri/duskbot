// Security invariants: only an "answer" may name an engine (a decline, or typed words matching no option, is "Not now"),
// so a bot's own shell with decline-only service trust can never switch the engine or resend the person's message.
// A request the job runtime still holds is never sent again: the runtime reruns its root itself.
import { approvalModeFor, modelSwitchNeedsAsk } from "../shared/approval-mode.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { failedReplyReason } from "./failed-reply-reason.ts";
import { randomUUID } from "node:crypto";

import type { LimitMode, QuotaSwitchCardData } from "../shared/wire.ts";
import { recoveryCapabilityError } from "./automatic-recovery.ts";
import type { EngineAccess, ModelCatalog, ModelSelection, ProviderAdapter, ProviderSnapshot } from "./contracts.ts";
import type { Coordinator } from "./coordinator.ts";
import { readyToRun, selectDefaultModelSelection, type SelectableInstance } from "./default-model-selection.ts";
import { limitResetFromWords } from "./drivers/engine-errors.ts";
import { providerFailure } from "./drivers/provider-failover.ts";
import { classifyError } from "./drivers/retry.ts";
import { PROBE_TIMEOUT_MS } from "./engine-install.ts";
import { spokenLineFields } from "./live-call-record.ts";
import type { WorkOrigin } from "./peer-provenance.ts";
import type { BotRecord, Message, Store, TaskRecord } from "./store.ts";
import type { TurnStops } from "./turn-outcome.ts";
import { signedOutStop, type LimitTakeover, type TakeoverScope } from "./host/limit-takeover.ts";
import { aiProductName } from "./limit-resets.ts";
import { resumeNote } from "./host/limit-hold.ts";
import { TAKEOVER_CAUSE } from "./limit-resume.ts";
import { serverLine } from "./server-lines.ts";

export interface QuotaSwitchEngine {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  enabled?: boolean;
  models: ModelCatalog;
  adapter: { capabilities: ProviderAdapter["capabilities"] };
  snapshot: () => Promise<ProviderSnapshot>;
}

export interface QuotaRequest {
  generations: ReadonlySet<string>;
  messageId?: string;
  turnId: string | null;
  stopped?: boolean;
  origin?: WorkOrigin;
}

export type SettledTurn = Parameters<TurnStops["failureCause"]>[0];

export interface QuotaSwitchDeps {
  store: Store;
  coordinator: Pick<Coordinator, "all" | "node">;
  registry: { instances(): QuotaSwitchEngine[] };
  turnStops: Pick<TurnStops, "failureCause"> & Partial<Pick<TurnStops, "read">>;
  /** Which AIs carry on while one is limited or signed out, and the one notice for each stretch of either. */
  takeover?: Pick<LimitTakeover, "backups" | "tell" | "moved"> & Partial<Pick<LimitTakeover, "holdProvider" | "freeSelection">>;
  /** What the bot does at a limit no backup takes: "wait" (the default), "ask" or "free". */
  limitMode?: (botId: string) => LimitMode;
  /** Holds the person's turn until its AI's limit resets, then carries it on there; false when it cannot wait. */
  hold?: (input: { botId: string; threadId: string; from: ModelSelection; resetsAt?: number; request?: string }) => boolean;
  language?: (threadId: string) => string | undefined;
  /** A custom endpoint brings its own credential, so its sign-in state does not count. */
  access?: (instanceId: string) => EngineAccess | undefined;
  refusal?: (engine: QuotaSwitchEngine) => string | undefined;
  gate: (thread: BotRecord, selection: ModelSelection) => { ok: true; selection: ModelSelection } | { ok: false; error: string };
  reset?: (from: ModelSelection, to: ModelSelection) => Partial<TaskRecord> | undefined;
  busy: (botId: string, threadId: string) => boolean;
  request: (threadId: string) => QuotaRequest | undefined;
  /** A line spoken on a Live call is resent as spoken, so its words stay out of the log. */
  resend: (botId: string, threadId: string, message: Message, replyTo: Message | undefined, spoken: { via?: "call"; callId?: string }) => Promise<unknown>;
  /** Carries a limited turn on with the backup it moved to, as the person's request, from where it was cut off. */
  carryOn?: (botId: string, threadId: string, note: string, request: string | undefined) => Promise<unknown>;
  enabled?: () => boolean;
  after?: (ms: number, run: () => void) => { cancel(): void };
}

export interface QuotaSwitch {
  /** Never rejects. */
  turnFailed(bot: BotRecord, event: SettledTurn, internal: boolean): Promise<Message | null>;
  /** Never throws. */
  turnSucceeded(bot: BotRecord, threadId: string): void;
  /** Null when `requestId` is not an open quota card of this thread. "unavailable": refused, and the offer stays open. Never rejects. */
  answer(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", message: unknown): Promise<QuotaAnswer> | null;
}

export type QuotaAnswer = "answered" | "rejected" | "unavailable";

export const NOT_NOW = "Not now";

/** A limit that resets on a clock: an engine's window or one model's. Credits and sign-ins wait for the person. */
const FAILURE_SCAN = 40;
const RESETS: ReadonlySet<TakeoverScope> = new Set<TakeoverScope>(["engine", "model"]);
const LIMITS: ReadonlySet<TakeoverScope> = new Set<TakeoverScope>(["engine", "model", "credits"]);

const ENDED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** On unless MADANI_QUOTA_SWITCH=0: a limited AI's work carries on with another AI by itself. Off, only the backups
 * Automatic recovery names take over, as before. */
/** The failed-reply row a turn left after the person's message `afterId`, while nothing newer has answered it. */
export function turnFailureRow(messages: readonly Message[], afterId: string | undefined): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.id === afterId || message.role === "user" || message.kind === "text") return undefined;
    const tool = message.kind === "activity" ? message.tool : undefined;
    if (tool && !tool.ok && !tool.partial && failedTurnCause(tool.name) !== null) return tool.resolvedAt ? undefined : message;
  }
  return undefined;
}

export function quotaSwitchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MADANI_QUOTA_SWITCH?.trim() !== "0";
}

const nameOf = (engine: QuotaSwitchEngine): string => engine.displayName || engine.driverKind;

/** A line a bot delivered (peerAsk) is never resent in the person's name. */
function resendable(store: Store, threadId: string, messageId: string | undefined): Message | undefined {
  if (!messageId) return undefined;
  const message = store.activePath(threadId).find((candidate) => candidate.id === messageId);
  return message?.role === "user" && message.kind === "text" && message.text && !message.peerAsk ? message : undefined;
}

export function createQuotaSwitch(deps: QuotaSwitchDeps): QuotaSwitch {
  const { store, coordinator } = deps;
  const enabled = deps.enabled ?? (() => quotaSwitchEnabled());
  const after = deps.after ?? ((ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  /** Until one of their turns completes: when a limit reopens is the provider's to say. */
  const limited = new Set<string>();
  /** A turn that works while engines are probed makes the offer stale before it exists. */
  const building = new Set<{ threadId: string; stale: boolean }>();
  /** A second press while the engine is read is the same answer, never another. */
  const answering = new Map<string, Promise<QuotaAnswer>>();
  /** Messages already sent again after a provider failure: a second one on the backup is reported, not rerun. */
  const rerun = new Set<string>();

  const notice = (threadId: string, text: string, ok: boolean, setup = false): void => {
    // `notice:` makes it a status row every client shows, never a folded tool step; `setup`: signing in fixes it.
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${text}`, ok, ...(setup ? { setup: true } : {}) } });
  };

  const openCard = (threadId: string): Message | undefined => store.messagesFor(threadId)
    .find((message) => message.card?.quotaSwitch && !message.card.answered && !message.card.dismissed);

  /** Null on a probe timeout: a hung CLI must hold neither a card nor the request that answers one. */
  const described = async (engine: QuotaSwitchEngine): Promise<SelectableInstance | null> => {
    const snapshot = await new Promise<ProviderSnapshot | null>((resolve) => {
      const wait = after(PROBE_TIMEOUT_MS, () => resolve(null));
      // Wrapped so a probe that throws synchronously rejects.
      new Promise<ProviderSnapshot>((read) => read(engine.snapshot())).catch((): ProviderSnapshot => ({ state: "unavailable" }))
        .then((read) => { wait.cancel(); resolve(read); });
    });
    if (!snapshot) return null;
    const access = deps.access?.(engine.instanceId);
    return {
      instanceId: engine.instanceId, driverKind: engine.driverKind, snapshot, models: engine.models, enabled: engine.enabled !== false,
      capabilities: { effortLevels: engine.adapter.capabilities.effortLevels, modelVariants: engine.adapter.capabilities.modelVariants === true },
      ...(access ? { access } : {}),
    };
  };

  /** One rule for the card and for the answer. */
  const takeover = async (engine: QuotaSwitchEngine, bot: BotRecord, current: QuotaSwitchEngine | undefined): Promise<ModelSelection | "timed-out" | null> => {
    // No current engine: no backup check can be made, so none passes.
    if (!current || limited.has(engine.instanceId)) return null;
    if (recoveryCapabilityError(
      { driverKind: current.driverKind, capabilities: current.adapter.capabilities },
      { driverKind: engine.driverKind, capabilities: engine.adapter.capabilities },
    )) return null;
    if (modelSwitchNeedsAsk(approvalModeFor(bot), current.driverKind, engine.driverKind)) return null;
    const context = { refusal: () => deps.refusal?.(engine) };
    const instance = await described(engine);
    if (!instance) return "timed-out";
    if (!readyToRun(instance, context)) return null;
    const selection = selectDefaultModelSelection([instance], undefined, context);
    return selection.instanceId && selection.model ? selection : null;
  };

  /** The newest root: a backup engine's retry or a change of computer begins another root for the same request. */
  const rootOf = (threadId: string, request: QuotaRequest): string | undefined => coordinator.all()
    .filter((node) => !node.parentId && node.threadId === threadId && request.generations.has(node.id))
    .sort((a, b) => a.createdAt - b.createdAt).at(-1)?.id;

  /** The backup picks the limited turn up where it was cut off: the conversation and the steps it ran stay its context. */
  const carryOnWith = async (botId: string, threadId: string, limited: QuotaSwitchEngine, name: string, asked: string | undefined): Promise<void> => {
    notice(threadId, `continuing on ${name} after hitting the usage limit`, true);
    try {
      await deps.carryOn!(botId, threadId, resumeNote({ engineName: aiProductName(limited, limited.instanceId), ...(asked ? { request: asked } : {}) }, null, TAKEOVER_CAUSE), asked);
    } catch (error) {
      if (store.taskByThread(botId, threadId)) notice(threadId, `could not continue on ${name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, false);
    }
  };

  /** Moves the thread to `selection` and sends the person's message that hit the limit (or met a signed-out AI) again
   * there; false when that AI cannot take it now. No await from the readiness check to the resend: the gate, the switch
   * and the resend see one state. */
  const continueOn = async (botId: string, threadId: string, selection: ModelSelection, request: QuotaRequest, build: { stale: boolean }, resetsAt?: number,
    scope: TakeoverScope = "engine", acted = false): Promise<boolean> => {
    const engines = deps.registry.instances();
    const engine = engines.find((candidate) => candidate.instanceId === selection.instanceId);
    const before = store.projectBotForTask(botId, threadId);
    const current = before && engines.find((candidate) => candidate.instanceId === before.modelSelection.instanceId);
    if (!engine || !before || !current) return false;
    const ready = engine.instanceId === current.instanceId ? selection : await takeover(engine, before, current);
    const bot = store.projectBotForTask(botId, threadId);
    if (!ready || ready === "timed-out" || !bot || build.stale || !store.taskByThread(botId, threadId)) return false;
    const checked = deps.gate(bot, selection);
    if (!checked.ok) return false;
    try {
      store.switchTaskModel(botId, threadId, checked.selection, false, false, deps.reset?.(bot.modelSelection, checked.selection));
    } catch {
      return false;
    }
    deps.takeover?.moved(botId, threadId, before.modelSelection, checked.selection, resetsAt, scope);
    const name = engine.instanceId === current.instanceId ? `${nameOf(engine)} ${checked.selection.model}` : nameOf(engine);
    const why = scope === "signed-out" ? `while ${nameOf(current)} is signed out`
      : scope === "provider" ? `because ${nameOf(current)} did not answer` : "after hitting the usage limit";
    const held = heldBy(botId, threadId, rootOf(threadId, request));
    const original = held ? undefined : resendable(store, threadId, request.messageId);
    if (!held && acted && LIMITS.has(scope) && deps.carryOn) {
      await carryOnWith(botId, threadId, current, name, request.origin?.kind === "user" ? request.origin.request : original?.text);
    } else if (held === "card") notice(threadId, `switched to ${name}. Your request waits on a card above and continues on ${name} once you act on it.`, true);
    else if (held === "runtime") notice(threadId, `switched to ${name}. Your request is still under way here and continues on ${name}.`, true);
    else if (held === "busy") notice(threadId, `switched to ${name}. This conversation is working, so your message was not sent again.`, true);
    else if (held === "question") {
      notice(threadId, `switched to ${name}. A teammate's question is waiting for your answer in this conversation, so your message was not sent again. Answer it, then send your message again.`, false);
    } else if (!original) {
      notice(threadId, `switched to ${name}, but your message could not be found to send again. Send it again.`, false);
    } else {
      notice(threadId, `continuing on ${name} ${why}`, true);
      try {
        await deps.resend(botId, threadId, original, original.replyToId ? store.messagesFor(threadId).find((message) => message.id === original.replyToId) : undefined, spokenLineFields(original.via, original.callId));
      } catch (error) {
        if (store.taskByThread(botId, threadId)) notice(threadId, `could not continue on ${name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, false);
      }
    }
    return true;
  };

  /** An engine that quit before it showed or did anything gets the person's message once more, on the same AI, with no
   * card and no line; a second crash of the same message fails as before. */
  const retriedCrash = async (bot: BotRecord, threadId: string, internal: boolean, request: QuotaRequest | undefined,
    stop: { acted?: boolean } | undefined, cause: string | undefined): Promise<boolean> => {
    if (!enabled() || internal || !stop || stop.acted || !request?.messageId || request.stopped || request.origin?.kind !== "user") return false;
    if (failedReplyReason(cause ?? "", {}) !== "cli_exit" || rerun.has(request.messageId)) return false;
    if (heldBy(bot.id, threadId, rootOf(threadId, request)) || openCard(threadId)) return false;
    const original = resendable(store, threadId, request.messageId);
    if (!original) return false;
    rerun.add(request.messageId);
    const failure = turnFailureRow(store.messagesTail(threadId, FAILURE_SCAN).messages, request.messageId);
    if (failure) store.patchMessage(threadId, failure.id, { tool: { ...failure.tool!, resolvedAt: Date.now() } });
    try {
      await deps.resend(bot.id, threadId, original, original.replyToId ? store.messagesFor(threadId).find((message) => message.id === original.replyToId) : undefined, spokenLineFields(original.via, original.callId));
      return true;
    } catch {
      if (failure) store.patchMessage(threadId, failure.id, { tool: failure.tool! });
      return false;
    }
  };

  /** A turn its AI's usage limit refused, or that met its AI signed out: the person's own message carries on with the
   * first AI that can take it, the person hears once for this stretch what carries on meanwhile (a sign-out also in this
   * conversation, where signing in fixes it), and the AI's later turns go there too until the limit resets or it is
   * signed in again (the turn start's own check). */
  const turnFailed = async (bot: BotRecord, event: SettledTurn, internal: boolean): Promise<Message | null> => {
    const { threadId } = event;
    try {
      // Read before any await: the record is this turn's only now.
      const request = deps.request(threadId);
      const stop = deps.turnStops.read?.(threadId, event.turnId);
      const flags = stop?.flags;
      const cause = deps.turnStops.failureCause(event);
      if (await retriedCrash(bot, threadId, internal, request, stop, cause)) return null;
      // A tool call's failure names the tool, never the engine's own limit, whatever its words.
      const scope: TakeoverScope | undefined = signedOutStop(event.stopReason, cause) ? "signed-out"
        : flags?.limit ?? (event.stopReason !== "tool_error" && classifyError({ text: cause ?? "" }).reason === "quota" ? "engine"
        // Only a turn that showed and ran nothing: rerunning it elsewhere can repeat no words and no action.
        : stop && !stop.acted && providerFailure(cause, event.stopReason) && !(request?.messageId && rerun.has(request.messageId)) ? "provider" : undefined);
      if (!scope) return null;
      const thread = store.projectBotForTask(bot.id, threadId) ?? bot;
      const from = thread.modelSelection;
      if (scope === "engine") limited.add(from.instanceId);
      const providerUntil = scope === "provider" ? deps.takeover?.holdProvider?.(from) : undefined;
      // MADANI_QUOTA_SWITCH=0: nothing carries on by itself; the person still hears once that the bot waits.
      const backups = enabled() ? deps.takeover?.backups(bot.id, from, scope, approvalModeFor(thread)) ?? [] : [];
      const resetsAt = scope === "signed-out" ? undefined : scope === "provider" ? providerUntil : flags?.limitResetsAt ?? (RESETS.has(scope) ? limitResetFromWords(cause ?? "") : undefined);
      // A sign-out is told once, first and without a backup's name: what the person must do is sign in again.
      const told = scope === "signed-out" ? deps.takeover?.tell(thread, from, { scope }) : undefined;
      if (told) notice(threadId, told, true, true);
      const tell = (backup?: ModelSelection) => {
        if (scope !== "signed-out") deps.takeover?.tell(thread, from, { ...(resetsAt ? { resetsAt } : {}), scope, ...(backup ? { backup } : {}) });
      };
      // Only the person's own request: never a routine's, a webhook's, a relayed or a guest's.
      const own = !internal && request && !request.stopped && request.origin?.kind === "user"
        && (!request.turnId || !event.turnId || request.turnId === event.turnId);
      const relayed = request?.messageId && store.messagesFor(threadId).find((message) => message.id === request.messageId)?.peerAsk;
      if (!own || !request || relayed || openCard(threadId)) {
        tell(backups[0]);
        return null;
      }
      if (enabled()) {
        const build = { threadId, stale: false };
        building.add(build);
        // the failure card stays down while a backup takes the turn, and comes back only if none could
        const failure = backups.length ? turnFailureRow(store.messagesTail(threadId, FAILURE_SCAN).messages, request.messageId) : undefined;
        if (failure) store.patchMessage(threadId, failure.id, { tool: { ...failure.tool!, resolvedAt: Date.now() } });
        let carried = false;
        try {
          if (scope === "provider" && request.messageId) {
            rerun.add(request.messageId);
            if (rerun.size > 500) rerun.delete(rerun.values().next().value!);
          }
          for (const selection of backups) {
            if (await continueOn(bot.id, threadId, selection, request, build, resetsAt, scope, stop?.acted === true)) {
              carried = true;
              tell(selection);
              return null;
            }
          }
        } finally {
          building.delete(build);
          if (failure && !carried) store.patchMessage(threadId, failure.id, { tool: failure.tool! });
        }
      }
      if (RESETS.has(scope) && store.taskByThread(bot.id, threadId)) {
        const quoted = request.origin?.kind === "user" ? request.origin.request : undefined;
        const free = enabled() && (deps.limitMode?.(bot.id) ?? "wait") === "ask" ? deps.takeover?.freeSelection?.(from, scope, approvalModeFor(thread)) : null;
        if (free && askFirst(threadId, from, free, request, resetsAt)) {
          tell();
          return null;
        }
        if (deps.hold?.({ botId: bot.id, threadId, from, ...(resetsAt ? { resetsAt } : {}), ...(quoted ? { request: quoted } : {}) })) {
          tell();
          return null;
        }
      }
      tell();
      return null;
    } catch (error) {
      console.warn(`quota switch: could not continue ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  /** The bot is set to ask: one card offers the free model now or the wait for the reset. */
  const askFirst = (threadId: string, from: ModelSelection, free: ModelSelection, request: QuotaRequest, resetsAt?: number): boolean => {
    const engines = deps.registry.instances();
    const limited = engines.find((engine) => engine.instanceId === from.instanceId);
    const backup = engines.find((engine) => engine.instanceId === free.instanceId);
    if (!limited || !backup) return false;
    const language = deps.language?.(threadId);
    const rootId = rootOf(threadId, request);
    const limitedName = aiProductName(limited, limited.instanceId), backupName = aiProductName(backup, backup.instanceId);
    store.appendMessage(threadId, { role: "bot", kind: "options", card: {
      title: serverLine(language, "server.limitHold.askTitle", { engine: limitedName }),
      subtitle: serverLine(language, "server.limitHold.askSubtitle", { engine: limitedName, backup: backupName }),
      options: [backupName, serverLine(language, "server.limitHold.askWait")],
      fixedOptions: true,
      requestId: randomUUID(),
      quotaSwitch: { engines: [{ instanceId: backup.instanceId, name: backupName }], ...(request.messageId ? { messageId: request.messageId } : {}),
        ...(rootId ? { rootId } : {}), wait: resetsAt ? { resetsAt } : {} },
    } });
    return true;
  };

  const turnSucceeded = (bot: BotRecord, threadId: string): void => {
    limited.delete(bot.modelSelection.instanceId);
    for (const build of building) if (build.threadId === threadId) build.stale = true;
    try {
      const open = openCard(threadId);
      if (open?.card) store.patchMessage(threadId, open.id, { card: { ...open.card, answered: "unavailable", dismissed: true } });
    } catch (error) {
      console.warn(`quota switch: stale card left open in ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** "question": a teammate's waiting question would take the resend as its answer. "busy": a thread already on the
   * chosen engine never meets the switch gate, and its running turn may be the same message typed again. */
  const heldBy = (botId: string, threadId: string, rootId: string | undefined): "card" | "runtime" | "busy" | "question" | null => {
    const root = rootId ? coordinator.node(rootId) : undefined;
    if (root && !ENDED.has(root.status)) return root.cards?.length ? "card" : "runtime";
    if (deps.busy(botId, threadId)) return "busy";
    const asked = coordinator.all().some((node) => node.parentId !== undefined && node.threadId === threadId
      && node.status === "waiting" && node.question !== undefined && !node.cards?.length);
    return asked ? "question" : null;
  };

  /** True once the thread runs on the engine; only then is the offer spent. */
  const decide = async (botId: string, threadId: string, cardId: string, chosen: QuotaSwitchCardData["engines"][number]): Promise<boolean> => {
    const offer = () => {
      const card = store.messagesFor(threadId).find((message) => message.id === cardId)?.card;
      return card?.quotaSwitch && !card.answered && !card.dismissed ? card : undefined;
    };
    /** Rewrites the card even when unchanged: a client folds it on press and must show it open again. */
    const refuse = (why: string, left: (card: NonNullable<Message["card"]>) => Partial<NonNullable<Message["card"]>> = () => ({})): false => {
      const card = offer();
      if (!card) return false;
      notice(threadId, why, false);
      store.patchMessage(threadId, cardId, { card: { ...card, ...left(card) } });
      return false;
    };
    const closed = () => ({ answered: "unavailable", dismissed: true });
    if (!enabled()) return refuse("continuing with another AI is switched off: nothing switched.", closed);
    const engines = deps.registry.instances();
    const engine = engines.find((candidate) => candidate.instanceId === chosen.instanceId);
    if (!engine) {
      const rest = (offer()?.quotaSwitch!.engines ?? []).filter((other) => other.instanceId !== chosen.instanceId);
      if (!rest.length) return refuse(`${chosen.name} is no longer configured, and the card offered no other AI: nothing switched.`, closed);
      return refuse(`${chosen.name} is no longer configured: nothing switched.`,
        (card) => ({ options: [...rest.map((other) => other.name), NOT_NOW], quotaSwitch: { ...card.quotaSwitch!, engines: rest } }));
    }
    const before = store.projectBotForTask(botId, threadId);
    if (!before) return false;
    const current = engines.find((candidate) => candidate.instanceId === before.modelSelection.instanceId);
    if (!current) return refuse("this conversation's own AI is no longer configured here, so no other AI can be checked against it: nothing switched. Choose a model for this conversation instead.", closed);
    const selection = await takeover(engine, before, current);
    // No await from here to the resend: the gate, the switch and the resend must see one state.
    const card = offer();
    const bot = store.projectBotForTask(botId, threadId);
    if (!card || !bot) return false;
    if (selection === "timed-out") return refuse(`${chosen.name} did not answer in time: nothing switched. Try again in a moment.`);
    if (!selection) return refuse(`${chosen.name} is no longer available: nothing switched.`);
    const already = bot.modelSelection.instanceId === selection.instanceId;
    if (!already) {
      const checked = deps.gate(bot, selection);
      if (!checked.ok) return refuse(`could not switch to ${chosen.name}: ${checked.error}`);
      try {
        store.switchTaskModel(botId, threadId, checked.selection, false, false, deps.reset?.(bot.modelSelection, checked.selection));
      } catch {
        return refuse(`could not switch to ${chosen.name}: the model switch could not be saved.`);
      }
    }
    store.patchMessage(threadId, cardId, { card: { ...card, answered: "answer", answeredText: chosen.name } });
    const now = `${already ? "already on" : "switched to"} ${chosen.name}`;
    const held = heldBy(botId, threadId, card.quotaSwitch!.rootId);
    const original = held ? undefined : resendable(store, threadId, card.quotaSwitch!.messageId);
    if (held === "card") notice(threadId, `${now}. Your request waits on a card above and continues on ${chosen.name} once you act on it.`, true);
    else if (held === "runtime") notice(threadId, `${now}. Your request is still under way here and continues on ${chosen.name}.`, true);
    else if (held === "busy") notice(threadId, `${now}. This conversation is working, so your message was not sent again.`, true);
    else if (held === "question") {
      notice(threadId, `${now}. A teammate's question is waiting for your answer in this conversation, so your message was not sent again: answer it, then send your message again.`, false);
    } else if (card.quotaSwitch!.wait && deps.carryOn) {
      const origin = deps.request(threadId)?.origin;
      await carryOnWith(botId, threadId, current, chosen.name, original?.text ?? (origin?.kind === "user" ? origin.request : undefined));
    } else if (!original) {
      notice(threadId, `${now}, but the message that hit quota could not be found to resend: send it again.`, false);
    } else {
      notice(threadId, `continuing on ${chosen.name} after hitting quota`, true);
      try {
        await deps.resend(botId, threadId, original, original.replyToId ? store.messagesFor(threadId).find((message) => message.id === original.replyToId) : undefined, spokenLineFields(original.via, original.callId));
      } catch (error) {
        if (store.taskByThread(botId, threadId)) {
          notice(threadId, `could not continue on ${chosen.name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, false);
        }
      }
    }
    return true;
  };

  const answer: QuotaSwitch["answer"] = (threadId, requestId, behavior, message) => {
    const cardMessage = store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId);
    const card = cardMessage?.card;
    const offer = card?.quotaSwitch;
    if (!cardMessage || !card || !offer || card.answered || card.dismissed) return null;
    const index = behavior === "answer" && typeof message === "string" ? card.options.indexOf(message) : -1;
    const chosen = index >= 0 ? offer.engines[index] : undefined;
    const bot = store.botByThread(threadId);
    if (offer.wait && index === offer.engines.length && bot) {
      store.patchMessage(threadId, cardMessage.id, { card: { ...card, answered: "answer", answeredText: message as string } });
      const thread = store.projectBotForTask(bot.id, threadId);
      const request = deps.request(threadId);
      const quoted = request?.origin?.kind === "user" ? request.origin.request : undefined;
      const held = thread && deps.hold?.({ botId: bot.id, threadId, from: thread.modelSelection, ...(offer.wait.resetsAt ? { resetsAt: offer.wait.resetsAt } : {}),
        ...(quoted ? { request: quoted } : {}) });
      return Promise.resolve(held ? "answered" : "unavailable");
    }
    if (!chosen || !bot) {
      store.patchMessage(threadId, cardMessage.id, { card: { ...card, answered: "answer", answeredText: NOT_NOW } });
      return Promise.resolve(behavior === "answer" ? "answered" : "rejected");
    }
    let deciding = answering.get(requestId);
    if (!deciding) {
      deciding = decide(bot.id, threadId, cardMessage.id, chosen)
        .then((switched): QuotaAnswer => switched ? "answered" : "unavailable", (error): QuotaAnswer => {
          console.warn(`quota switch: answer for ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
          return "unavailable";
        })
        .finally(() => answering.delete(requestId));
      answering.set(requestId, deciding);
    }
    return deciding;
  };

  return { turnFailed, turnSucceeded, answer };
}
