/** The level of the HTTP API a server speaks to the app, sent as `capabilities.api` in GET
 * /.well-known/madanibot/environment. A server from before levels sends none. Raise it when the app starts needing a route
 * an older server lacks, and add that feature to SERVER_FEATURES at the new level. */
export const SERVER_API_LEVEL = 1;

/** Each optional part of the app and the lowest API level whose server can answer it. Anything not listed works on
 * every server the desktop app still opens. */
export const SERVER_FEATURES = {
  /** GET /api/usage/allowance and its notice: the weekly allowance. */
  allowance: 1,
  /** GET /api/connectors/directory: the vendors' own MCP servers in Connect apps. */
  connectorDirectory: 1,
  /** GET /api/computer/egress: route a linked VPS's traffic through this computer. */
  computerEgress: 1,
  /** GET /api/updates/digest: "Updated to 1.4.2" once after a self-update. */
  updateDigest: 1,
} as const;

export type ServerFeature = keyof typeof SERVER_FEATURES;

/** The phone app's own level (apps/mobile, this build). Raise it when the phone starts needing what an older server
 * lacks: a VPS or madani cloud server updates itself to catch up, so the phone shows nothing for that. */
export const MOBILE_APP_LEVEL = 1;
/** The oldest phone app level this server still serves, sent as `capabilities.minMobile`. Raise it only when a route an
 * older phone app calls changes shape; that phone then shows one line with a way to the store. */
export const MIN_MOBILE_APP_LEVEL = 1;

/** Whether a server's descriptor says this phone app is too old for it; a server that does not say never refuses. */
export function phoneTooOld(descriptor: unknown, level: number = MOBILE_APP_LEVEL): boolean {
  const min = (descriptor as { capabilities?: { minMobile?: unknown } } | null)?.capabilities?.minMobile;
  return Number.isInteger(min) && (min as number) > level;
}

/** The level a descriptor says, or null for a server from before levels (it still answers everything it has). */
export function serverApiLevel(descriptor: unknown): number | null {
  const api = (descriptor as { capabilities?: { api?: unknown } } | null)?.capabilities?.api;
  return Number.isInteger(api) && (api as number) >= 0 ? (api as number) : null;
}

/** Whether a server at `level` has `feature`: null (unknown) when the server predates levels. */
export function levelHas(level: number | null, feature: ServerFeature): boolean | null {
  return level === null ? null : level >= SERVER_FEATURES[feature];
}
