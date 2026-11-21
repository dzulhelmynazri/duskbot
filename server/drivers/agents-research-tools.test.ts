import { describe, expect, it, vi } from "vitest";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { WEB_SEARCH_NOT_CONFIGURED } from "../web-search-many.ts";

describe("web_search_many on the agents server", () => {
  it("is listed only with the research credential and availability switches", () => {
    for (const x of ["0", "1"]) for (const research of ["0", "1"]) {
      const listed = availableTools(catalogProfileFromEnv({ MADANI_X_RESEARCH: x, MADANI_RESEARCH: research }));
      expect(listed.some((tool) => tool.name === "web_search_many")).toBe(x === "1" && research === "1");
      if (x === "1" && research === "1") expect(listed.find((tool) => tool.name === "web_search_many")).toMatchObject({ annotations: { readOnlyHint: true, openWorldHint: true } });
    }
  });

  it("routes a batch to the harness and renders unconfigured search as one non-error line", async () => {
    const apiResponse = vi.fn(async () => ({ ok: true, status: 200, body: { message: WEB_SEARCH_NOT_CONFIGURED } }));
    const context: ToolCallContext = { botId: "bot", threadId: "thread", depth: 0, externalRuntime: false, client: { api: vi.fn(), apiResponse } };
    expect(await callTool("web_search_many", { queries: ["one", "two"] }, context)).toEqual({ text: WEB_SEARCH_NOT_CONFIGURED });
    expect(apiResponse).toHaveBeenCalledWith("/api/internal/research/web-search-many", { method: "POST", body: JSON.stringify({ queries: ["one", "two"] }) });
    apiResponse.mockClear();
    expect(await callTool("web_search_many", { queries: Array(11).fill("query") }, context)).toMatchObject({ isError: true });
    expect(apiResponse).not.toHaveBeenCalled();
  });
});

describe("web_search_many results as text", () => {
  it("lists each page once, numbered, with what each query cost or that it was reused", async () => {
    const { searchResultsText } = await import("./agents-research-tools.ts");
    const page = (n: number, url = `https://site${n}.com/a`) => ({ title: `Page ${n}`, url, snippet: `About ${n}.` });
    const result = searchResultsText([
      { query: "notion pricing", results: [page(1), page(2)], cost: "$0.0010" },
      { query: "coda pricing", results: [page(3), { ...page(1), url: "https://www.site1.com/a/?ref=x" }], cached: true },
      { query: "broken", results: [], error: "Web search failed. Try again shortly." },
    ]);
    expect(result).toEqual({ text: [
      "## notion pricing ($0.0010)",
      "1. Page 1\n   https://site1.com/a\n   About 1.",
      "2. Page 2\n   https://site2.com/a\n   About 2.",
      "## coda pricing (reused from a search minutes ago, no charge)",
      "3. Page 3\n   https://site3.com/a\n   About 3.",
      "Also here: #1 above.",
      "## broken",
      "Failed: Web search failed. Try again shortly.",
    ].join("\n") });
  });

  it("is a failed call only when every query failed", async () => {
    const { searchResultsText } = await import("./agents-research-tools.ts");
    expect(searchResultsText([{ query: "a", results: [], error: "Web search failed. Try again shortly." }])).toMatchObject({ isError: true });
  });
});

