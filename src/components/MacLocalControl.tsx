import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Shield } from "../icons";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/plain-error";

export function MacLocalControl() {
  const { capabilities } = useDesktopCapabilities();
  const reason = capabilities.localComputer.available ? null : capabilities.localComputer.message;
  const permissionMessage = macCuaPermissionMessage(missingMacCuaPermissions(reason), reason);
  const [pending, setPending] = useState(false);
  const [awaitingGrant, setAwaitingGrant] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setPending(true);
    setError(null);
    try {
      await window.madaniDesktop?.localControl?.retry();
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setPending(false);
    }
  };

  const openSettings = async () => {
    setError(null);
    setAwaitingGrant(true);
    try {
      await window.madaniDesktop?.permOpenSettings?.("accessibility");
      await window.madaniDesktop?.permOpenSettings?.("screen");
    } catch (reason) {
      setAwaitingGrant(false);
      setError(friendlyError(reason));
    }
  };

  useEffect(() => {
    if (!awaitingGrant) return;
    let used = false;
    const onFocus = () => {
      if (used) return;
      if (document.visibilityState !== "visible") return;
      used = true;
      setAwaitingGrant(false);
      void retry();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [awaitingGrant]);

  if (capabilities.host.platform !== "darwin" || capabilities.localComputer.reasonCode === "remote-server") return null;
  if (capabilities.localComputer.available) return null;

  return (
    <section className="mt-4 rounded-[14px] border border-transparent bg-menu p-3">
      <div className="flex items-start gap-3">
        <Shield size={15} className="mt-0.5 shrink-0 text-ink/[0.56]" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-[18px] text-ink">Allow control of this computer</div>
          <p className="mt-0.5 text-[12px] leading-4 text-ink/[0.56]">
            {permissionMessage ?? t("computer.mac.permission.generic")}
          </p>
          {reason && !permissionMessage && <p className="mt-1 break-words text-[12px] leading-4 text-ink/[0.56]">{reason}</p>}
          {error && (
            <div className="mt-2 flex gap-1.5 text-[12px] text-danger">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {permissionMessage && reason && <MacCuaRecoveryActions reason={reason} ownRetry />}
            {!permissionMessage && (
              <button
                type="button"
                onClick={() => void openSettings()}
                disabled={pending}
                className="ui-button ui-button-primary h-6! min-h-6! px-2.5! text-[12px]! leading-4!"
              >
                Open System Settings
              </button>
            )}
            <button
              type="button"
              onClick={() => void retry()}
              disabled={pending}
              className="ui-button h-6! min-h-6! px-2.5! text-[12px]! leading-4!"
            >
              {pending && <Loader2 size={13} className="animate-spin" />}
              Retry
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
