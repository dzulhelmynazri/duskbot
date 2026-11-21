import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const { ToolActivity } = await import("./ToolActivity");
const { ActivityRun } = await import("./ActivityRun");

const render = (tool: Parameters<typeof ToolActivity>[0]["tool"]) => renderToStaticMarkup(createElement(ToolActivity, { tool }));

describe("ToolActivity", () => {
  it("names the step in plain words and keeps the tool's own name in the details", () => {
    const html = render({ name: "mcp__madani__computer_batch", ok: true, input: '{"actions":[]}' });
    expect(html).toContain("Use the screen · Completed · tool details");
    expect(html).toMatch(/<span class="min-w-0 max-w-\[30rem\] truncate font-medium leading-5">Use the screen<\/span>/);
    expect(html).toContain('data-testid="tool-name"');
    expect(html).toContain("mcp__madani__computer_batch");
  });

  it("shows the line the harness wrote for an MCP server change, with the tool's name in the details", () => {
    const html = render({ name: "mcp__agents__mcp_server", label: "added MCP server linear · turned on · Test: needs sign-in", ok: true });
    expect(html).toContain("added MCP server linear · turned on · Test: needs sign-in · Completed · tool details");
    expect(html).toMatch(/data-testid="tool-name">mcp__agents__mcp_server</);
  });

  it("keeps a command off the row, where it reads as a plain step", () => {
    const html = render({ name: "Bash", ok: false, summary: "pnpm test --filter api", input: "pnpm test --filter api" });
    expect(html).toContain("Run a command · Failed · tool details");
    expect(html).not.toContain('title="pnpm test --filter api"');
  });

  it("names a Composio slug by its action", () => {
    expect(render({ name: "GITHUB_GET_A_COMMIT", ok: true })).toContain("Get a commit · Completed");
  });
});

describe("ActivityRun", () => {
  const steps = [
    { id: "a", at: 1, role: "bot" as const, kind: "activity" as const, tool: { name: "Bash", ok: true, summary: "ls" } },
    { id: "b", at: 2, role: "bot" as const, kind: "activity" as const, tool: { name: "ls -la /tmp", ok: true, summary: "ls -la /tmp" } },
    { id: "c", at: 3, role: "bot" as const, kind: "activity" as const, tool: { name: "mcp__madani__screenshot", ok: true } },
  ];

  it("sums a folded run up in plain words", () => {
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: null }));
    expect(html).toContain("3 steps · Run a command ×2, Look at the screen");
  });
});

describe("ActivityRun at narrow widths", () => {
  it("lets the run's row shrink and truncate its summary instead of running off the screen", () => {
    const steps = [
      { id: "a", at: 1, role: "bot" as const, kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "b", at: 2, role: "bot" as const, kind: "activity" as const, tool: { name: "mcp__madani__screenshot", ok: true } },
    ];
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: null }));
    expect(html).toMatch(/<button[^>]*class="-ms-2 flex min-w-0 max-w-full /);
    expect(html).toContain('class="min-w-0 max-w-[480px] truncate leading-5"');
  });
});
