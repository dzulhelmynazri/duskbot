// The one quiet line a place's page shows in the desktop app when that place's server is older than the app: the page
// already hides what the server cannot answer, and this says why, once per server and app version.
import { useEffect, useState } from "react";

import { localDesktopPage } from "@/components/onboarding/WelcomeGate";
import { api } from "@/state/store";
import { appVersion } from "./app-links";
import { copyText } from "./copy-text";
import { t } from "./i18n";
import { serverBehind, useServerCompat } from "./server-compat";
import type { ServerUpdateCheck } from "./server-update";

export interface ServerBehindHint { text: string; action?: { label: string; onClick: () => void }; seen: () => void }

const seenKey = () => `madani-server-behind:${location.origin}:${appVersion()}`;

/** What the hint says for a server whose update check answered `check` (null: it did not); null for no hint at all. */
export function serverBehindHint(check: ServerUpdateCheck | null, copy: (text: string) => void): Omit<ServerBehindHint, "seen"> | null {
  // a managed Cloud is brought up to date by madani itself, and the desktop app's own server by the app
  if (check?.install === "managed" || check?.install === "desktop") return null;
  const command = check?.command?.trim();
  return { text: t("notices.serverBehind"), ...(command ? { action: { label: t("notices.serverBehind.copy"), onClick: () => copy(command) } } : {}) };
}

export function useServerBehindHint(): ServerBehindHint | null {
  const compat = useServerCompat();
  const placePage = window.madaniDesktop !== undefined && !localDesktopPage();
  const behind = placePage && serverBehind(compat);
  const [hint, setHint] = useState<Omit<ServerBehindHint, "seen"> | null>(null);
  const [done, setDone] = useState(() => { try { return window.localStorage.getItem(seenKey()) === "1"; } catch { return false; } });
  useEffect(() => {
    if (!behind || done) return;
    let active = true;
    void api<ServerUpdateCheck>("/api/updates/check", { background: true }).catch(() => null)
      .then((check) => { if (active) setHint(serverBehindHint(check, (text) => void copyText(text))); });
    return () => { active = false; };
  }, [behind, done]);
  if (!behind || done || !hint) return null;
  return { ...hint, seen: () => { try { window.localStorage.setItem(seenKey(), "1"); } catch { /* shown again next launch */ } setDone(true); } };
}
