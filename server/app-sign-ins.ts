// App sign-ins handed out and not finished yet (a Composio link the person is signing in through). A madani cloud that
// sleeps when idle stays up while one is open (cloud power's `maintenance`), so the sign-in it handed back is not cut
// off by an idle sleep a few minutes in, and the dashboard sees the app land once it is connected.
import { appSlug } from "../shared/dashboard-protocol.ts";

/** How long one open sign-in holds the cloud up at most: Google's consent with a second factor fits well inside. */
export const APP_SIGN_IN_HOLD_MS = 10 * 60_000;

export function createAppSignIns(now: () => number = Date.now, holdMs = APP_SIGN_IN_HOLD_MS) {
  const open = new Map<string, number>();
  return {
    /** a sign-in page went out for this app */
    started(slug: string) {
      const id = appSlug(slug);
      if (id) open.set(id, now() + holdMs);
    },
    /** apps that are connected now: their sign-in is over */
    settled(connected: Iterable<string>) {
      for (const slug of connected) { const id = appSlug(slug); if (id) open.delete(id); }
    },
    active(): boolean {
      const at = now();
      for (const [id, until] of open) if (until <= at) open.delete(id);
      return open.size > 0;
    },
  };
}

export type AppSignIns = ReturnType<typeof createAppSignIns>;
