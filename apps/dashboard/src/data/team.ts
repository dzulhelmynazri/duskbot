import type { TeamJoinAnswer, TeamView } from "../../../../shared/billing-api";
import { api } from "../lib/api";
import { appPath, withBase } from "../lib/router";

export const TEAM_JOIN_PATH = "/team/join";
const INVITE_KEY = "madani-team-invite";

const call = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => api.raw<T>(path, method, body);

export const teamApi = {
  get: () => call<{ team: TeamView | null }>("/v1/team").then((answer) => answer.team),
  invite: (email: string) => call<{ team: TeamView }>("/v1/team/invites", "POST", { email }).then((answer) => answer.team),
  cancel: (id: string) => call<{ team: TeamView }>(`/v1/team/invites/${encodeURIComponent(id)}`, "DELETE", {}).then((answer) => answer.team),
  remove: (email: string) => call<{ team: TeamView }>(`/v1/team/members/${encodeURIComponent(email)}`, "DELETE", {}).then((answer) => answer.team),
  join: (token: string) => call<TeamJoinAnswer>("/v1/team/join", "POST", { token }).then((answer) => answer.team),
};

/** the invite token lives in the link's fragment; it is taken out of the address before anything reports the page */
export function stashTeamInvite() {
  const m = /^#t=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (m && appPath(location.pathname) === TEAM_JOIN_PATH) {
    try { sessionStorage.setItem(INVITE_KEY, m[1]!); } catch {}
    history.replaceState(null, "", withBase(TEAM_JOIN_PATH));
  }
}
export function teamInvite(): string | null { try { return sessionStorage.getItem(INVITE_KEY); } catch { return null; } }
export function dropTeamInvite() { try { sessionStorage.removeItem(INVITE_KEY); } catch {} }
