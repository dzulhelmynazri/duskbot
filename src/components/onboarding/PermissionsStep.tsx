// The first run's last screen on a Mac: the permissions a bot needs to use this Mac, each one press away, all skippable.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "../../icons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MAC_PERMISSIONS, openMacPermissionPane, screenNeedsReopen, type MacPermission, type MacPermissionState, type MacPermissionStatus, type MacPermissionsBridge } from "@/lib/mac-permissions";
import { macCuaPermissionHelper, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { Art, type ArtName } from "../ui/Art";
import { GrokDialog, mdPrimaryCls } from "../ui/GrokDialog";
import { PRIMARY, QUIET, StepArt, StepFrame } from "./FunnelSteps";

/** How often the screen reads the grants while it is open: they are made in System Settings, outside this window. */
export const PERMISSIONS_POLL_MS = 1_500;

const ROWS: Record<MacPermission, { art: ArtName; name: Parameters<typeof t>[0]; why: Parameters<typeof t>[0] }> = {
  accessibility: { art: "click", name: "funnel.permissions.accessibility", why: "funnel.permissions.accessibilityWhy" },
  screen: { art: "computer", name: "funnel.permissions.screen", why: "funnel.permissions.screenWhy" },
};

/** The permissions a bot needs to use this Mac, each with where it stands and one press to grant it, read again while it shows:
 * the grants are made in System Settings, outside this window. `onStatus`: how many are on, as they change. */
export function MacPermissionList({ bridge, relaunch, onStatus }: {
  bridge: MacPermissionsBridge;
  relaunch?: (() => void) | null;
  onStatus?: (granted: number) => void;
}) {
  const [status, setStatus] = useState<MacPermissionStatus | null>(null);
  const [busy, setBusy] = useState<MacPermission | null>(null);
  // panes opened for a helper's grant: it is then theirs to turn on in System Settings
  const [opened, setOpened] = useState<ReadonlySet<MacPermission>>(new Set());
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  // a copy run from source drives this Mac through a helper app, so the grants that count are the helper's, as it reports them
  const { capabilities } = useDesktopCapabilities();
  const local = capabilities.localComputer;
  const helper = local?.available === false ? macCuaPermissionHelper(local.message) : null;
  const helperMissing = helper ? missingMacCuaPermissions(local?.message) : [];

  const read = useCallback(() => {
    void bridge.status().then((next) => { if (live.current) setStatus(next); }, () => {});
  }, [bridge]);
  useEffect(() => {
    read();
    const timer = setInterval(read, PERMISSIONS_POLL_MS);
    // back from System Settings: the helper looks again for what was turned on there
    const back = () => { read(); if (helper) void window.madaniDesktop?.localControl?.retry?.().catch(() => {}); };
    window.addEventListener("focus", back);
    return () => { clearInterval(timer); window.removeEventListener("focus", back); };
  }, [read, helper]);

  const ask = async (kind: MacPermission) => {
    setBusy(kind);
    try {
      if (helper) {
        await openMacPermissionPane(kind);
        if (live.current) setOpened((now) => new Set(now).add(kind));
        return;
      }
      const next = await bridge.request(kind).catch(() => null);
      // an app whose main process cannot read or ask (one started before this bridge) still gets the pane
      if (!next?.supported) await openMacPermissionPane(kind);
      else if (live.current) setStatus(next);
    } finally {
      if (live.current) setBusy(null);
      read();
    }
  };

  const shown = status?.supported ? status : null;
  const stateOf = (kind: MacPermission): MacPermissionState => helper
    ? helperMissing.includes(kind) ? opened.has(kind) ? "asked" : "missing" : "granted"
    : shown?.[kind] ?? "missing";
  const granted = MAC_PERMISSIONS.filter((kind) => stateOf(kind) === "granted").length;
  const told = useRef(onStatus);
  told.current = onStatus;
  useEffect(() => { told.current?.(granted); }, [granted]);

  return (
    <>
      <ul className="flex w-full max-w-[420px] flex-col gap-1.5 text-start">
        {MAC_PERMISSIONS.map((kind) => {
          const row = ROWS[kind];
          const state = stateOf(kind);
          return (
            <li key={kind} data-permission={kind} data-permission-state={state}
              className="flex min-h-14 items-center gap-3.5 rounded-2xl bg-ink/[0.035] py-2.5 pe-2.5 ps-4">
              <Art name={row.art} className="size-8 object-contain" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[14px] font-medium leading-5 text-ink">{t(row.name)}</span>
                <span className="text-[13px] leading-[18px] text-ink-secondary">{t(row.why)}</span>
              </span>
              {state === "granted" ? (
                <span role="img" aria-label={t("funnel.permissions.allowed")} className="place-mark grid size-9 shrink-0 place-items-center rounded-full bg-success/10 text-success">
                  <Check size={18} aria-hidden="true" />
                </span>
              ) : (
                <button type="button" data-permission-ask={kind} disabled={busy === kind}
                  aria-label={`${t(state === "asked" ? "funnel.permissions.openSettings" : "funnel.permissions.allow")}: ${t(row.name)}`}
                  onClick={() => void ask(kind)}
                  className="ui-button ui-button-pill min-h-9 shrink-0 whitespace-nowrap bg-ink/[0.07] px-4 hover:bg-ink/[0.11] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.97] disabled:opacity-50 motion-reduce:active:scale-100">
                  {t(state === "asked" ? "funnel.permissions.openSettings" : "funnel.permissions.allow")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {helper && helperMissing.length > 0 && (
        <p data-permissions-helper="" className="mt-4 max-w-[420px] text-center text-[13px] leading-[18px] text-ink-secondary">
          {t("funnel.permissions.helperLine", { helper })}
        </p>
      )}
      {!helper && screenNeedsReopen(shown) && (
        <p data-permissions-reopen="" className="mt-4 flex max-w-[420px] flex-wrap items-center justify-center gap-x-1 text-[13px] leading-[18px] text-ink-secondary">
          {t("funnel.permissions.reopenLine")}
          {relaunch && <button type="button" onClick={relaunch} className={cn(QUIET, "min-h-0 px-1.5 py-0.5 text-ink underline-offset-2 hover:underline")}>{t("funnel.permissions.reopen")}</button>}
        </p>
      )}
    </>
  );
}

export function PermissionsStep({ bridge, onNext, relaunch }: {
  bridge: MacPermissionsBridge;
  /** on to the app; `granted`: how many were on when the person left */
  onNext: (how: "continue" | "later", granted: number) => void;
  /** reopens the app, for Screen Recording to take effect; absent where the app can't */
  relaunch?: (() => void) | null;
}) {
  const granted = useRef(0);
  const leave = (how: "continue" | "later") => onNext(how, granted.current);

  return (
    <div className="my-auto w-full">
      {/* top right, across from Back, and quiet: Continue is the way on */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-end px-4">
        <button type="button" data-funnel-permissions-later="" onClick={() => leave("later")}
          className={cn(QUIET, "pointer-events-auto text-[12px] opacity-40 hover:opacity-70 focus-visible:opacity-100")}>{t("funnel.permissions.later")}</button>
      </div>
      <StepFrame art={<StepArt art="mac-key" />} title={t("funnel.permissions.title")} sub={t("funnel.permissions.sub")}
        footer={<button type="button" data-primary="" data-funnel-permissions-continue="" onClick={() => leave("continue")} className={PRIMARY}>{t("funnel.next")}</button>}>
        <div className="-mt-2 flex w-full flex-col items-center">
          <MacPermissionList bridge={bridge} relaunch={relaunch} onStatus={(count) => { granted.current = count; }} />
        </div>
      </StepFrame>
    </div>
  );
}

/** The same permissions over the app, from a place that found one missing (the Computer tab): each one's state, its
 * grant, read again while it shows. */
export function MacPermissionsDialog({ bridge, relaunch, onClose, onAllowed }: {
  bridge: MacPermissionsBridge; relaunch?: (() => void) | null; onClose: () => void;
  /** every permission is on: what the person asked for goes ahead */
  onAllowed?: () => void;
}) {
  const allowed = useRef(onAllowed);
  allowed.current = onAllowed;
  return (
    <GrokDialog data-mac-permissions-dialog="" title={t("funnel.permissions.title")} description={t("funnel.permissions.sub")} onClose={onClose}
      footer={<button type="button" data-mac-permissions-done="" onClick={onClose} className={mdPrimaryCls}>{t("funnel.permissions.done")}</button>}>
      <MacPermissionList bridge={bridge} relaunch={relaunch} onStatus={(granted) => { if (granted === MAC_PERMISSIONS.length) allowed.current?.(); }} />
    </GrokDialog>
  );
}
