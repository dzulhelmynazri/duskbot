// The link protocol between this server and the link agent beside it on a linked VPS (apps/link-service/agent.mjs): the
// agent reads it from /.well-known/madanibot/environment and passes it on to the app, which says what to update.

/**
 * What this server speaks with its link agent. A change that an older agent cannot work with raises `protocol` and
 * the oldest agent kept, `minAgent`; an optional addition never does (the agent checks for the field itself).
 */
export interface LinkProtocolInfo {
  protocol: number;
  minAgent: number;
}

export const SERVER_LINK_PROTOCOL = 1;
export const MIN_AGENT_LINK_PROTOCOL = 1;

export function linkProtocolInfo(): LinkProtocolInfo {
  return { protocol: SERVER_LINK_PROTOCOL, minAgent: MIN_AGENT_LINK_PROTOCOL };
}
