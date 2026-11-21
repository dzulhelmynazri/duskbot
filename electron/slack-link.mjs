const PREFIX = "madanibot://slack/oauth?";

export function slackOAuthLinkFrom(value) {
  if (typeof value !== "string") return null;
  const link = value.trim();
  if (link.length > 2048 || !link.startsWith(PREFIX)) return null;
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== "madanibot:" || url.host !== "slack" || url.pathname !== "/oauth" || url.username || url.password || url.hash || link.includes("#")) return null;
  const params = url.searchParams;
  const keys = [...params.keys()];
  if (keys.length !== 2 || new Set(keys).size !== 2 || keys.some((key) => !["code", "error", "state"].includes(key))) return null;
  if (!/^[0-9a-f]{64}$/.test(params.get("state") ?? "")) return null;
  const valid = params.has("code")
    ? /^[A-Za-z0-9._-]{8,256}$/.test(params.get("code") ?? "")
    : /^[a-z_]{1,64}$/.test(params.get("error") ?? "");
  return valid ? link : null;
}

export function slackOAuthLinkFromCommandLine(argv) {
  for (const value of argv) {
    const link = slackOAuthLinkFrom(value);
    if (link) return link;
  }
  return null;
}

export function createSlackOAuthLinks({ reveal, send }) {
  let pending = null;
  function deliver() {
    if (pending && send(pending) === true) pending = null;
  }
  function queue(rawLink) {
    const link = slackOAuthLinkFrom(rawLink);
    if (!link) return false;
    pending = link;
    reveal();
    deliver();
    return true;
  }
  return { queue, fromCommandLine: (argv) => queue(slackOAuthLinkFromCommandLine(argv)), deliver };
}
