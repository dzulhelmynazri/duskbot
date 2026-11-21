import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { placeKind } from "../connection/connection-notice";
import type { MobileAccount } from "./account-client";

/** Who the phone is, as Settings says it: one answer from the account session and the places the phone links.
 * `account`: signed in to that madani bot account, from its session or, without one, from a madani cloud it lists;
 * `cloud`: linked to a madani cloud whose account the phone has not learned yet (still that account's, never signed out);
 * `computer`: only computers paired with their own QR or code, which need no account; `none`: nothing linked. */
export type PhoneIdentity =
  | { kind: "account"; email: string; session: boolean }
  | { kind: "cloud"; name: string }
  | { kind: "computer"; name: string }
  | { kind: "none" };

type Place = Pick<MobileConnectionRecord, "id" | "label" | "origin" | "via" | "account">;

export function phoneIdentity({ account, connections, activeId }: {
  account: Pick<MobileAccount, "email"> | null | undefined;
  connections: readonly Place[];
  activeId: string | null;
}): PhoneIdentity {
  if (account?.email) return { kind: "account", email: account.email, session: true };
  const shownFirst = [...connections].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
  const clouds = shownFirst.filter((place) => placeKind(place) === "cloud");
  const known = clouds.find((place) => place.account?.email);
  if (known?.account) return { kind: "account", email: known.account.email, session: false };
  if (clouds[0]) return { kind: "cloud", name: clouds[0].label };
  if (shownFirst[0]) return { kind: "computer", name: shownFirst[0].label };
  return { kind: "none" };
}
