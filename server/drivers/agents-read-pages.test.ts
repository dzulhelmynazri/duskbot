import { describe, expect, it, vi } from "vitest";

import { agentsServerEnv, engineHasNativeWeb, type AgentsConversation } from "../agents-turn.ts";
import type { PageRead } from "../page-reader.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { callReadPages } from "./agents-read-pages.ts";

const HOST: AgentsConversation["host"] = { skillAuthoring: false, cloudHome: false, team: false, voiceNotes: false, x: true, research: true };
const listedFor = (engine: string | undefined) => {
  const env = agentsServerEnv({ threadId: "t", bot: { id: "b" }, room: false, teamComputer: false, host: HOST, engine }, { generation: "g", depth: 0, skillAuthoring: false }, () => "token", "http://127.0.0.1:9");
  return availableTools(catalogProfileFromEnv(env)).map((tool) => tool.name);
};

describe("web tools by engine", () => {
  it("never offers the paid web_search_many where the engine searches for free, and offers read_pages where it cannot fetch", () => {
    expect(engineHasNativeWeb("claudeAgent")).toBe(true);
    expect(engineHasNativeWeb("codex")).toBe(true);
    for (const engine of ["claudeAgent", "codex"]) {
      const names = listedFor(engine);
      expect(names, engine).not.toContain("web_search_many");
      expect(names, engine).not.toContain("read_pages");
      expect(names, engine).toContain("x_search");
    }
    for (const engine of ["openai-compat", "groq", "mistral", "pi"]) {
      const names = listedFor(engine);
      expect(names, engine).toContain("web_search_many");
      expect(names, engine).toContain("read_pages");
    }
  });

  it("is off unless the harness says so, and read_pages runs beside other reads", () => {
    const plain = availableTools(catalogProfileFromEnv({ MADANI_X_RESEARCH: "1", MADANI_RESEARCH: "1" }));
    expect(plain.map((tool) => tool.name)).toContain("web_search_many");
    expect(plain.map((tool) => tool.name)).not.toContain("read_pages");
    const reader = availableTools(catalogProfileFromEnv({ MADANI_PAGE_READER: "1" })).find((tool) => tool.name === "read_pages");
    expect(reader).toMatchObject({ annotations: { readOnlyHint: true, openWorldHint: true } });
  });
});

describe("read_pages", () => {
  const page = (url: string, text: string, extra: Partial<PageRead> = {}): PageRead => ({ ok: true, url, title: "T", text, cut: false, ...extra } as PageRead);

  it("reads pages concurrently, once each, and cuts a long one with the exact call that reads on", async () => {
    const read = vi.fn(async (url: string) => page(url, url.endsWith("long") ? "a".repeat(40_000) : "short text"));
    const { text, isError } = await callReadPages({ urls: ["https://x.org/long", "https://x.org/short", "https://x.org/short"] }, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(isError).toBeUndefined();
    expect(text).toContain("## T (https://x.org/short)\nshort text");
    expect(text).toContain(`[Cut at character 11000 of 40000. Read on with read_pages {"urls":["https://x.org/long"],"offset":11000}]`);
    expect(text.length).toBeLessThan(24_000);
    const next = await callReadPages({ urls: ["https://x.org/long"], offset: 11_000 }, read);
    expect(next.text).toContain("(from character 11000)");
    expect(next.text).toContain(`"offset":26000`);
  });

  it("keeps the pages that worked when one fails, and fails only when all do", async () => {
    const read = async (url: string): Promise<PageRead> => url.includes("bad") ? { ok: false, url, error: "nope" } : page(url, "fine");
    expect(await callReadPages({ urls: ["https://bad.org/", "https://ok.org/"] }, read)).toEqual({ text: expect.stringContaining("Failed: nope") });
    expect(await callReadPages({ urls: ["https://bad.org/"] }, read)).toMatchObject({ isError: true });
    expect(await callReadPages({ urls: [] }, read)).toMatchObject({ isError: true });
  });

  it("refuses a private address through the real fetch", async () => {
    expect(await callReadPages({ urls: ["http://169.254.169.254/latest/meta-data/"] })).toMatchObject({ isError: true, text: expect.stringContaining("private network") });
  });
});
