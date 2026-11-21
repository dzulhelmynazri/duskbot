import { useEffect, useState } from "react";
import type { CloudFilesBridge, CloudFilesState } from "../../electron/cloud-sync.mjs";

/** Shared folders live in this computer's own window: a companion connected to another computer has none. */
export function cloudFilesBridge(): CloudFilesBridge | undefined {
  return window.madaniDesktop?.remoteClient?.active ? undefined : window.madaniDesktop?.cloudAccount?.files;
}

/** Main's Files state, kept current; null until main answers (and when main can't). */
export function useCloudFiles(bridge: CloudFilesBridge | undefined) {
  const [state, setState] = useState<CloudFilesState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true, pushed = false;
    const off = bridge.onState((next) => { pushed = true; if (live) setState(next); });
    void bridge.state().then((next) => { if (live && !pushed) setState(next); }).catch(() => {});
    return () => { live = false; off(); };
  }, [bridge]);
  return [state, setState] as const;
}
