import { externalOpener } from "./app-links";

export interface PendingAuthorization {
  url: string;
  createdAt: number;
}

/** Composio authorization links expire after ten minutes; reopening the page must not renew the clock. */
export const AUTHORIZATION_LINK_MS = 10 * 60 * 1_000;

export function reusableConnectionUrl(page: PendingAuthorization | null | undefined, now = Date.now()): string | null {
  return page && now >= page.createdAt && now - page.createdAt < AUTHORIZATION_LINK_MS ? page.url : null;
}

/** True inside the desktop app, where every page opens in the system browser rather than a tab. */
export const opensPagesExternally = () => Boolean(window.madaniDesktop);

/** Reserve the tab during the click, before an authorization request consumes the browser's user activation. */
export function reserveConnectionPage() {
  const openExternal = externalOpener();
  // a workspace page in the desktop app has no openExternal, and its window.open always comes back null because the
  // app hands the link to the system browser (no popup blocker there), so it opens the real link, never a blank
  const handsOff = !openExternal && opensPagesExternally();
  let page: Window | null = null;
  let navigated = false;
  let cancelled = false;
  if (!openExternal && !handsOff) {
    try {
      page = window.open("", "_blank");
      if (page) page.opener = null;
    } catch {
      page?.close();
      page = null;
    }
  }
  return {
    async open(url: string): Promise<boolean> {
      if (cancelled) return false;
      if (openExternal) {
        await openExternal(url);
        return !cancelled;
      }
      if (handsOff) {
        window.open(url, "_blank", "noopener,noreferrer");
        return true;
      }
      if (!page || page.closed) return false;
      try {
        page.location.replace(url);
        navigated = true;
        return true;
      } catch {
        return false;
      }
    },
    cancel() {
      cancelled = true;
      if (!navigated && page && !page.closed) page.close();
    },
    /** The page we navigated was closed by the person; false when it went to the system browser, where we cannot tell. */
    closed(): boolean {
      return navigated && page !== null && page.closed;
    },
  };
}
