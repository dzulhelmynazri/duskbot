import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { createPortal } from "react-dom";
import { Check, Copy } from "../../icons";

import { automationSentence, automationsFrom, automationStatus, AUTOMATION_FIX_LABEL, nextWhen, plainWhen, runLine, type Automation, type AutomationFix } from "@/lib/automations";
import { appWhen } from "@/lib/app-automations";
import { useAppTriggers } from "@/lib/app-triggers";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { lowerFirst, upperFirst } from "@/lib/lower-first";
import { routineRunsOn } from "@/lib/routine-display";
import { fetchForecast, forecastLine, pauseLine, useLoaded } from "@/lib/spend";
import { formatCost } from "@/lib/usage-trace";
import { isRoutineProblemRun, type Routine, type RoutineRunOn } from "@/lib/routines";
import { hoursLine, liveStrip, probeLine } from "@/lib/routine-display";
import { saveWebhookCredential, webhookCredentialStore } from "@/lib/webhook-credentials";
import { useStore, type Bot } from "@/state/store";
import { useAllAutomationActions } from "../automations/app-actions";
import { AppEventEditor } from "../automations/AppEventEditor";
import { WebhookEditor } from "../WebhookTrigger";
import { BotSwitch, buttonCls, Card, PanelEmpty, rowCls, RowText } from "../bot-panel/rows";
import { RoutineForm } from "./RoutineForm";
import { RunStrip } from "./RunStrip";
import { SpendCap } from "../usage/SpendCap";
import { GrokDialog } from "../ui/GrokDialog";

const termCls = "text-[12px] leading-4 tracking-[0.01em] text-ink-secondary";
const valueCls = "mt-0.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink";
const RECENT_RUNS = 3;
/** The last routinesFocus a list acted on: the panel mounts its list after the request, and acts on each one once. */
let handledFocus = 0;

/** When it runs, in plain words: its schedule, the app event it waits for, or another app calling it. */
function whenLine(automation: Automation): string {
  if (automation.schedule) return plainWhen(automation.schedule);
  return automation.appTrigger ? appWhen(automation.appTrigger) : t("automations.newBox.whenApp");
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return <div><dt className={termCls}>{upperFirst(term)}</dt><dd className={cn(valueCls, "m-0 break-words")}>{children}</dd></div>;
}

/** A bot's routines and app automations as Grok's Details tab lists them: a short row with the name and when (or Paused)
 * and its switch. Clicking one opens a small sheet with what the bot knows about it and the run, test, edit and delete
 * actions; the list itself never grows. "Add a routine" opens the same small form at the end of the card. */
export function BotRoutines({ bot, defaultRunOn, label = true }: { bot: Bot; defaultRunOn?: RoutineRunOn; label?: boolean }) {
  const { state } = useStore();
  const appTriggers = useAppTriggers();
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const remote = typeof window !== "undefined" && window.madaniDesktop?.remoteClient?.active === true;
  const automations = useMemo(() => automationsFrom({
    routines: state.routines.filter((routine) => routine.botId === bot.id).sort((a, b) => a.createdAt - b.createdAt),
    webhooks: remote ? [] : state.webhooks.filter((webhook) => webhook.botId === bot.id),
    appTriggers: appTriggers.triggers.filter((trigger) => trigger.botId === bot.id),
    runs: state.routineRuns,
  }), [state.routines, state.webhooks, appTriggers.triggers, state.routineRuns, bot.id, remote]);

  // a chat card, a notice or a run's chat names a routine: open it here, or straight into its form
  const focus = state.routinesFocus;
  useEffect(() => {
    if (focus.nonce <= handledFocus || !focus.routineId) return;
    if (!automations.some((automation) => automation.id === focus.routineId)) return;
    handledFocus = focus.nonce;
    setOpenId(focus.routineId);
    setEditing(focus.edit ? focus.routineId : null);
    requestAnimationFrame(() => document.querySelector(`[data-panel-routine="${CSS.escape(focus.routineId!)}"]`)?.scrollIntoView({ block: "nearest" }));
  }, [focus, automations]);

  const add = editing === "new"
    ? <RoutineForm bot={bot} defaultRunOn={defaultRunOn} onDone={(saved) => { setEditing(null); if (saved) setOpenId(saved.id); }} />
    : null;

  if (automations.length === 0 && editing !== "new") {
    return (
      <PanelEmpty data-panel-empty="routines">{t("botPanel.routines.empty")}</PanelEmpty>
    );
  }
  return (
    <Card label={label ? t("botPanel.ui.botSettingsSimpleRoutines") : undefined} anchor="routines">
      {automations.map((automation) => (
        <AutomationRow
          key={automation.id}
          bot={bot}
          automation={automation}
          routine={automation.kind === "schedule" ? state.routines.find((routine) => routine.id === automation.id) : undefined}
          open={openId === automation.id}
          editing={editing === automation.id}
          onOpen={() => { setOpenId(automation.id); setEditing(null); }}
          onClose={() => { setOpenId(null); setEditing(null); }}
          onEdit={(on) => setEditing(on ? automation.id : null)}
        />
      ))}
      {add}
    </Card>
  );
}

function AutomationRow({ bot, automation, routine, open, editing, onOpen, onClose, onEdit }: {
  bot: Bot;
  automation: Automation;
  routine?: Routine;
  open: boolean;
  editing: boolean;
  onOpen: () => void;
  onClose: () => void;
  onEdit: (on: boolean) => void;
}) {
  const { dispatch } = useStore();
  const actions = useAllAutomationActions();
  const status = automationStatus(automation);
  const done = status.state === "done";
  const when = whenLine(automation);
  // the panel reads in sentence case; the routine words are shared lowercase fragments, so the row's line takes the capital
  const hint = upperFirst(status.state === "needs-you" ? t("automations.needsYou", { reason: status.reason ?? "" }) : automation.enabled || done ? when : t("automations.status.paused"));
  const detailId = `routine-detail-${automation.id}`;
  const name = automation.name.trim() || automationSentence(automation, bot.name);

  // opening one marks its failed runs seen, which clears the dot on the sidebar row
  useEffect(() => {
    if (!open) return;
    for (const run of automation.runs) if (isRoutineProblemRun(run) && !run.seenAt) dispatch({ type: "markRoutineRunSeen", runId: run.id });
  }, [open, automation.runs, dispatch]);

  return (
    <div data-panel-routine={automation.id} data-routine-open={open || undefined} className="rounded-lg">
      <div className={cn(rowCls, "relative transition-colors duration-100 hover:bg-ink/[0.035]")}>
        <button
          type="button"
          onClick={onOpen}
          aria-haspopup="dialog"
          aria-label={`${name}, ${hint}`}
          className="min-w-0 flex-1 text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
        >
          <RowText
            title={<span className="block truncate">{name}</span>}
            hint={<span className={cn("block truncate", status.state === "needs-you" && "text-warning")}>{hint}</span>}
          />
        </button>
        {!done && (
          <BotSwitch
            color={bot.color}
            checked={automation.enabled}
            aria-label={t(automation.enabled ? "botPanel.routine.pause" : "botPanel.routine.resume", { name, schedule: lowerFirst(when) })}
            disabled={actions.busy === `toggle:${automation.id}`}
            onClick={() => void actions.toggle(automation)}
            className="relative z-[1]"
          />
        )}
      </div>
      {!open && actions.error && <p role="alert" className="m-0 px-2 pb-1.5 text-[12px] leading-4 text-danger">{actions.error}</p>}
      <AnimatePresence>{open && !(editing && automation.kind !== "schedule") && (
        <GrokDialog key="routine" data-panel-modal="routine" title={name} onClose={onClose}>
          {editing && routine
            ? <RoutineForm bot={bot} routine={routine} onDone={() => onEdit(false)} />
            : <AutomationDetail id={detailId} bot={bot} automation={automation} routine={routine} actions={actions} onEdit={() => onEdit(true)} />}
        </GrokDialog>
      )}</AnimatePresence>
      {editing && automation.kind !== "schedule" && <ForeignEditor automation={automation} onClose={() => onEdit(false)} />}
    </div>
  );
}

/** Webhooks and app events keep their own editors: they have fields a routine has none of. */
function ForeignEditor({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const { state } = useStore();
  const bots = state.bots.filter((bot) => !bot.hidden);
  return createPortal(
    automation.kind === "app"
      ? <AppEventEditor trigger={automation.appTrigger} bots={bots} onClose={onClose} />
      : <WebhookEditor webhook={state.webhooks.find((webhook) => webhook.id === automation.id)} bots={bots} onClose={onClose} onCredential={(credential, id) => saveWebhookCredential(webhookCredentialStore(), id, credential)} />,
    document.body,
  );
}

function AutomationDetail({ id, bot, automation, routine, actions, onEdit }: {
  id: string;
  bot: Bot;
  automation: Automation;
  routine?: Routine;
  actions: ReturnType<typeof useAllAutomationActions>;
  onEdit: () => void;
}) {
  const { state, dispatch } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [capSaved, setCapSaved] = useState(0);
  const forecast = useLoaded(() => (routine ? fetchForecast(routine.id) : Promise.resolve(null)), `${routine?.id}:${routine?.updatedAt}:${capSaved}:${automation.runs[0]?.status}`);
  const status = automationStatus(automation);
  const runs = automation.runs.filter((run) => run.status !== "queued" || Boolean(run.attention?.trim())).slice(0, RECENT_RUNS);
  const roomGoal = routine?.target === "room-goal";
  const worksOn = routineRunsOn({ roomGoal, runOn: routine?.runOn ?? automation.appTrigger?.runOn, computer: bot.computer, cloudHome: state.config?.cloudHome === true });
  const resultsTo = roomGoal
    ? state.groups.find((group) => group.id === routine?.groupId)?.name ?? t("routines.results.main")
    : routine?.resultsThreadId
      ? bot.tasks?.find((task) => task.threadId === routine.resultsThreadId)?.title ?? t("routines.results.missing")
      : t("routines.results.main");
  const notes = [
    status.state === "needs-you" ? status.reason : null,
    status.state === "done" ? t("automations.reason.done") : null,
    routine?.warning,
    routine && !routine.enabled && routine.pausedFor ? pauseLine(routine.pausedFor) : null,
  ].filter((note): note is string => Boolean(note));
  const looksAt = routine?.checks?.map((check) => (check === "probe" && routine.probe ? probeLine(routine.probe) : t(`routines.inline.check.${check}`)));
  const hours = routine ? hoursLine(routine.schedule) : null;
  const strip = routine ? liveStrip(routine, state.routineRuns) : [];
  const busy = Boolean(actions.busy);
  const fix = (kind: AutomationFix) => {
    if (kind === "usage") dispatch({ type: "toggleAppSettings", open: true, section: "usage" });
    else if (kind === "reconnect") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
    else if (kind === "answer") actions.answerRun(automation);
    else actions.openRun(automation, automation.runs.find((run) => run.status !== "queued"));
  };

  return (
    <div id={id} data-routine-detail="" className="flex flex-col gap-3">
      <dl className="m-0 flex flex-col gap-2.5">
        <Fact term={t("routines.inline.when")}>
          {upperFirst(whenLine(automation))}
          {routine?.timing === "around" && <span className="text-ink-secondary" data-routine-timing="around"> · {t("routines.timing.aroundShort")}</span>}
          {automation.enabled && automation.nextRunAt != null && <span className="text-ink-secondary"> · {t("automations.next", { when: nextWhen(automation.nextRunAt) })}</span>}
        </Fact>
        {hours && <Fact term={t("routines.hours.term")}><span data-routine-hours="">{hours}</span></Fact>}
        {strip.length ? <Fact term={t("routines.strip.term")}><RunStrip strip={strip} /></Fact> : null}
        {automation.instructions.trim() && <Fact term={t("routines.inline.what")}><span className="whitespace-pre-wrap">{automation.instructions.trim()}</span></Fact>}
        <Fact term={t("routines.inline.worksOn")}>{upperFirst(worksOn.label)}</Fact>
        {automation.kind === "schedule" && <Fact term={t("routines.inline.resultsTo")}>{upperFirst(resultsTo)}</Fact>}
        {routine && forecast?.warnings && (
          <Fact term={t("routines.cost.term")}>
            <span data-routine-forecast="">{upperFirst(forecastLine(forecast))}</span>
            {forecast.warnings.map((warning) => <span key={warning} className="block text-[12px] leading-4 text-warning">{t(warning === "frequent" ? "routines.cost.frequent" : "routines.cost.costly")}</span>)}
          </Fact>
        )}
        {routine && <Fact term={t("usage.cap.label")}><SpendCap kind="routine" id={routine.id} capUsd={forecast?.capUsd} onSaved={() => setCapSaved((n) => n + 1)} className="mt-0.5" sentence /></Fact>}
        {(looksAt?.length || automation.readsAndDrafts) && (
          <Fact term={t("routines.inline.uses")}>{[looksAt?.join(", "), automation.readsAndDrafts ? t("automations.readsAndDrafts") : null].filter(Boolean).join(" · ")}</Fact>
        )}
        {routine?.attachments?.length ? <Fact term={t("routines.inline.files")}>{routine.attachments.map((file) => file.name).join(", ")}</Fact> : null}
        <Fact term={t("automations.panel.recent")}>
          {runs.length === 0 ? <span className="text-ink-secondary">{t("automations.panel.noRuns")}</span> : (
            <ul className="m-0 mt-0.5 flex list-none flex-col p-0">
              {runs.map((run) => {
                const line = runLine(run);
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      disabled={!run.threadId}
                      onClick={() => actions.openRun(automation, run)}
                      title={run.threadId ? t("automations.panel.open") : undefined}
                      data-routine-run={run.id}
                      className="-mx-1 flex w-[calc(100%+8px)] items-baseline gap-1.5 rounded-md px-1 py-0.5 text-left enabled:cursor-pointer enabled:hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                    >
                      <span className="shrink-0 text-ink-secondary">{line.when}</span>
                      <span className={cn("shrink-0", line.mark === "✓" ? "text-success" : line.mark === "✗" ? "text-danger" : line.mark === "–" ? "text-ink-tertiary" : "text-warning")}>{line.mark}</span>
                      {run.dryRun && <span className="shrink-0 rounded bg-ink/6 px-1 text-[11px] leading-4 text-ink-secondary">{t("automations.run.test")}</span>}
                      <span className="min-w-0 truncate">{line.text}</span>
                      {forecast?.runCosts?.[run.id] ? <span className="ms-auto shrink-0 tabular-nums text-ink-secondary">{formatCost(forecast.runCosts[run.id])}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Fact>
      </dl>
      {notes.map((note) => <p key={note} className="m-0 text-[12px] leading-4 text-warning">{note}</p>)}
      {status.state === "needs-you" && (status.fix === "answer" || status.fix === "sign-in" || status.fix === "usage" || status.fix === "reconnect") && (
        <button type="button" data-routine-action="fix" onClick={() => fix(status.fix!)} className={cn(buttonCls, "self-start")}>{upperFirst(t(AUTOMATION_FIX_LABEL[status.fix]))}</button>
      )}
      {automation.kind === "webhook" && (
        <button type="button" disabled={busy} onClick={() => void actions.copyAddress(automation.id)} className={cn(buttonCls, "self-start")}>
          {actions.copied === automation.id ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {upperFirst(actions.copied === automation.id ? t("automations.address.copied") : t("automations.address.copy"))}
        </button>
      )}
      {actions.error && <p role="alert" className="m-0 text-[12px] leading-4 text-danger">{actions.error}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {confirming ? (
          <>
            <button type="button" data-routine-action="confirm-delete" disabled={busy} onClick={() => void actions.remove(automation, null)} className={cn(buttonCls, "bg-danger/12 text-danger enabled:hover:bg-danger/20")}>
              {upperFirst(t("routines.inline.deleteConfirm", { name: automation.name }))}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={buttonCls}>{upperFirst(t("common.cancel"))}</button>
          </>
        ) : (
          <>
            <button type="button" data-routine-action="run" disabled={busy} onClick={() => void actions.runNow(automation)} className={buttonCls}>
              {upperFirst(actions.busy === `run:${automation.id}` ? t("automations.starting") : t("automations.runNow"))}
            </button>
            {automation.kind === "schedule" && (
              <button type="button" data-routine-action="test" disabled={busy} onClick={() => void actions.test(automation)} title={t("automations.testHint")} className={buttonCls}>
                {upperFirst(actions.busy === `test:${automation.id}` ? t("automations.starting") : t("automations.test"))}
              </button>
            )}
            <button type="button" data-routine-action="edit" onClick={onEdit} className={buttonCls}>{upperFirst(t("automations.edit"))}</button>
            <button type="button" data-routine-action="delete" disabled={busy} onClick={() => setConfirming(true)} className={buttonCls}>{upperFirst(t("common.delete"))}</button>
          </>
        )}
      </div>
    </div>
  );
}
