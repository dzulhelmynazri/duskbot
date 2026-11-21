export const SLACK_WIRE_VERSION = 1;
export const SLACK_APPS_URL = "https://api.slack.com/apps";
export const SLACK_DEFAULT_REDIRECT_URL = "https://link.madani.bot/slack/callback";
export const SLACK_OAUTH_DEEP_LINK = "madanibot://slack/oauth";
/** Connection state of the workspace configuration token. */
export type SlackWorkspaceState = "not_connected" | "connected" | "needs_reconnect";
/** Public workspace connection status, without credentials. */
export interface SlackWorkspaceStatus {
  version: 1; state: SlackWorkspaceState; teamId?: string; teamName?: string;
  /** epoch ms the current configuration token expires */
  expiresAt?: number; error?: string;
  /** bots that hold a Slack app in this workspace */
  apps: number;
  /** false until the harness can read its secret store (the desktop key arrives a moment after start) */
  ready: boolean;
}
/** Installation and connection state of one bot's Slack app. */
export type SlackBotState = "not_linked" | "provisioned" | "installed" | "online" | "offline" | "error";
/** Public bot status, without credentials. */
export interface SlackBotStatus {
  version: 1; botId: string; state: SlackBotState; appId?: string; teamId?: string; teamName?: string;
  botUserId?: string; handle?: string; error?: string;
  /** https://api.slack.com/apps/<appId>/general, where the person generates the app-level token */
  appTokenUrl?: string;
  /** opens the bot's DM in Slack: https://app.slack.com/client/<teamId>/<dm or app id> style link, https only */
  openUrl?: string;
}
/** Provisioned bot status and its Slack authorization link. */
export interface SlackProvisionResponse { status: SlackBotStatus; authorizeUrl: string }
/** Slack app settings where the person generates the app-level token. */
export const slackAppTokenUrl = (appId: string) => `https://api.slack.com/apps/${encodeURIComponent(appId)}/general`;
const unprintable = (text: string) => [...text].some((character) => character <= " " || character === "\u007f");
/** The callback's deep link parsed strictly: a code and a state, or Slack's error and the state. */
export function parseSlackOAuthLink(value: unknown): { code: string; state: string } | { error: string; state: string } | null {
  if (typeof value !== "string" || value.length > 2048 || unprintable(value) || !value.startsWith(`${SLACK_OAUTH_DEEP_LINK}?`)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "madanibot:" || url.host !== "slack" || url.pathname !== "/oauth" || url.username || url.password || url.hash || value.includes("#")) return null;
    if ([...url.searchParams.values()].some((value) => unprintable(value))) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 2 || new Set(keys).size !== 2 || keys.some((key) => !["code", "error", "state"].includes(key))) return null;
    const state = url.searchParams.get("state");
    if (!state || !/^[0-9a-f]{64}$/.test(state)) return null;
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (code !== null && error === null && /^[A-Za-z0-9._-]{8,256}$/.test(code)) return { code, state };
    if (error !== null && code === null && /^[a-z_]{1,64}$/.test(error)) return { error, state };
    return null;
  } catch {
    return null;
  }
}
