import { t } from "@/lib/i18n";
import { ItemRow, NoteRow } from "./ListRows";
import {
  ComputerState,
  computerStateLabel,
  vpsComputerInventoryStateKind,
  vpsComputerShortId,
  type VpsComputerInventoryInstance,
} from "./LocalComputerSection";

/** Settings' list of madani bot-managed VPS computers, across every server in play. */
export function VpsComputersCard({
  instances,
  configured,
  aliases,
  loading,
  removingName,
  restartingName = null,
  error,
  unavailableReason,
  onRefresh,
  onRemove,
  onRestart,
}: {
  instances: VpsComputerInventoryInstance[];
  configured: boolean | null;
  aliases: string[];
  loading: boolean;
  removingName: string | null;
  restartingName?: string | null;
  error: string | null;
  unavailableReason: string | null;
  onRefresh: () => void;
  onRemove: (instance: VpsComputerInventoryInstance) => void;
  onRestart?: (instance: VpsComputerInventoryInstance) => void;
}) {
  const acting = removingName !== null || restartingName !== null;
  const status = loading && instances.length === 0
    ? t("common.checking")
    : unavailableReason && instances.length === 0
      ? undefined
      : configured === false
        ? t("settings.w6a.vps.notSetUp")
        : configured === true
          ? [aliases.join(", ") || t("vm.vps.configuredFallback"), inventoryCount(instances.length)].join(" · ")
          : undefined;
  if (configured === false && !loading && !unavailableReason) return null;
  return (
    <>
      <ItemRow title={t("settings.w6a.vps.title")} hint={status}>
        <button type="button" onClick={onRefresh} disabled={loading || acting} aria-label={t("vm.vps.refreshAria")} className="ui-button">{t("vm.refresh")}</button>
      </ItemRow>

      {error && <NoteRow tone="danger">{error}</NoteRow>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? t("vm.vps.checking")
          : unavailableReason
            ? t("vm.vps.unavailable", { reason: unavailableReason })
            : configured === false
              ? t("vm.vps.notConfigured")
              : instances.length === 1
                ? t("vm.vps.foundOne")
                : t("vm.vps.foundMany", { count: instances.length })}
      </p>

      <div aria-busy={loading || acting} className="contents">
        {unavailableReason && <NoteRow tone="warn">{unavailableReason}</NoteRow>}
        {instances.map((instance) => {
          const kind = vpsComputerInventoryStateKind(instance);
          const state = computerStateLabel(kind);
          const removing = removingName === instance.name;
          const shortId = vpsComputerShortId(instance.name);
          const where = aliases.length > 1 ? instance.vpsAlias : undefined;
          const hint = instance.inUse ? (where ? `${where} · ${t("vm.vps.stopFirst")}` : t("vm.vps.stopFirst")) : where;
          return (
            <ItemRow key={`${instance.vpsAlias ?? ""}:${instance.name}`} title={instance.orphaned ? t("vm.vps.orphan", { id: shortId }) : instance.ownerName} hint={hint}>
              <ComputerState label={state} kind={instance.inUse || kind === "running" ? "good" : kind === "stopped" || kind === "paused" ? "idle" : "warn"} />
              {onRestart && !instance.orphaned && (instance.state === "running" || instance.state === "restarting") && (
                <button
                  type="button"
                  onClick={() => onRestart(instance)}
                  disabled={loading || acting}
                  aria-busy={restartingName === instance.name || undefined}
                  title={t("vm.vps.restartTitle")}
                  className="ui-button"
                >
                  {t("vm.vps.restart")}
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemove(instance)}
                disabled={loading || instance.inUse || acting}
                aria-busy={removing || undefined}
                title={t("vm.vps.removeTitle")}
                className="ui-button ui-button-danger"
              >
                {t("vm.vps.remove")}
              </button>
            </ItemRow>
          );
        })}
      </div>
    </>
  );
}

export const inventoryCount = (count: number) => count === 1 ? t("settings.w6a.desktopOne") : count === 0 ? t("settings.w6a.desktopNone") : t("settings.w6a.desktopMany", { count });
