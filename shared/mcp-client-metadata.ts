// madani bot's OAuth client ID metadata document (MCP 2025-11-25 authorization, draft-ietf-oauth-client-id-metadata-document):
// a vendor that advertises client_id_metadata_document_supported fetches this URL as our client id, so madani bot signs in
// without registering per vendor. Served by the account service on madani.bot; its redirect is one fixed loopback port.

export const MCP_CLIENT_ID = "https://madani.bot/v1/oauth/mcp-client.json";
export const MCP_CLIENT_METADATA_PATH = "/v1/oauth/mcp-client.json";
/** The only port a metadata-document sign-in returns to: the document lists exactly this redirect. */
export const MCP_CLIENT_METADATA_PORT = 47615;
export const MCP_CLIENT_METADATA_REDIRECT = `http://127.0.0.1:${MCP_CLIENT_METADATA_PORT}/mcp-oauth/callback`;

/** Vendors that register any client but admit only reviewed ones or a metadata document past their sign-in page. */
export const MCP_CLIENT_METADATA_FIRST: ReadonlySet<string> = new Set(["https://mcp.vercel.com"]);

export const MCP_CLIENT_METADATA = {
  client_id: MCP_CLIENT_ID,
  client_name: "madani bot",
  client_uri: "https://madani.bot",
  logo_uri: "https://madani.bot/art/icon-512.png",
  redirect_uris: [MCP_CLIENT_METADATA_REDIRECT],
  application_type: "native",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
} as const;
