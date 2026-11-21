import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { t } from "@/lib/i18n";
import { waitForLocalVmReady } from "@/lib/local-vm-readiness";
import type { LocaleKey } from "@/locales";
import { Loader2 } from "../icons";
import { SettingRow } from "./SettingsPrimitives";
import { Card as RowsCard, FormDialog, FormField, ItemRow, NavRow, NoteRow, useSubPage } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";
import { MacLocalControl } from "./MacLocalControl";
import { PRIVATE_SETUP_PAGE } from "./settings-page-ids";
import { SettingsSelect } from "./SettingsSelect";
import { useCopyFeedback } from "@/lib/copy-text";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import { openPlaceSetup } from "@/lib/place-setup";
import { VpsComputersCard } from "./VpsComputersCard";
import { DirectLinkRow } from "./DirectLinkRow";
import { RouteTrafficRow } from "./RouteTrafficRow";
import { MacControlRow } from "./MacControlRow";
import { CloudMacCard } from "./CloudMacCard";
import { friendlyError } from "@/lib/plain-error";
import { ArtState } from "./ui/Art";

type Action = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

interface Status {
  platform: string;
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
  idle_timeout_ms: number;
  stop_reason?: "idle" | null;
  mode: "shared" | "per-bot" | "pool";
  max_instances: number;
  commands: {
    install: string | null;
    runtimeStart: string | null;
    pull: string | null;
    run: string | null;
    start: string | null;
    stop: string | null;
    remove: string | null;
    view: string;
  };
}

export interface LocalVmInventoryInstance {
  botId: string;
  name: string;
  destination: "auto" | "cloud" | "vm" | "local" | "browser" | "off";
  container: "running" | "stopped";
  ready: boolean;
  managed: boolean;
  problem: string | null;
  inUse: boolean;
}

interface LocalVmInventoryPayload {
  instances: LocalVmInventoryInstance[];
  maxInstances: number;
  available: boolean;
  problem: string | null;
}

export interface VpsComputerInventoryInstance {
  name: string;
  state: "created" | "restarting" | "running" | "removing" | "paused" | "exited" | "dead" | "unknown";
  /** The SSH alias whose host holds this computer. */
  vpsAlias: string;
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

interface VpsComputerInventoryPayload {
  configured: boolean;
  available: boolean;
  /** The default alias first, then each bot's own. */
  vpsAliases: string[];
  problem: string | null;
  instances: VpsComputerInventoryInstance[];
}

const destinationLabelKeys: Record<LocalVmInventoryInstance["destination"], LocaleKey> = {
  auto: "vm.dest.auto",
  cloud: "place.cloud",
  vm: "vm.dest.vm",
  local: "vm.dest.local",
  browser: "vm.dest.browser",
  off: "vm.dest.off",
};

export type ComputerStateKind =
  | "unmanaged"
  | "in-use"
  | "stopped"
  | "running"
  | "attention"
  | "sleeping"
  | "going-to-sleep"
  | "starting"
  | "restarting"
  | "removing"
  | "paused";

const stateLabelKeys: Record<ComputerStateKind, LocaleKey> = {
  unmanaged: "vm.state.notManaged",
  "in-use": "vm.state.inUse",
  stopped: "vm.state.stopped",
  running: "vm.state.running",
  attention: "vm.state.attention",
  sleeping: "vm.state.sleeping",
  "going-to-sleep": "vm.state.goingToSleep",
  starting: "vm.state.starting",
  restarting: "vm.state.restarting",
  removing: "vm.state.removing",
  paused: "vm.state.paused",
};

export function computerStateLabel(kind: ComputerStateKind): string {
  return t(stateLabelKeys[kind]);
}

export function localVmInventoryStateKind(instance: LocalVmInventoryInstance): ComputerStateKind {
  if (!instance.managed) return "unmanaged";
  if (instance.inUse) return "in-use";
  if (instance.container === "stopped") return "stopped";
  if (instance.ready) return "running";
  return "attention";
}

export function localVmInventoryState(instance: LocalVmInventoryInstance): string {
  return computerStateLabel(localVmInventoryStateKind(instance));
}

export function vpsComputerInventoryStateKind(
  instance: VpsComputerInventoryInstance,
): ComputerStateKind {
  if (instance.inUse) return "in-use";
  if (instance.state === "running") return "running";
  if (instance.state === "restarting") return "restarting";
  if (instance.state === "removing") return "removing";
  if (["created", "exited"].includes(instance.state)) return "stopped";
  if (instance.state === "paused") return "paused";
  return "attention";
}

export function vpsComputerInventoryState(instance: VpsComputerInventoryInstance): string {
  return computerStateLabel(vpsComputerInventoryStateKind(instance));
}

export function vpsComputerShortId(name: string): string {
  const suffix = /-([a-f0-9]{12})$/i.exec(name)?.[1];
  return suffix ? suffix.slice(-8).toLowerCase() : "unknown";
}

type ComputerInventoryRequest = "status" | "local-vms" | "vps";
type ComputerApiRequest = [url: string, init: RequestInit];
export interface ComputerActionPlan {
  confirmation: string | null;
  request: ComputerApiRequest;
}

const computerInventoryPaths: Record<ComputerInventoryRequest, string> = {
  status: "/api/local-computer",
  "local-vms": "/api/local-computer/instances",
  vps: "/api/computers/vps",
};

/** Observation only: opening Computers must never provision or wake anything. */
export function computerInventoryRequest(
  inventory: ComputerInventoryRequest,
  signal?: AbortSignal,
): ComputerApiRequest {
  return [computerInventoryPaths[inventory], { signal }];
}

function jsonPostRequest(url: string, body: unknown): ComputerApiRequest {
  return [url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }];
}

export function perBotLocalVmDeletePlan(instance: LocalVmInventoryInstance): ComputerActionPlan {
  return {
    confirmation: t("vm.confirm.deleteBotVm", { name: instance.name }),
    request: jsonPostRequest(`/api/bots/${instance.botId}/local-computer/remove`, {}),
  };
}

export function vpsComputerRemovePlan(instance: VpsComputerInventoryInstance): ComputerActionPlan {
  const shortId = vpsComputerShortId(instance.name);
  return {
    confirmation: t("vm.confirm.removeVps", {
      subject: instance.orphaned
        ? t("vm.confirm.orphanVps", { id: shortId })
        : t("vm.confirm.ownedVps", { name: instance.ownerName ?? "" }),
    }),
    request: jsonPostRequest(`/api/computers/vps/${encodeURIComponent(instance.name)}/remove`, {
      confirmName: instance.name,
      alias: instance.vpsAlias,
    }),
  };
}

export function vpsComputerRestartPlan(instance: VpsComputerInventoryInstance): ComputerActionPlan {
  return {
    confirmation: t("vm.confirm.restartVps", { name: instance.ownerName ?? "" }),
    request: jsonPostRequest(`/api/computers/vps/${encodeURIComponent(instance.name)}/restart`, {}),
  };
}

export function confirmComputerAction(
  plan: ComputerActionPlan,
  confirm: (message: string) => boolean,
): ComputerApiRequest | null {
  if (plan.confirmation !== null && !confirm(plan.confirmation)) return null;
  return plan.request;
}

/** A computer's state as the row's quiet value: green while it works, grey asleep or stopped, amber otherwise. */
export function ComputerState({ kind, label, busy = false }: { kind: "good" | "idle" | "warn"; label: string; busy?: boolean }) {
  return (
    <span data-computer-state={kind} className={cn("shrink-0 text-[13px] leading-[18px]", kind === "good" ? "text-success" : kind === "idle" ? "text-ink-secondary" : "text-warning")}>
      {busy && <Loader2 size={11} aria-hidden="true" className="me-1 inline animate-spin align-[-1px]" />}{label}
    </span>
  );
}

export function LocalVmInventoryCard({
  instances,
  maxInstances,
  loading,
  deletingBotId,
  error,
  unavailableReason,
  onRefresh,
  onDelete,
}: {
  instances: LocalVmInventoryInstance[];
  maxInstances: number;
  loading: boolean;
  deletingBotId: string | null;
  error: string | null;
  unavailableReason: string | null;
  onRefresh: () => void;
  onDelete: (instance: LocalVmInventoryInstance) => void;
}) {
  const busy = loading || deletingBotId !== null;
  return (
    <RowsCard label={t("vm.perBot.title")} data-settings-block="per-bot-desktops">
      <ItemRow title={unavailableReason ? t("vm.perBot.inventoryUnavailable") : t("vm.perBot.created", { count: instances.length, max: maxInstances })}>
        <button type="button" onClick={onRefresh} disabled={busy} aria-label={t("vm.perBot.refreshAria")} className="ui-button">{t("vm.refresh")}</button>
      </ItemRow>

      {error && <NoteRow tone="danger">{error}</NoteRow>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? t("vm.perBot.checking")
          : unavailableReason
            ? t("vm.perBot.unavailable", { reason: unavailableReason })
            : instances.length === 1
              ? t("vm.perBot.foundOne")
              : t("vm.perBot.foundMany", { count: instances.length })}
      </p>

      <div aria-busy={busy} className="contents">
        {loading && instances.length === 0 ? (
          <NoteRow>{t("vm.perBot.checkingList")}</NoteRow>
        ) : unavailableReason ? (
          <NoteRow tone="warn">{unavailableReason}</NoteRow>
        ) : instances.length === 0 ? (
          <ArtState data-art-state="desktops" art="computer" title={t("empty.desktops.title")} className="py-6">{t("empty.desktops.hint")}</ArtState>
        ) : instances.map((instance) => {
          const state = localVmInventoryState(instance);
          const deleting = deletingBotId === instance.botId;
          const managed = instance.managed === true;
          const destination = t("vm.perBot.destination", { destination: t(destinationLabelKeys[instance.destination]) });
          const note = !managed
            ? <span className="text-warning">{t("vm.perBot.unmanaged")}</span>
            : instance.problem && !instance.inUse
              ? <span className="text-warning">{instance.problem}</span>
              : instance.inUse ? t("vm.perBot.stopFirst") : null;
          return (
            <ItemRow key={instance.botId} title={instance.name} hint={note ? <>{destination} · {note}</> : destination}>
              <ComputerState label={state} kind={!managed ? "warn" : instance.inUse || instance.ready ? "good" : instance.container === "stopped" ? "idle" : "warn"} />
              {managed && <button
                type="button"
                onClick={() => onDelete(instance)}
                disabled={loading || instance.inUse || deletingBotId !== null}
                aria-busy={deleting || undefined}
                title={
                  instance.inUse
                    ? t("vm.perBot.deleteBlocked")
                    : t("vm.perBot.deleteTitle", { name: instance.name })
                }
                className="ui-button"
              >
                {t("common.delete")}
              </button>}
            </ItemRow>
          );
        })}
      </div>
    </RowsCard>
  );
}

/** A setup step as a Grok row: its name, Done once it is, and what to do next on the right. */
function Step({ title, done, detail, children }: { title: string; done: boolean; detail?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <SettingRow title={title} subtitle={done ? t("settings.w6.setup.done") : detail}>
      {!done && children ? <div className="flex flex-wrap items-center justify-end gap-2">{children}</div> : null}
    </SettingRow>
  );
}

function CopyCommand({ command }: { command: string }) {
  const { state, copy } = useCopyFeedback(command);
  return <button type="button" onClick={copy} title={command} className="ui-button">{state === "copied" ? t("settings.w6.setup.copied") : t("settings.w6.setup.copy")}</button>;
}

function ActionButton({
  action,
  pending,
  children,
  onClick,
  danger = false,
}: {
  action: Action;
  pending: Action | null;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-busy={pending === action}
      disabled={pending !== null}
      className={cn("ui-button", danger && "ui-button-danger")}
    >
      {pending === action && <Loader2 size={12} aria-hidden="true" className="animate-spin" />}
      {children}
    </button>
  );
}

// Mirrors localVm.idleTimeoutMinutes in server/config.ts; the server is the authority.
const MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 5;
const MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 1_440;
const DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 480;

export function parseLocalVmIdleTimeoutMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return minutes >= MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES && minutes <= MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES ? minutes : null;
}

/** The minutes field of the idle timeout, as its small form draws it. */
export function LocalVmIdleTimeoutField({ value, disabled, error, onChange }: { value: string; disabled: boolean; error: string; onChange: (value: string) => void }) {
  return (
    <FormField label={t("vm.idle.label")}>
      <span className="flex items-center gap-2">
        <input
          id="local-vm-idle-timeout"
          type="number"
          min={MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES}
          max={MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES}
          step={1}
          inputMode="numeric"
          value={value}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
          className={cn(textFieldCls, "w-28 tabular-nums")}
        />
        <span className="text-[13px] text-ink-secondary">{t("vm.idle.minutes")}</span>
      </span>
    </FormField>
  );
}

export function LocalVmIdleTimeoutSetting({
  minutes,
  disabled,
  onSave,
}: {
  minutes: number;
  disabled: boolean;
  onSave: (minutes: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(minutes));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    const parsed = parseLocalVmIdleTimeoutMinutes(value);
    if (parsed === null) {
      setError(t("vm.idle.range"));
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
      setValue(String(parsed));
      setError("");
      setOpen(false);
    } catch (cause) {
      setError(friendlyError(cause, t("vm.idle.error")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <NavRow data-settings-open="idle-timeout" title={t("vm.idle.label")} value={`${minutes} ${t("vm.idle.minutes")}`} disabled={disabled}
        onClick={() => { setValue(String(minutes)); setError(""); setOpen(true); }} />
      <AnimatePresence>{open && (
        <FormDialog key="idle-timeout" data-panel-modal="idle-timeout" title={t("vm.idle.label")} description={t("vm.idle.detail")} busy={saving} error={error || undefined}
          onSave={save} onClose={() => setOpen(false)}>
          <LocalVmIdleTimeoutField value={value} disabled={saving} error={error} onChange={(next) => { setValue(next); setError(""); }} />
        </FormDialog>
      )}</AnimatePresence>
    </>
  );
}

export function LocalComputerSection() {
  const cloudHome = useStore().state.config?.cloudHome === true;
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const sub = useSubPage();
  const [pending, setPending] = useState<Action | null>(null);
  const actionController = useRef<AbortController | null>(null);
  useEffect(() => () => actionController.current?.abort(), []);
  const [error, setError] = useState<string | null>(null);
  const [policyPending, setPolicyPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [inventory, setInventory] = useState<LocalVmInventoryInstance[]>([]);
  const [inventoryMax, setInventoryMax] = useState(2);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventoryUnavailableReason, setInventoryUnavailableReason] = useState<string | null>(null);
  const [deletingBotId, setDeletingBotId] = useState<string | null>(null);
  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0);
  const [vpsInventory, setVpsInventory] = useState<VpsComputerInventoryInstance[]>([]);
  const [vpsConfigured, setVpsConfigured] = useState<boolean | null>(null);
  const [vpsAliases, setVpsAliases] = useState<string[]>([]);
  const [vpsLoading, setVpsLoading] = useState(true);
  const [vpsError, setVpsError] = useState<string | null>(null);
  const [vpsUnavailableReason, setVpsUnavailableReason] = useState<string | null>(null);
  const [vpsRemovingName, setVpsRemovingName] = useState<string | null>(null);
  const [vpsRestartingName, setVpsRestartingName] = useState<string | null>(null);
  const [vpsRefreshKey, setVpsRefreshKey] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("status", signal));
    const body = await response.json().catch(() => ({}));
    if (signal?.aborted) return;
    if (!response.ok) throw new Error(body.error ?? t("vm.err.status", { code: response.status }));
    setStatus(body as Status);
    setError(null);
    return body as Status;
  }, []);

  const refreshInventory = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("local-vms", signal));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? t("vm.err.inventory", { code: response.status }));
    const payload = body as LocalVmInventoryPayload;
    setInventory(payload.instances);
    setInventoryMax(payload.maxInstances);
    setInventoryUnavailableReason(payload.available ? null : (payload.problem ?? t("vm.err.runtimeUnavailable")));
    setInventoryError(null);
  }, []);

  const refreshVpsInventory = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("vps", signal));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? t("vm.err.vpsInventory", { code: response.status }));
    const payload = body as VpsComputerInventoryPayload;
    setVpsInventory(Array.isArray(payload.instances) ? payload.instances : []);
    setVpsConfigured(payload.configured === true);
    setVpsAliases(Array.isArray(payload.vpsAliases) ? payload.vpsAliases : []);
    setVpsUnavailableReason(
      payload.available || !payload.configured
        ? null
        : (payload.problem ?? t("vm.err.vpsUnavailable")),
    );
    setVpsError(null);
  }, []);

  useEffect(() => {
    if (cloudHome) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatus(null);
          setError(friendlyError(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [cloudHome, refresh, refreshKey]);

  useEffect(() => {
    if (status?.mode !== "per-bot") {
      setInventory([]);
      setInventoryLoading(false);
      setInventoryError(null);
      setInventoryUnavailableReason(null);
      return;
    }
    const controller = new AbortController();
    setInventoryLoading(true);
    void refreshInventory(controller.signal)
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setInventoryError(friendlyError(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setInventoryLoading(false);
      });
    return () => controller.abort();
  }, [inventoryRefreshKey, refreshInventory, status?.mode]);

  useEffect(() => {
    const controller = new AbortController();
    setVpsLoading(true);
    void refreshVpsInventory(controller.signal)
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setVpsUnavailableReason(friendlyError(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setVpsLoading(false);
      });
    return () => controller.abort();
  }, [refreshVpsInventory, vpsRefreshKey]);

  const post = async (action: Exclude<Action, "recreate">, signal: AbortSignal) => {
    const response = await fetch(`/api/local-computer/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal,
    });
    const body = await response.json().catch(() => ({}));
    const errorKeys: Record<Exclude<Action, "recreate">, LocaleKey> = {
      pull: "vm.err.prepare",
      run: "vm.err.create",
      start: "vm.err.start",
      stop: "vm.err.stop",
      remove: "vm.deleteError",
    };
    if (!response.ok) throw new Error(body.error ?? t(errorKeys[action]));
    signal.throwIfAborted();
    setStatus(body as Status);
    return body as Status;
  };

  const confirmAction = (message: string) => window.madaniDesktop?.confirm ? window.madaniDesktop.confirm(message) : window.confirm(message);

  const act = async (action: Action) => {
    if (pending !== null || actionController.current) return;
    const controller = new AbortController();
    actionController.current = controller;
    setPending(action);
    setError(null);
    try {
      if (action === "remove" && !(await confirmAction(t("vm.confirm.deleteShared")))) return;
      if (action === "recreate" && !(await confirmAction(t("vm.confirm.recreate")))) return;
      let result: Status;
      if (action === "recreate") {
        await post("remove", controller.signal);
        result = await post("run", controller.signal);
      } else {
        result = await post(action, controller.signal);
      }
      if (action === "run" || action === "start" || action === "recreate") {
        result = await waitForLocalVmReady(
          result,
          async () => (await refresh(controller.signal)) ?? result,
          controller.signal,
        );
        if (!result.ready) throw new Error(result.problem ?? t("vm.err.start"));
      }
      await refresh();
      setAnnouncement(
        action === "remove"
          ? t("vm.announce.deleted")
          : action === "stop"
            ? t("vm.announce.stopped")
            : t("vm.announce.updated"),
      );
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(friendlyError(e));
    } finally {
      actionController.current = null;
      if (!controller.signal.aborted) setPending(null);
    }
  };

  const savePolicy = async (mode: Status["mode"], maxInstances: number) => {
    setPolicyPending(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { mode, maxInstances } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("vm.policyError"));
      setStatus((current) => current ? { ...current, mode, max_instances: maxInstances } : current);
      await refresh();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const saveIdleTimeout = async (idleTimeoutMinutes: number) => {
    const response = await fetch("/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localVm: { idleTimeoutMinutes } }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? t("vm.idle.error"));
    setStatus((current) => current ? { ...current, idle_timeout_ms: idleTimeoutMinutes * 60_000 } : current);
  };

  const deletePerBotVm = async (instance: LocalVmInventoryInstance) => {
    if (!instance.managed) {
      setInventoryError(t("vm.unmanagedError"));
      return;
    }
    const request = confirmComputerAction(
      perBotLocalVmDeletePlan(instance),
      (message) => window.confirm(message),
    );
    if (!request) return;
    setDeletingBotId(instance.botId);
    setInventoryError(null);
    try {
      const response = await fetch(...request);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("vm.deleteError"));
      await refreshInventory();
      setAnnouncement(t("vm.announce.deletedBot", { name: instance.name }));
    } catch (e) {
      setInventoryError(friendlyError(e));
    } finally {
      setDeletingBotId(null);
    }
  };

  const restartVpsComputer = async (instance: VpsComputerInventoryInstance) => {
    const request = confirmComputerAction(vpsComputerRestartPlan(instance), (message) => window.confirm(message));
    if (!request) return;
    setVpsRestartingName(instance.name);
    setVpsError(null);
    try {
      const response = await fetch(...request);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("vm.vpsRestartError"));
      await refreshVpsInventory();
      setAnnouncement(t("vm.announce.vpsRestarted", { name: instance.ownerName ?? "" }));
    } catch (e) {
      setVpsError(friendlyError(e));
    } finally {
      setVpsRestartingName(null);
    }
  };

  const removeVpsComputer = async (instance: VpsComputerInventoryInstance) => {
    const shortId = vpsComputerShortId(instance.name);
    const request = confirmComputerAction(
      vpsComputerRemovePlan(instance),
      (message) => window.confirm(message),
    );
    if (!request) return;
    setVpsRemovingName(instance.name);
    setVpsError(null);
    try {
      const response = await fetch(...request);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("vm.vpsRemoveError"));
      await refreshVpsInventory();
      setAnnouncement(
        t("vm.announce.vpsRemoved", {
          subject: instance.orphaned
            ? t("vm.announce.orphanVps", { id: shortId })
            : t("vm.confirm.ownedVps", { name: instance.ownerName ?? "" }),
        }),
      );
    } catch (e) {
      setVpsError(friendlyError(e));
    } finally {
      setVpsRemovingName(null);
    }
  };

  const c = status?.commands;
  const ready = status?.ready === true;
  const existing = status?.container !== "missing";
  const needsRecreate = Boolean(
    existing &&
      (!status?.imageMatches ||
        !status?.managed ||
        status?.network === "unsafe" ||
        status?.security === "unsafe" ||
        status?.persistence === "unsafe"),
  );
  const unavailable = !loading && !status;
  const perBot = status?.mode === "per-bot";
  const perBotRuntimeUnsupported = perBot && status?.runtime === "container";
  const headerReady = perBot ? Boolean(status?.daemonUp && status?.image && !perBotRuntimeUnsupported) : ready;

  const announcer = <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>;

  // Setup and options is its own page of this one: the private desktop's policy, its setup steps and its storage
  if (sub.at === PRIVATE_SETUP_PAGE && !cloudHome) {
    return (
      <>
        {announcer}
        <RowsCard data-settings-block="private-desktop-options">
          <SettingRow title={t("vm.isolation.title")} subtitle={policyPending ? t("vm.saving") : undefined}>
            <SettingsSelect
              value={status?.mode ?? "shared"}
              aria-label={t("vm.isolation.title")}
              disabled={!status || policyPending}
              options={[{ value: "shared", label: t("vm.isolation.shared") }, { value: "per-bot", label: t("vm.isolation.perBot") }]}
              onChange={(event) => void savePolicy(event.target.value === "per-bot" ? "per-bot" : "shared", status?.max_instances ?? 2)}
            />
          </SettingRow>
          {perBot && (
            <SettingRow title={t("vm.isolation.max")}>
              <SettingsSelect
                data-settings-select="max-desktops"
                aria-label={t("vm.isolation.maxAria")}
                value={String(status?.max_instances ?? 2)}
                disabled={!status || policyPending}
                options={[1, 2, 3, 4, 5, 6, 7, 8].map((value) => ({ value: String(value), label: String(value) }))}
                onChange={(event) => void savePolicy(status?.mode ?? "shared", Number(event.target.value))}
              />
            </SettingRow>
          )}
          <LocalVmIdleTimeoutSetting
            minutes={status?.idle_timeout_ms ? Math.round(status.idle_timeout_ms / 60_000) : DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES}
            disabled={!status || policyPending}
            onSave={saveIdleTimeout}
          />
        </RowsCard>

        <RowsCard label={t("vm.setup.title")} data-settings-block="private-desktop-setup"
          footnote={unavailable ? t("vm.inspectFailed") : undefined}>
          <Step title={t("vm.setup.step1")} done={Boolean(status?.runtime)}>
            {c?.install
              ? <CopyCommand command={c.install} />
              : <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="ui-button">{t("settings.w6.setup.guide")}</a>}
          </Step>
          <Step
            title={status?.runtime && !status.daemonUp ? t("vm.setup.step2Open", { runtime: status.runtime }) : t("vm.setup.step2")}
            done={Boolean(status?.daemonUp)}
          >
            {status?.runtime && c?.runtimeStart ? <CopyCommand command={c.runtimeStart} /> : null}
          </Step>
          <Step title={t("vm.setup.step3")} done={Boolean(status?.image)}>
            {c?.pull && <CopyCommand command={c.pull} />}
            {status?.daemonUp && <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>{t("vm.setup.prepare")}</ActionButton>}
          </Step>
          <Step
            title={perBot ? t("vm.setup.step4PerBot") : needsRecreate ? t("vm.setup.step4Recreate") : t("vm.setup.step4")}
            done={!perBot && ready}
            detail={perBot
              ? perBotRuntimeUnsupported ? t("vm.setup.applePort") : undefined
              : needsRecreate
                ? status?.image ? status?.problem : t("vm.setup.prepareFirst")
                : status?.container === "running" ? t("vm.setup.waiting") : undefined}
          >
            {c?.run && <CopyCommand command={c.run} />}
            {perBot ? null : needsRecreate ? (
              status?.image ? (
                <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger>{t("vm.setup.recreate")}</ActionButton>
              ) : null
            ) : status?.container === "stopped" || (status?.image && status?.container !== "running") ? (
              <ActionButton action={status?.container === "stopped" ? "start" : "run"} pending={pending} onClick={() => void act(status?.container === "stopped" ? "start" : "run")}>{t("vm.setup.start")}</ActionButton>
            ) : null}
          </Step>
        </RowsCard>

        {perBot && (
          <LocalVmInventoryCard
            instances={inventory}
            maxInstances={inventoryMax || status?.max_instances || 2}
            loading={inventoryLoading}
            deletingBotId={deletingBotId}
            error={inventoryError}
            unavailableReason={inventoryUnavailableReason}
            onRefresh={() => setInventoryRefreshKey((key) => key + 1)}
            onDelete={(instance) => void deletePerBotVm(instance)}
          />
        )}

        <RowsCard data-settings-block="private-desktop-storage">
          <SettingRow title={t("settings.w6a.private.storage")} subtitle={t("settings.w6a.private.folder", { path: status?.workspace_path ?? t("vm.safety.notCreated") })}>
            {existing ? (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {status?.container === "running" && <ActionButton action="stop" pending={pending} onClick={() => void act("stop")}>{t("vm.safety.stop")}</ActionButton>}
                <ActionButton action="remove" pending={pending} onClick={() => void act("remove")} danger>{perBot ? t("vm.safety.deleteLegacy") : t("vm.safety.deleteVm")}</ActionButton>
              </div>
            ) : null}
          </SettingRow>
        </RowsCard>
      </>
    );
  }

  return (
    <>
      {announcer}
      <RowsCard label={t("settings.w6.group.cloudDesktop")} data-settings-block="vps-desktops">
        {vpsConfigured === false && !vpsLoading && !vpsUnavailableReason && (typeof window === "undefined" || window.madaniDesktop?.remoteClient?.active !== true) && <NavRow title={t("vpsLink.add")} hint={t("vpsLink.addHint")} onClick={() => openPlaceSetup("server")} />}
        <VpsComputersCard
          instances={vpsInventory}
          configured={vpsConfigured}
          aliases={vpsAliases}
          loading={vpsLoading}
          removingName={vpsRemovingName}
          restartingName={vpsRestartingName}
          error={vpsError}
          unavailableReason={vpsUnavailableReason}
          onRefresh={() => setVpsRefreshKey((key) => key + 1)}
          onRemove={(instance) => void removeVpsComputer(instance)}
          onRestart={(instance) => void restartVpsComputer(instance)}
        />
      </RowsCard>

      {cloudHome && (
        <RowsCard label={t("settings.grok.group.yourComputer")} data-settings-block="cloud-home-connection">
          <CloudMacCard />
          <RouteTrafficRow blockedOnly />
        </RowsCard>
      )}
      {!cloudHome && (
        <RowsCard label={t("settings.grok.group.yourComputer")} data-settings-block="private-desktop">
          <DirectLinkRow />
          <RouteTrafficRow />
          <MacControlRow />
          <ItemRow
            title={t("settings.w6a.private.title")}
            hint={<span aria-live="polite">{loading
              ? t("common.checking")
              : unavailable
                ? t("vm.main.statusUnavailable")
                : perBot && headerReady
                  ? t("vm.main.readyPerBot")
                  : perBotRuntimeUnsupported
                    ? t("vm.main.perBotUnsupported")
                    : ready
                      ? t("vm.main.ready")
                      : (status?.problem ?? t("vm.main.notReady"))}</span>}
          >
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setRefreshKey((key) => key + 1);
                setInventoryRefreshKey((key) => key + 1);
              }}
              disabled={loading || pending !== null}
              className="ui-button"
            >
              {t("vm.main.recheck")}
            </button>
            {ready && !perBot && (
              <a href={status?.viewer_url ?? c?.view} target="_blank" rel="noreferrer" className="ui-button">{t("vm.main.watch")}</a>
            )}
          </ItemRow>
          {error && <NoteRow tone="danger">{error}</NoteRow>}
          <NavRow data-panel-page={PRIVATE_SETUP_PAGE} title={t("settings.w6a.private.more")} onClick={() => sub.open(PRIVATE_SETUP_PAGE, t("settings.w6a.private.more"))} />
        </RowsCard>
      )}
      <MacLocalControl />
    </>
  );
}
