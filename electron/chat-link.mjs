// madanibot://thread/<thread-id>?bot=<bot-id>, madanibot://bot/<bot-id> and madanibot://apps/<app-id> (the account website's
// connect, opening that app's page in Connect Apps). The page checks them strictly against its chats and its app
// catalog; opening one never sends, interrupts, creates or connects anything.
const CHAT_LINK_PREFIXES = ["madanibot://thread/", "madanibot://bot/"];
const APP_LINK = /^madanibot:\/\/apps\/[a-z0-9][a-z0-9_.-]{0,79}\/?$/i;
const MAX_LINK_LENGTH = 1024;

export function chatLinkFrom(value) {
  const link = typeof value === "string" ? value.trim() : "";
  if (link.length > MAX_LINK_LENGTH) return null;
  const lower = link.toLowerCase();
  return CHAT_LINK_PREFIXES.some((prefix) => lower.startsWith(prefix)) || APP_LINK.test(link) ? link : null;
}

export function chatLinkFromCommandLine(argv) {
  for (const value of argv) {
    const link = chatLinkFrom(value);
    if (link) return link;
  }
  return null;
}
