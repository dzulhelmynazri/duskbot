import { useEffect } from "react";
import { api } from "@/state/api";
import { parseSlackOAuthLink } from "../../shared/slack.ts";
import type { SlackBotStatus } from "../../shared/slack.ts";

export const SLACK_OAUTH_EVENT = "madanibot:slack-oauth";
export type SlackOAuthResult = { ok: true; status: SlackBotStatus } | { ok: false; error: string };

const postOAuth = (path: string, body: unknown) => api<{ status: SlackBotStatus }>(path, {
  method: "POST", body: JSON.stringify(body), timeoutMs: 30000,
});

export async function completeSlackOAuth(
  link: string,
  post: (path: string, body: unknown) => Promise<unknown> = postOAuth,
): Promise<SlackOAuthResult | null> {
  const parsed = parseSlackOAuthLink(link);
  if (!parsed) return null;
  let result: SlackOAuthResult;
  if ("error" in parsed) {
    result = { ok: false, error: parsed.error === "access_denied" ? "denied" : parsed.error };
  } else {
    try {
      const response = await post("/api/slack/oauth", { code: parsed.code, state: parsed.state }) as { status: SlackBotStatus };
      result = { ok: true, status: response.status };
    } catch (cause) {
      const failure = cause as { body?: { error?: unknown }; error?: unknown } | null;
      const error = failure?.body?.error ?? failure?.error;
      result = { ok: false, error: typeof error === "string" ? error : "failed" };
    }
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SLACK_OAUTH_EVENT, { detail: result }));
  return result;
}

export function useSlackOAuthLinks(): void {
  useEffect(() => window.madaniDesktop?.onSlackOAuth?.((link) => void completeSlackOAuth(link)), []);
}

export function useSlackOAuthResult(onResult: (result: SlackOAuthResult) => void): void {
  useEffect(() => {
    const receive = (event: Event) => onResult((event as CustomEvent<SlackOAuthResult>).detail);
    window.addEventListener(SLACK_OAUTH_EVENT, receive);
    return () => window.removeEventListener(SLACK_OAUTH_EVENT, receive);
  }, [onResult]);
}
