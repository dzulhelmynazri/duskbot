import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { DirectoryApp } from "../../shared/connector-directory.ts";
import { mcpServerNameError } from "../mcp-registry.ts";
import { composioProvider } from "./composio-provider.ts";
import { connectorDirectory, type ConnectorProvider } from "./provider.ts";
import { REMOTE_MCP_APPS, remoteMcpProvider } from "./remote-mcp.ts";

const app = (id: string, source: DirectoryApp["source"], label = id): DirectoryApp => ({
  id, source, label, description: "", categories: [], domain: null, logo: null,
});

const fixed = (id: DirectoryApp["source"], apps: DirectoryApp[], available = true): ConnectorProvider => ({
  id, available: () => available, catalog: async () => apps,
});

describe("connectorDirectory", () => {
  it("keeps one row per app, the earlier provider's", async () => {
    const answer = await connectorDirectory([
      fixed("composio", [app("notion", "composio", "Notion"), app("gmail", "composio", "Gmail")]),
      fixed("remote-mcp", [app("notion", "remote-mcp", "Notion"), app("monday", "remote-mcp", "monday.com"), app("linear", "remote-mcp")]),
    ]);
    expect(answer.apps.map((entry) => `${entry.source}:${entry.id}`)).toEqual(["composio:notion", "composio:gmail", "remote-mcp:monday", "remote-mcp:linear"]);
    expect(answer.providers).toEqual([
      { id: "composio", available: true, ok: true, count: 2 },
      { id: "remote-mcp", available: true, ok: true, count: 3 },
    ]);
  });

  it("matches the same app across providers by its name as well as its id", async () => {
    const answer = await connectorDirectory([
      fixed("composio", [app("mondaycom", "composio", "Monday")]),
      fixed("remote-mcp", [app("monday", "remote-mcp", "monday.com")]),
    ]);
    expect(answer.apps.map((entry) => entry.source)).toEqual(["composio"]);
  });

  it("never asks a provider that is not set up, and reports it", async () => {
    const catalog = vi.fn(async () => [app("gmail", "composio")]);
    const answer = await connectorDirectory([{ id: "composio", available: () => false, catalog }, remoteMcpProvider]);
    expect(catalog).not.toHaveBeenCalled();
    expect(answer.providers[0]).toEqual({ id: "composio", available: false, ok: true, count: 0 });
    expect(answer.apps).toHaveLength(REMOTE_MCP_APPS.length);
  });

  it("answers with the rest when one provider fails or hangs", async () => {
    const failing: ConnectorProvider = { id: "composio", available: () => true, catalog: async () => { throw new Error("upstream 503"); } };
    const hanging: ConnectorProvider = {
      id: "composio", available: () => true,
      catalog: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("timed out")))),
    };
    for (const broken of [failing, hanging]) {
      const answer = await connectorDirectory([broken, fixed("remote-mcp", [app("linear", "remote-mcp")])], 50);
      expect(answer.apps.map((entry) => entry.id)).toEqual(["linear"]);
      expect(answer.providers[0]).toMatchObject({ id: "composio", available: true, ok: false, count: 0 });
      expect(answer.providers[0]!.error).toMatch(/503|timed out/);
    }
  });
});

describe("remote MCP apps", () => {
  it("are valid server names on vendor https endpoints, once each", () => {
    expect(new Set(REMOTE_MCP_APPS.map((entry) => entry.id)).size).toBe(REMOTE_MCP_APPS.length);
    for (const entry of REMOTE_MCP_APPS) {
      expect(mcpServerNameError(entry.id), entry.id).toBeNull();
      const url = new URL(entry.url!);
      expect(url.protocol).toBe("https:");
      expect(url.search + url.hash + url.username).toBe("");
      expect(entry.domain).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
      expect(["oauth", "none"]).toContain(entry.auth);
    }
  });
});

describe("composioProvider against a mocked Composio API", () => {
  let api: Server;
  const seen: Array<{ path: string; key: string | undefined }> = [];
  const previous = process.env.MADANI_COMPOSIO_TOOLKITS_API;

  beforeAll(async () => {
    api = createServer((req, res) => {
      seen.push({ path: req.url ?? "", key: req.headers["x-api-key"] as string | undefined });
      const page = new URL(req.url ?? "/", "http://x").searchParams.get("cursor") === "p2" ? 2 : 1;
      const items = page === 1
        ? [{ slug: "gmail", name: "Gmail", meta: { description: "Send and read mail", logo: "https://logos.composio.dev/api/gmail", categories: [{ name: "Communication" }] } },
          { slug: "notion", name: "Notion", meta: { description: "Docs", categories: [] } }]
        : [{ slug: "hackernews", name: "Hacker News", no_auth: true, meta: { description: "Stories" } }];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items, current_page: page, total_pages: 2, total_items: 3, next_cursor: page === 1 ? "p2" : null }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    process.env.MADANI_COMPOSIO_TOOLKITS_API = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/v3`;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.MADANI_COMPOSIO_TOOLKITS_API;
    else process.env.MADANI_COMPOSIO_TOOLKITS_API = previous;
    await new Promise((resolve) => api.close(resolve));
  });

  it("is off without a key or broker", () => {
    expect(composioProvider({ composio: {} } as AppConfig).available()).toBe(false);
  });

  it("lists every page of the marketplace with the project key, and composio keeps the apps it shares", async () => {
    const cfg = { composio: { apiKey: "proj-test-key" } } as AppConfig;
    const provider = composioProvider(cfg);
    expect(provider.available()).toBe(true);
    const answer = await connectorDirectory([provider, remoteMcpProvider]);
    expect(seen.map((request) => request.path)).toEqual([
      "/api/v3/toolkits?limit=500&sort_by=usage",
      "/api/v3/toolkits?limit=500&sort_by=usage&cursor=p2",
    ]);
    expect(seen.every((request) => request.key === "proj-test-key")).toBe(true);
    const composio = answer.apps.filter((entry) => entry.source === "composio");
    expect(composio.map((entry) => entry.id)).toEqual(["gmail", "notion", "hackernews"]);
    expect(composio[0]).toMatchObject({ label: "Gmail", description: "Send and read mail", logo: "https://logos.composio.dev/api/gmail" });
    expect(answer.apps.find((entry) => entry.id === "notion")?.source).toBe("composio");
    expect(answer.apps.find((entry) => entry.id === "linear")?.source).toBe("remote-mcp");
    expect(JSON.stringify(answer)).not.toContain("proj-test-key");
  });
});
