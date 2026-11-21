// What a person can do to an automation, the same from the page, its panel and the chat card.
import { useState } from "react";

import { runWaitingOnYou, type Automation } from "@/lib/automations";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import type { RoutineRun } from "@/lib/routines";
import { keptWebhookAddress, loadWebhookCredentials, removeWebhookCredential, saveWebhookCredential, webhookCredentialStore } from "@/lib/webhook-credentials";
import type { WebhookCredential } from "@/lib/webhooks";
import { api, openBotThread, useStore } from "@/state/store";
import { friendlyError } from "@/lib/plain-error";

export function useAutomationActions() {
  const { state, dispatch } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** What the error is about, e.g. "toggle:<id>", so it shows beside the thing that was clicked. */
  const [errorFor, setErrorFor] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const attempt = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError("");
    setErrorFor(null);
    try { await work(); }
    catch (failure) { setError(friendlyError(failure)); setErrorFor(key); }
    finally { setBusy(null); }
  };

  const toggle = (automation: Automation) => attempt(`toggle:${automation.id}`, async () => {
    if (automation.kind === "schedule") {
      const response = await api(`/api/routines/${automation.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !automation.enabled }) });
      dispatch({ type: "routinePatched", routine: response.routine });
      return;
    }
    const response = await api(`/api/webhooks/${automation.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !automation.enabled, verificationPending: false }) });
    dispatch({ type: "webhookPatched", webhook: response.webhook });
  });

  const test = (automation: Automation) => attempt(`test:${automation.id}`, () =>
    new Promise<void>((resolve, reject) => dispatch({ type: "runRoutine", routineId: automation.id, test: true, onStarted: () => resolve(), onError: reject })));

  const runNow = (automation: Automation) => attempt(`run:${automation.id}`, () => automation.kind === "schedule"
    ? new Promise<void>((resolve, reject) => dispatch({ type: "runRoutine", routineId: automation.id, onStarted: () => resolve(), onError: reject }))
    : api(`/api/webhooks/${automation.id}/test`, { method: "POST", body: JSON.stringify({ event: "madani.test", message: "A test run from Automations" }) }));

  /** Asks once (a person deleting their own automation), then deletes it; `null` when the caller already asked. */
  const remove = async (automation: Automation, question: string | null): Promise<boolean> => {
    if (question !== null && !window.confirm(question)) return false;
    if (automation.kind === "schedule") {
      await attempt(`delete:${automation.id}`, async () => {
        await api(`/api/routines/${automation.id}`, { method: "DELETE" });
        dispatch({ type: "routineDeleted", routineId: automation.id });
      });
      return true;
    }
    await attempt(`delete:${automation.id}`, async () => {
      await api(`/api/webhooks/${automation.id}`, { method: "DELETE" });
      dispatch({ type: "webhookDeleted", webhookId: automation.id });
      removeWebhookCredential(webhookCredentialStore(), automation.id);
    });
    return true;
  };

  /** The address another app sends to, as the server keeps it: the owning bot may already have given it to an app, so
   * copying never replaces it. Only one from before addresses were kept, and not copied here before, gets a new one. */
  const copyAddress = (webhookId: string, replace = false) => attempt(`copy:${webhookId}`, async () => {
    let credential: WebhookCredential | undefined;
    if (!replace) {
      credential = await keptWebhookAddress(() => api(`/api/webhooks/${webhookId}/address`), loadWebhookCredentials(webhookCredentialStore())[webhookId]);
      if (credential) saveWebhookCredential(webhookCredentialStore(), webhookId, credential);
    }
    if (!credential) {
      const response = await api(`/api/webhooks/${webhookId}/rotate`, { method: "POST" });
      credential = response.credential as WebhookCredential;
      dispatch({ type: "webhookPatched", webhook: response.webhook });
      saveWebhookCredential(webhookCredentialStore(), webhookId, credential);
    }
    if (await copyText(credential.url) !== "copied") throw new Error("Couldn't copy the address");
    setCopied(webhookId);
    setTimeout(() => setCopied((current) => (current === webhookId ? null : current)), 1_800);
  });

  const openRun = (automation: Automation, run: RoutineRun | undefined) => {
    const bot = state.bots.find((candidate) => candidate.id === automation.botId);
    if (bot && run?.threadId) openBotThread(dispatch, bot, run.threadId);
  };

  /** Answer: the chat its waiting run asks in, or a plain word that nothing there waits on the person any more. */
  const answerRun = (automation: Automation) => {
    const run = runWaitingOnYou(automation);
    const bot = state.bots.find((candidate) => candidate.id === automation.botId);
    const thread = run?.threadId ? bot?.tasks?.find((task) => task.threadId === run.threadId) : undefined;
    if (bot && thread) openBotThread(dispatch, bot, thread.threadId);
    if (!thread || thread.activity !== "waiting-on-you") dispatch({ type: "notice", notice: { kind: "note", botName: bot?.name ?? null, text: t("automations.answer.nothingWaiting") } });
  };

  return { busy, error, errorFor, setError, copied, toggle, runNow, test, remove, copyAddress, openRun, answerRun };
}
