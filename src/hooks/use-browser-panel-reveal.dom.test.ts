// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishLiveFrame } from "@/lib/live-events";
import type { ServerFrame } from "../../shared/wire";

const { useBrowserPanelReveal } = await import("./use-browser-panel-reveal");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dispatch = vi.fn();
function Probe({ panel }: { panel: string | null }) {
  useBrowserPanelReveal({ bot: { id: "madani", threadId: "t1", browser: true }, active: true, panel, dispatch });
  return null;
}
const started = (title: string, turnId: string, threadId = "t1") => publishLiveFrame({ kind: "runtime", event: {
  eventId: `${turnId}-${title}`, provider: "claudeAgent", threadId, turnId, createdAt: new Date().toISOString(), type: "item.started", itemType: "tool", title,
} } as ServerFrame);

let root: ReturnType<typeof createRoot> | null = null;
const render = async (panel: string | null) => { await act(async () => root!.render(createElement(Probe, { panel }))); };

beforeEach(() => {
  dispatch.mockClear();
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = { platform: "darwin" };
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; });

describe("the bot starting to browse in a turn", () => {
  it("opens the panel's Computer tab at its first browser call, once per turn, with no wait", async () => {
    await render(null);
    started("Bash", "turn-a");
    expect(dispatch).not.toHaveBeenCalled();
    started("mcp__browser__agent_browser_open", "turn-a");
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleComputer", open: true });
    started("mcp__browser__agent_browser_snapshot", "turn-a");
    expect(dispatch).toHaveBeenCalledTimes(1);
    started("mcp__browser__agent_browser_open", "turn-b");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("leaves another conversation's browsing, and a panel tab the person chose, alone", async () => {
    await render(null);
    started("mcp__browser__agent_browser_open", "turn-c", "other-thread");
    await render("memory");
    started("mcp__browser__agent_browser_open", "turn-d");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
