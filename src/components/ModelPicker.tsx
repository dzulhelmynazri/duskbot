import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, X } from "../icons";
import { api, useStore, currentTaskBot, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import type { ModelVariantOption } from "../../shared/runtime-events";
import { configuredModelInstances, isCustomOnly, modelsAwaitEngine } from "@/lib/engine-rail";
import { isAutoFreeModel, isFreeModel, modelName, notConnectedRows, providerName, simpleModelMenu, unansweredReason, variantSuffix, type NotConnectedRow } from "@/lib/simple-model-menu";
import { modelSelectionForPick, withTypedModels } from "@/lib/model-choices";
export { modelSelectionForPick } from "@/lib/model-choices";
import { pickerPlacement, type PickerPlacement } from "@/lib/picker-placement";
import type { Typeahead } from "@/lib/menu-keys";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { InstanceProviderMark } from "./ProviderIcons";
import { ELEVATED_FLOAT } from "./elevated";
import { needsCli, needsSignIn } from "./EngineSetup";
import { engineReady } from "./EngineLibrary";
import { offersLocalModels, probeLocalModels } from "./local-model-probe";
import { ConfirmDialog } from "./ConfirmDialog";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { SimpleModelMenu, type PickerScope, type SimpleThinking } from "./SimpleModelMenu";
import { aiTiles, type AiTileId } from "./onboarding/funnel";
import { ConnectAiDialog } from "./onboarding/ConnectAi";
import { Toast } from "./ui/Toast";
import { starKey, useStarredModels } from "@/lib/starred-models";
import { noteRecentModels, useRecentModels } from "@/lib/recent-models";
import { friendlyError } from "@/lib/plain-error";
import { modelMenuKey, modelMenuPointerMove } from "./model-menu-keys";
import { effortLevelsFor, offersReasoning, useRefocusAfterPick, variantChoices } from "./model-picker-reasoning";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";

import { t } from "@/lib/i18n";
import { useAiSwitch } from "@/lib/ai-switch";
import { threadsOnOwnModel } from "../../shared/thread-model";
import { ThreadModelsLine } from "./ThreadModelsLine";
import { UsageBars } from "./EngineUsage";
import { Select } from "./Select";
import { answeringModel, backupLine, backupTitle, useThreadBackup } from "@/lib/thread-backup";

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

function modelProvider(instance: InstanceInfo | undefined, model: string): string | undefined {
  return instance?.models.options.find((option) => option.id === model)?.provider;
}

export function effortLabel(level: EffortLevel): string {
  return t(`model.effort.${level}` as Parameters<typeof t>[0]);
}

/**
 * Default (undefined) sends nothing and lets the engine decide; `none` is a level the engine is told to use. Only pi
 * offers both.
 */
export function EffortRow({
  bot,
  threadId,
  updateBotDefault,
  className,
  label,
  compact = false,
}: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label?: ReactNode;
  compact?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (instance?.capabilities?.modelVariants) {
    return <ModelVariantRow bot={bot} threadId={threadId} updateBotDefault={updateBotDefault} className={className} label={label} compact={compact} quiet={compact} />;
  }
  const levels = effortLevelsFor(instance, selection.model);
  if (!levels?.length) return null;

  if (compact) return (
    <label className={cn("flex items-center justify-between gap-3", className)}>
      {label}
      <Select size="sm" variant="quiet" className="max-w-[65%]" aria-label={t("model.effort.label")} value={selection.effort ?? ""}
        onChange={(event) => dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}),
          selection: { ...selection, effort: levels.find((level) => level === event.target.value) } })}>
        <option value="">{t("model.effort.default")}</option>
        {levels.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
      </Select>
    </label>
  );

  return (
    <div className={className}>
      {label}
      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t("model.effort.label")}>
        {[undefined, ...levels].map((level) => (
          <button
            key={level ?? "default"}
            type="button"
            aria-pressed={selection.effort === level}
            title={
              level === undefined
                ? t("model.effort.noLevel")
                : t("model.effort.ask", { level: effortLabel(level) })
            }
            onClick={() => dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}), selection: { ...selection, effort: level } })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              selection.effort === level
                ? "border-accent/60 bg-control text-ink"
                : "border-transparent text-ink-secondary hover:bg-control/60 hover:text-ink",
            )}
          >
            {level === undefined ? t("model.effort.default") : effortLabel(level)}
          </button>
        ))}
      </div>
    </div>
  );
}

const variantLabel = (option: ModelVariantOption, driverKind?: string): string =>
  option.id === "default" && driverKind === "opencodeGo" ? t("model.variant.openCodeDefault") : option.label;

export function ModelVariantRow({ bot, threadId, updateBotDefault, className, label, compact = false, wide = false, quiet = false }: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label?: ReactNode;
  compact?: boolean;
  wide?: boolean;
  quiet?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const choices = variantChoices(state, selection, threadId ?? bot.threadId);
  if (!choices) return null;
  const { instance, reported, options } = choices;
  const missing = selection.variant !== undefined && !options.some((option) => option.id === selection.variant);
  const unavailable = missing && reported !== undefined;
  const current = reported?.currentValue;
  const choose = (variant?: string) => {
    const { effort: _effort, variant: _variant, ...model } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}),
      selection: { ...model, ...(variant !== undefined ? { variant } : {}) } });
  };
  if (compact) return (
    <div className={className}>
      <label className="flex items-center justify-between gap-3">
        {label}
        <Select size="sm" variant={quiet ? "quiet" : "field"} aria-label={t("model.variant.label")} disabled={bot.busy} className={wide ? "flex-1" : "max-w-[65%]"}
          value={selection.variant === undefined ? "unset" : missing ? "missing" : String(options.findIndex((option) => option.id === selection.variant))}
          onChange={(event) => choose(options[Number(event.target.value)]?.id)}>
          <option value="unset">{t("model.variant.session")}</option>
          {missing && <option value="missing" disabled>{selection.variant} ({unavailable ? t("model.variant.unavailable") : t("model.variant.unverified")})</option>}
          {options.map((option, index) => <option key={option.id} value={String(index)}>{variantLabel(option, instance.driverKind)}</option>)}
        </Select>
      </label>
      {missing && <p className={cn("mt-1 text-ink-secondary", quiet ? "text-[12px] leading-4 text-ink-tertiary" : "text-[11px]")}>{unavailable ? t("model.variant.unavailableHelp") : t("model.variant.unverifiedHelp")}</p>}
    </div>
  );
  return (
    <div className={className}>
      {label}
      {(selection.variant === undefined || missing) && (
        <p className="mt-2 text-[12px] text-ink-secondary">
          {unavailable ? t("model.variant.unavailableChoice", { variant: selection.variant ?? "" })
            : missing ? t("model.variant.unverifiedChoice", { variant: selection.variant ?? "" }) : t("model.variant.none")}
          {current !== undefined && ` ${t("model.variant.sessionValue", { variant: variantLabel(options.find((option) => option.id === current) ?? { id: current, label: current }, instance.driverKind) })}`}
        </p>
      )}
      {selection.variant !== undefined && (
        <button type="button" disabled={bot.busy} onClick={() => choose()}
          title={t("model.variant.clearHint")}
          className="mt-2 block text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink disabled:opacity-50">
          {t("model.variant.clear")}
        </button>
      )}
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t("model.variant.label")}>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={bot.busy}
              aria-pressed={selection.variant === option.id}
              title={t("model.variant.use", { variant: variantLabel(option, instance.driverKind) })}
              onClick={() => choose(option.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50",
                selection.variant === option.id ? "border-accent/60 bg-control text-ink" : "border-transparent text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {variantLabel(option, instance.driverKind)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const SIMPLE_POPOVER_WIDTH = 320;
const MENU_ITSELF = ":scope";

export function ModelPicker({
  bot: shown,
  threadId,
  className,
  contained = false,
  label,
  size = "md",
  asRow,
  withThinking = false,
}: {
  bot: Bot;
  threadId?: string;
  className?: string;
  contained?: boolean;
  label?: ReactNode;
  size?: "sm" | "md";
  /** A settings row (label left, model right, a chevron) whose menu the caller presents, in a sheet of its own. */
  asRow?: { className: string; present: (menu: { open: boolean; close: () => void; content: ReactNode }) => ReactNode };
  /** A contained picker whose place has no thinking control of its own: its menu sets the level too. */
  withThinking?: boolean;
}) {
  const ownThinking = !contained || withThinking;
  const { state, dispatch: storeDispatch, refreshInstances, refreshModels: refreshInstanceModels } = useStore();
  const [open, setOpen] = useState(false);
  const { bot, dispatch } = useAiSwitch({ bot: shown, threadId, contained, dispatch: storeDispatch, setOpen: (next) => (next ? openMenu() : setOpen(false)) });
  const motion = useMenuMotion(open);
  // a pick while the reply streams lands for the next message; the running turn keeps the model it started on
  const working = Boolean(bot.busy);
  const [query, setQuery] = useState("");
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [probing, setProbing] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const ownerOrAdmin = useOwnerOrAdmin();
  // A guest changes only their own conversation's model, never the shared bot's default; thread-only until authority loads.
  const mayChangeBot = ownerOrAdmin === true;
  const [scope, setScope] = useState<PickerScope>("bot");
  // the owner's pick is the bot's model; a guest's stays in their own conversation
  const updatesBotDefault = !threadId || mayChangeBot;
  const [pendingSwitch, setPendingSwitch] = useState<{ botId: string; threadId: string;
    selection: ModelSelection; updateBotDefault: boolean; name: string; toast?: string;
    /** every bot at once: the pick, applied to each when confirmed */
    all?: { instance: InstanceInfo; model: string; variant?: string } } | null>(null);
  const [handoff, setHandoff] = useState<{ tile: AiTileId; scope: PickerScope } | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "done" | "error" } | null>(null);
  const [disconnecting, setDisconnecting] = useState<{ instance: InstanceInfo; provider: string; busy?: boolean } | null>(null);
  const [placement, setPlacement] = useState<PickerPlacement | null>(null);
  const [changedBotModel, setChangedBotModel] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const refreshingRef = useRef(false);
  const focusOnPlace = useRef<string | null>(null);
  const typed = useRef<Typeahead | null>(null);
  const menuId = useId();
  const inside = useRef({ contains: (target: unknown) => [rootRef.current, menuRef.current].some((node) => node?.contains(target as Node)) });

  const floating = typeof document !== "undefined";
  useLayoutEffect(() => {
    if (!open || asRow) return;
    const place = (event?: Event) => {
      if (event?.type === "scroll" && event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      const anchor = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setPlacement((locked) => pickerPlacement(anchor, { width: SIMPLE_POPOVER_WIDTH, height: menu.offsetHeight }, viewport, locked ?? undefined));
    };
    const settled = (event: Event) => {
      if (event.target instanceof Node && triggerRef.current && event.target.contains(triggerRef.current)) place();
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("animationend", settled, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("animationend", settled, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !placement || focusOnPlace.current === null) return;
    const menu = menuRef.current;
    const wanted = focusOnPlace.current;
    focusOnPlace.current = null;
    const find = (selector: string) => (selector ? menu?.querySelector<HTMLElement>(selector) : null);
    const target = wanted === MENU_ITSELF ? menu
      : find(wanted) ?? find("[data-menu-search]") ?? find("[data-current-model]:not(:disabled)") ?? find("[data-menu-row]:not(:disabled)") ?? menu;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [open, placement]);

  const selection = bot.modelSelection;
  const refocusAfterPick = useRefocusAfterPick(menuRef, open, selection, query);
  const instances = withTypedModels(state.instances, selection, query);
  const active = instances.find((instance) => instance.instanceId === selection.instanceId);
  const pickerInstances = configuredModelInstances(instances, selection.instanceId);
  const selectedVariantLabel = selection.variant === undefined ? undefined : variantLabel(
    active?.models.options.find((option) => option.id === selection.model)?.variants?.find((option) => option.id === selection.variant)
      ?? { id: selection.variant, label: selection.variant },
    active?.driverKind,
  );

  const refreshLocalInstances = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setLoadingInstances(true);
    void refreshInstances({ cached: true })
      .catch(() => {})
      .finally(() => {
        refreshingRef.current = false;
        setLoadingInstances(false);
      });
  }, [refreshInstances]);

  const refreshModels = (instanceId: string | undefined) => {
    if (refreshingRef.current || !instanceId) return;
    refreshingRef.current = true;
    setRefreshingId(instanceId);
    void refreshInstances()
      .then(() => refreshInstanceModels(instanceId))
      .catch(() => {})
      .finally(() => {
        refreshingRef.current = false;
        setRefreshingId(null);
      });
  };

  // An engine with no models listed yet, or only a list it never confirmed, is asked for them, then they are shown.
  useEffect(() => {
    if (!open) return;
    const listsModels = Boolean(active?.snapshot.chatgptPlan || active?.models.options.some((option) => !option.custom)) || isCustomOnly(active);
    if (listsModels && !modelsAwaitEngine(active)) refreshLocalInstances();
    else refreshModels(active?.instanceId);
  }, [open, refreshLocalInstances]);

  usePopoverDismiss(open && !asRow, inside, () => close(false));

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }

  const lookForLocal = (instance: InstanceInfo) => {
    if (needsCli(instance) || instance.policy || probing.has(instance.instanceId)) return;
    setProbing((current) => new Set(current).add(instance.instanceId));
    void probeLocalModels(instance.instanceId, refreshInstanceModels).then(() => setProbing((current) => {
      const next = new Set(current);
      next.delete(instance.instanceId);
      return next;
    }));
  };
  const lookForLocalIn = (instance: InstanceInfo) => {
    if (offersLocalModels(instance, instance.models.options.filter((option) => option.custom).length)) lookForLocal(instance);
  };

  const remote = window.madaniDesktop?.remoteClient?.active === true;
  /** Settings > Models, at its directory: every provider, API keys and local models. */
  const openDirectory = () => {
    close(false);
    dispatch({ type: "toggleAppSettings", open: true, section: "engines" });
    if (typeof document === "undefined") return;
    let tries = 0;
    const focusSearch = () => {
      const search = document.querySelector<HTMLInputElement>("[data-model-directory-search]");
      if (search) {
        search.scrollIntoView?.({ block: "center" });
        search.focus({ preventScroll: true });
      } else if (++tries < 30) setTimeout(focusSearch, 50);
    };
    setTimeout(focusSearch, 50);
  };

  function openMenu() {
    setChangedBotModel(false);
    setExpanded(new Set());
    setPlacement(null);
    setQuery("");
    setScope("bot");
    focusOnPlace.current = "";
    setOpen(true);
  }

  const profile = state.bots.find((candidate) => candidate.id === bot.id) ?? bot;
  const follows = threadId ? profile.tasks?.find((task) => task.threadId === threadId)?.followsBotModel : undefined;
  const backup = useThreadBackup(profile, threadId);
  const answering = threadId ? answeringModel(profile, threadId, selection) : selection;
  const shownInstance = instances.find((instance) => instance.instanceId === answering.instanceId);
  const unanswered = unansweredReason(instances, answering);
  const botModelInstance = state.instances.find((instance) => instance.instanceId === profile.modelSelection.instanceId);
  const botModelName = modelName(botModelInstance, profile.modelSelection.model, profile.modelSelection.variant);
  const botModelTitle = !botModelInstance ? profile.modelSelection.model : isAutoFreeModel(botModelInstance, profile.modelSelection.model) ? t("model.free.hint")
    : `${botModelInstance.displayName} · ${modelLabel(botModelInstance, profile.modelSelection.model)}${variantSuffix(botModelInstance, profile.modelSelection.model, profile.modelSelection.variant)}`;
  const ownModelThreads = threadsOnOwnModel(profile.modelSelection, profile.tasks ?? []).length;

  const pickBotModel = () => {
    if (follows !== false) {
      close(true);
      return;
    }
    const target = currentTaskBot(profile, threadId ?? bot.threadId);
    if (modelSwitchNeedsAsk(approvalModeFor(target),
      state.instances.find((candidate) => candidate.instanceId === target.modelSelection.instanceId)?.driverKind,
      botModelInstance?.driverKind)) {
      close(false);
      if (working) return setToast({ text: t("model.picker.stopFirst", { model: botModelName }), tone: "error" });
      setPendingSwitch({ botId: bot.id, threadId: threadId ?? bot.threadId, selection: profile.modelSelection, updateBotDefault: false, name: botModelName });
      return;
    }
    close(true);
    dispatch({ type: "setModel", botId: bot.id, threadId: threadId ?? bot.threadId, updateBotDefault: false, selection: profile.modelSelection, ...(working ? { nextTurn: true } : {}) });
    if (working) setToast({ text: t("model.picker.nextMessage", { model: botModelName }), tone: "done" });
  };

  const driverOf = (instanceId: string) => state.instances.find((candidate) => candidate.instanceId === instanceId)?.driverKind;
  const asksFor = (target: Bot, instance: InstanceInfo) =>
    modelSwitchNeedsAsk(approvalModeFor(target), driverOf(target.modelSelection.instanceId), instance.driverKind);

  /** Every bot on the pick, and new bots too; a bot with its own different model changes as well, since that's the ask. */
  const applyAll = (instance: InstanceInfo, model: string, variant: string | undefined, confirmed: boolean): "applied" | "asked" => {
    const bots = state.bots.length > 0 ? state.bots : [profile];
    const plan = bots.map((one) => {
      const thread = one.id === bot.id ? threadId ?? bot.threadId : one.threadId;
      const next = modelSelectionForPick(one.modelSelection, instance, model);
      if (variant !== undefined) next.variant = variant;
      return { one, thread, next, ask: asksFor(currentTaskBot(one, thread), instance) || asksFor(one, instance) };
    });
    const name = modelName(instance, model, variant);
    const text = bots.length === 1 ? t("model.picker.allNowUseOne", { model: name }) : t("model.picker.allNowUse", { count: bots.length, model: name });
    if (!confirmed && plan.some((step) => step.ask)) {
      if (plan.some((step) => step.ask && step.one.busy)) {
        setToast({ text: t("model.picker.stopFirst", { model: name }), tone: "error" });
        return "asked";
      }
      setPendingSwitch({ botId: bot.id, threadId: threadId ?? bot.threadId, selection: plan[0]!.next, updateBotDefault: true, name, toast: text,
        all: { instance, model, ...(variant !== undefined ? { variant } : {}) } });
      return "asked";
    }
    for (const { one, thread, next, ask } of plan) {
      (one.id === bot.id ? dispatch : storeDispatch)({ type: "setModel", botId: one.id, threadId: thread, updateBotDefault: true, selection: next,
        ...(ask ? { resetApprovalToAsk: true } : {}), ...(one.busy ? { nextTurn: true } : {}) });
    }
    const fresh: ModelSelection = { instanceId: instance.instanceId, model, ...(variant !== undefined ? { variant } : {}) };
    void api("/api/config", { method: "PATCH", body: JSON.stringify({ defaultModelSelection: fresh }) })
      .then(() => setToast({ text, tone: "done" }), () => setToast({ text: t("model.picker.allFailed"), tone: "error" }));
    return "applied";
  };

  /** Puts the pick where the scope says: this bot (or a guest's own conversation), or every bot. */
  const commit = (instance: InstanceInfo, model: string, variant: string | undefined, to: PickerScope, toastText?: string): "applied" | "asked" => {
    if (to === "all" && mayChangeBot) return applyAll(instance, model, variant, false);
    const nextSelection = modelSelectionForPick(selection, instance, model);
    if (variant !== undefined) nextSelection.variant = variant;
    const updateBotDefault = updatesBotDefault;
    const targets = [currentTaskBot(profile, threadId ?? bot.threadId), ...(updateBotDefault ? [profile] : [])];
    if (targets.some((target) => asksFor(target, instance))) {
      // a switch that resets approvals waits for the reply to end
      if (working) {
        setToast({ text: t("model.picker.stopFirst", { model: modelName(instance, model) }), tone: "error" });
        return "asked";
      }
      setPendingSwitch({ botId: bot.id, threadId: threadId ?? bot.threadId,
        selection: nextSelection, updateBotDefault, name: modelName(instance, model), ...(toastText ? { toast: toastText } : {}) });
      return "asked";
    }
    dispatch({ type: "setModel", botId: bot.id, threadId: threadId ?? bot.threadId, updateBotDefault, selection: nextSelection, ...(working ? { nextTurn: true } : {}) });
    if (updateBotDefault && threadId) setChangedBotModel(true);
    if (toastText) setToast({ text: toastText, tone: "done" });
    else if (working) setToast({ text: t("model.picker.nextMessage", { model: modelName(instance, model, variant) }), tone: "done" });
    return "applied";
  };

  const pick = (instance: InstanceInfo, model: string, variant?: string) => {
    if (instance.policy) return;
    const to = mayChangeBot ? scope : "bot";
    const was = selection.instanceId ? [starKey(selection.instanceId, selection.model, selection.variant)] : [];
    if (commit(instance, model, variant, to) === "asked") return close(false);
    noteRecentModels(...was, starKey(instance.instanceId, model, variant));
    const nextSelection = modelSelectionForPick(selection, instance, model);
    // A model with reasoning levels keeps the menu open, so its level can be set next without opening it again;
    // picking a variant row already sets that level.
    if (to === "all" || variant !== undefined || !ownThinking || !offersReasoning(state, instance, nextSelection, threadId ?? bot.threadId)) close(true);
    else refocusAfterPick();
  };

  /** A Not connected row: Connect an AI opens on that provider with its connect started; one with no card there goes to
   * the model directory. */
  const connect = (row: NotConnectedRow) => {
    if (!row.tile) return openDirectory();
    close(false);
    setHandoff({ tile: row.tile, scope });
  };
  /** The handed-over connect finished: its suggested model becomes this bot's (or every bot's), with a short toast. A bot
   * that is replying keeps its AI: a sign-in is not a pick, so the reply and its queued follow-ups stay where they were
   * and the person picks the new AI from the menu when they want it. */
  const connected = (tileId: AiTileId) => {
    const to = handoff?.scope ?? "bot";
    setHandoff(null);
    const tile = aiTiles(state.instances, engineReady).find((one) => one.id === tileId);
    const instance = tile?.candidates.find(engineReady);
    if (!tile || !instance) return;
    if (working) return setToast({ text: t("model.picker.connectedName", { name: tile.label }), tone: "done" });
    const options = instance.models.options;
    const model = (options.find((option) => option.id === instance.models.default) ?? options.find((option) => !option.custom) ?? options[0])?.id;
    if (!model) return setToast({ text: t("model.picker.connectedName", { name: tile.label }), tone: "done" });
    commit(instance, model, undefined, mayChangeBot ? to : "bot", t("model.picker.nowUses", { name: profile.name, model: modelName(instance, model) }));
  };

  const resetVariant = contained && selection.variant !== undefined ? () => {
    const { variant: _variant, ...nextSelection } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId: threadId ?? bot.threadId, updateBotDefault: updatesBotDefault, selection: nextSelection });
    close(true);
  } : undefined;

  const levels = effortLevelsFor(active, selection.model) ?? [];
  const writeEffort = (effort: EffortLevel | undefined) => {
    const { effort: _effort, ...model } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId, ...(threadId && updatesBotDefault ? { updateBotDefault: true } : {}),
      selection: effort ? { ...model, effort } : model, ...(working && threadId ? { nextTurn: true } : {}) });
  };
  const thinking: SimpleThinking | null = !ownThinking ? null
    : variantChoices(state, selection, threadId ?? bot.threadId) ? {
      variants: (
        <ModelVariantRow compact quiet bot={shown} threadId={threadId} updateBotDefault={Boolean(threadId) && updatesBotDefault} className="px-2 py-1"
          label={<span className="shrink-0 text-[12px] font-medium leading-4 text-ink-tertiary">{t("botSettings.simple.thinking")}</span>} />
      ),
    }
    // mid-reply a level lands for the next message; under Switch AI the turn is about to stop, so none is offered
    : levels.length > 0 && (!shown.busy || (working && threadId)) ? { levels, current: selection.effort, onPick: writeEffort, onReset: () => writeEffort(undefined) }
    : null;

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented || !(event.target instanceof HTMLElement)) return;
    if (event.key !== "Escape") return modelMenuKey(event, { query, typed, close: () => close(true) });
    event.preventDefault();
    event.stopPropagation();
    if (query) {
      setQuery("");
      refocusAfterPick();
    } else close(true);
  };

  const currentOption = active?.models.options.find((option) => option.id === selection.model);
  const attention = !active ? undefined
    : active.policy ? t("policy.managedBy", { organization: active.policy.organizationName })
      : needsCli(active) ? t("model.setupRequired")
        : needsSignIn(active) && !isCustomOnly(active) && !currentOption?.custom ? t("model.signInRequired") : currentOption?.orgBlocked ? t("model.orgBlocked") : undefined;
  const summary = active
    ? `${isAutoFreeModel(active, selection.model) ? modelName(active, selection.model)
      : `${active.displayName} · ${isFreeModel(active) ? modelName(active, selection.model) : modelLabel(active, selection.model)}`}${
        modelProvider(active, selection.model) ? ` · ${modelProvider(active, selection.model)}` : ""
      }${selectedVariantLabel ? ` · ${selectedVariantLabel}` : selection.effort && levels.includes(selection.effort)
        ? ` · ${t("model.simple.thinkingSummary", { level: effortLabel(selection.effort) })}` : ""}`
    : selection.model;
  const followLine = follows === true ? `\n${t("model.followsBot", { name: profile.name })}` : follows === false ? `\n${t("model.ownModel")}` : "";
  const attentionLine = attention ? `\n${attention}` : "";
  const busyLine = working ? `\n${t("model.picker.nextMessageHint")}` : "";

  const triggerProps = {
    ref: triggerRef,
    "data-tour": "model",
    type: "button" as const,
    onClick: () => (open ? close(false) : openMenu()),
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        close(false);
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
        event.preventDefault();
        openMenu();
      }
    },
    "aria-expanded": open,
    "aria-haspopup": "dialog" as const,
    "aria-controls": open ? menuId : undefined,
    title: backup ? `${backupTitle(backup, modelName(shownInstance, answering.model))}${busyLine}` : `${summary}${followLine}${attentionLine}${busyLine}`,
  };

  const trigger = (
    <button
      {...triggerProps}
      className={cn(
        "group flex items-center rounded-full text-[13px] leading-[18px] text-ink-secondary inset-ring inset-ring-ink/[0.07] disabled:cursor-not-allowed disabled:text-ink-tertiary",
        contained
          ? "min-w-0 max-w-[58%]"
          : cn("shrink-0", ELEVATED_FLOAT, "aria-expanded:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_7%)] aria-expanded:text-ink"),
        size === "sm" ? "h-8 pl-2.5 pr-2" : "h-8 pl-2.5 pr-2",
      )}
    >
      <span className="relative mr-1.5 flex shrink-0 group-disabled:opacity-50">
        {shownInstance
          ? <InstanceProviderMark instance={shownInstance} size={14} subtle />
          : <span className="size-3.5 rounded-full bg-ink/[0.08]" aria-hidden="true" />}
        {attention && !backup && <span data-model-attention className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-warning ring-[1.5px] ring-app" />}
      </span>
      <span className="min-w-0 max-w-[160px] truncate">{unanswered ?? modelName(shownInstance, answering.model)}</span>
      {!unanswered && answering.variant !== undefined && <span className="shrink-0 whitespace-pre">{variantSuffix(shownInstance, answering.model, answering.variant)}</span>}
      {backup && !contained && <span data-model-backup="" className="ms-1.5 shrink-0 text-ink-tertiary">{t("model.backup.chip")}</span>}
      <UsageBars engine={answering.instanceId} className="ml-1.5" />
      <ChevronDown size={12} strokeWidth={2} aria-hidden="true" className="ml-1 shrink-0 text-ink-tertiary" />
    </button>
  );

  const { starred, toggle: toggleStarred } = useStarredModels();
  const recent = useRecentModels();
  const simpleMenu = simpleModelMenu({
    instances,
    listed: pickerInstances,
    selection,
    bot: { name: profile.name, selection: profile.modelSelection, follows },
    query,
    expanded,
    probing,
    loading: loadingInstances,
    refreshing: refreshingId,
    starred,
    recent,
  });

  // only the owner connects a provider; the rows stay out of a search, which looks through the models there are
  const connectRows = mayChangeBot && !simpleMenu.query ? notConnectedRows(state.instances, simpleMenu.connect) : [];
  const connectInstance = (instance: InstanceInfo) => {
    if (!mayChangeBot) return;
    const [row] = notConnectedRows(state.instances, [{ instance, label: providerName(instance), provider: providerName(instance),
      body: needsCli(instance) ? { kind: "setUp" } : { kind: "signIn" } }]);
    if (row?.tile) connect(row);
    else if (!remote) openDirectory();
  };

  const menuBody = (
    <SimpleModelMenu
      menu={simpleMenu}
      query={query}
      bot={profile}
      botModel={{ label: botModelName, title: botModelTitle }}
      thinking={thinking}
      idPrefix={menuId}
      onQuery={setQuery}
      onPick={pick}
      onPickCurrent={() => close(true)}
      onToggleStar={toggleStarred}
      onFollowBot={pickBotModel}
      onToggle={(instance) => {
        const opening = !expanded.has(instance.instanceId);
        setExpanded((current) => {
          const next = new Set(current);
          if (opening) next.add(instance.instanceId);
          else next.delete(instance.instanceId);
          return next;
        });
        if (opening) lookForLocalIn(instance);
      }}
      onSetUp={connectInstance}
      onCheckAgain={(instance) => refreshModels(instance.instanceId)}
      onMore={mayChangeBot && !remote ? openDirectory : undefined}
      onResetVariant={resetVariant}
      onDisconnect={mayChangeBot ? (instance, provider) => { close(false); setDisconnecting({ instance, provider }); } : undefined}
      scope={mayChangeBot ? { value: scope, onChange: setScope } : undefined}
      where={state.config?.cloudHome ? t("model.picker.onCloud") : undefined}
      notConnected={connectRows.length > 0 ? { rows: connectRows, onConnect: connect } : undefined}
    />
  );

  const menu = !asRow && motion.shown && (
    <div
      ref={menuRef}
      id={menuId}
      data-model-picker-content
      role="dialog"
      aria-label={t("model.choose")}
      aria-modal="false"
      tabIndex={-1}
      {...motion.exitProps}
      onKeyDown={onMenuKey}
      onPointerMove={modelMenuPointerMove}
      style={floating ? {
        position: "fixed",
        left: placement?.left ?? 0,
        top: placement?.top,
        bottom: placement?.bottom,
        width: placement?.width ?? SIMPLE_POPOVER_WIDTH,
        maxHeight: placement?.maxHeight,
        transformOrigin: placement?.origin,
        visibility: placement ? undefined : "hidden",
      } : { width: SIMPLE_POPOVER_WIDTH }}
      className={cn("menu-surface z-[80] flex flex-col overflow-hidden", motion.className)}
    >
      {menuBody}
    </div>
  );

  const sheetMenu = asRow?.present({
    open,
    close: () => close(false),
    content: (
      <div ref={menuRef} id={menuId} data-model-picker-content="" data-presented="" onKeyDown={onMenuKey} className="flex flex-col">
        {menuBody}
      </div>
    ),
  });

  const rowTrigger = asRow && (
    <button {...triggerProps} className={asRow.className}>
      <span className="min-w-0 flex-1">
        {label}
        {backup && <span data-model-backup="" className="mt-0.5 block text-[13px] leading-[18px] text-ink-secondary">{backupLine(backup)}</span>}
      </span>
      <span className="flex min-w-0 max-w-[55%] shrink-0 items-center gap-1.5 text-[15px] text-ink-secondary">
        {attention && !backup && <span data-model-attention className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />}
        <span className="min-w-0 truncate">{unanswered ?? modelName(shownInstance, answering.model)}</span>
        {!unanswered && answering.variant !== undefined && <span className="shrink-0 whitespace-pre">{variantSuffix(shownInstance, answering.model, answering.variant)}</span>}
      </span>
      <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-ink-tertiary" />
    </button>
  );

  return (
    <div ref={rootRef} className={cn(contained ? "w-full" : "relative", className)}>
      {rowTrigger ? rowTrigger : contained ? (
        <div className="flex items-center justify-between gap-4">
          {backup ? (
            <span className="flex shrink-0 flex-col">
              {label}
              <span data-model-backup="" className="whitespace-nowrap text-[12px] leading-4 text-ink-secondary">{backupLine(backup)}</span>
            </span>
          ) : label}
          {trigger}
        </div>
      ) : (
        trigger
      )}
      {menu && floating ? createPortal(menu, document.body) : menu}
      {sheetMenu}
      {handoff && <ConnectAiDialog tested={null} start={handoff.tile} onClose={() => setHandoff(null)} onConnected={connected} />}
      {toast && <Toast text={toast.text} tone={toast.tone} onDone={() => setToast(null)} data-notice-toast="model" />}
      {!contained && changedBotModel && !open && ownModelThreads > 0 && (
        <div data-thread-models-notice role="status"
          className="menu-surface absolute right-0 top-full z-30 mt-1 flex w-max max-w-[min(300px,calc(100vw-2rem))] items-center gap-2 py-1.5 pl-3 pr-1.5 text-[13px] leading-[18px]">
          <ThreadModelsLine bot={profile} />
          <button type="button" aria-label={t("common.close")} onClick={() => setChangedBotModel(false)}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <ConfirmDialog
        open={disconnecting !== null}
        title={t("engines.disconnectTitle", { name: disconnecting?.provider ?? "" })}
        body={t("engines.disconnectBody", { name: disconnecting?.provider ?? "" })}
        tone="neutral"
        confirmLabel={t("engines.disconnect")}
        pending={disconnecting?.busy}
        onCancel={() => { if (!disconnecting?.busy) setDisconnecting(null); }}
        onConfirm={() => {
          if (!disconnecting || disconnecting.busy) return;
          const { instance, provider } = disconnecting;
          setDisconnecting({ ...disconnecting, busy: true });
          void api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "PATCH", body: JSON.stringify({ hidden: true }) })
            .then(() => {
              setToast({ text: t("model.picker.disconnected", { name: provider }), tone: "done" });
              return refreshInstances().catch(() => {});
            }, (cause: unknown) => setToast({ text: friendlyError(cause), tone: "error" }))
            .finally(() => setDisconnecting(null));
        }}
      />
      <ConfirmDialog
        open={pendingSwitch !== null}
        title={t("model.providerSwitch.title")}
        body={t(pendingSwitch?.updateBotDefault ? "confirm.modelSwitchBot" : "confirm.modelSwitchThread")}
        tone="neutral"
        confirmLabel={t("model.providerSwitch.confirm")}
        onCancel={() => setPendingSwitch(null)}
        onConfirm={() => {
          if (!pendingSwitch || bot.busy || pendingSwitch.botId !== bot.id || pendingSwitch.threadId !== (threadId ?? bot.threadId)) {
            setPendingSwitch(null); return;
          }
          if (pendingSwitch.all) {
            applyAll(pendingSwitch.all.instance, pendingSwitch.all.model, pendingSwitch.all.variant, true);
            setPendingSwitch(null);
            return;
          }
          if (pendingSwitch.toast) setToast({ text: pendingSwitch.toast, tone: "done" });
          dispatch({ type: "setModel", botId: pendingSwitch.botId, threadId: pendingSwitch.threadId,
            selection: pendingSwitch.selection, updateBotDefault: pendingSwitch.updateBotDefault,
            resetApprovalToAsk: true });
          if (pendingSwitch.updateBotDefault && threadId) setChangedBotModel(true);
          setPendingSwitch(null);
        }}
      />
    </div>
  );
}
