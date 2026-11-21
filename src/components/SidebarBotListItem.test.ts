import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatTime, initialState, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));
// Advanced mode's rows: Simple mode keeps one conversation per bot, so its rows have no thread controls.

import { ConfirmDialogCard } from "./ConfirmDialog";
import { BotDeleteMenuItem } from "./BotMenuDelete";
import { BotListItem, botConfirmCopy, botRowProps, currentArchivableBot } from "./Sidebar";
import { endCall } from "@/lib/call";
import { configureLiveMedia, resetLiveMedia, startLiveCall } from "@/lib/live-call-media";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
});

function renderRow(candidate: Bot, density: "comfortable" | "icons" = "comfortable") {
  return renderToStaticMarkup(createElement(BotListItem, botRowProps(initialState, vi.fn(), candidate, { density, query: "", onMenu: vi.fn() })));
}

afterEach(() => {
  resetLiveMedia();
  endCall();
  vi.unstubAllGlobals();
});

describe("BotListItem", () => {
  it("previews the last reply, not the digest receipt that follows it", () => {
    const markup = renderRow(bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "make notes.txt", at: 1 },
        { id: "b1", role: "bot", kind: "text", text: "Created notes.txt with three lines.", at: 2 },
        { id: "d1", role: "bot", kind: "digest", text: "[digest] · tools: Write ×1", at: 3, digest: { turnId: "t1", tools: [{ name: "Write", count: 1 }], hookCoverage: "full" } },
      ] as Bot["messages"],
    }));
    expect(markup).toContain("Created notes.txt with three lines.");
    expect(markup).not.toContain("[digest]");
  });

  describe("the record of a live call that ended last", () => {
    const at = (minute: number) => new Date(2026, 9, 6, 10, minute).getTime();
    const record = {
      id: "r1", role: "bot", kind: "call", at: at(2), text: "call with Atlas · 1:42",
      call: { callId: "c1", botId: "atlas", client: "ios", startedAt: at(0), endedAt: at(2), seconds: 102, endReason: "hung-up" },
    };
    const spoken = { id: "u1", role: "user", kind: "text", text: "what is the weather", at: at(0), via: "call", callId: "c1" };
    const draw = (candidate: Bot, { selected = false, query = "" } = {}) => renderToStaticMarkup(createElement(BotListItem, botRowProps(
      selected ? { ...initialState, activeView: "chat", selectedId: candidate.id } : initialState,
      vi.fn(), candidate, { density: "comfortable", query, onMenu: vi.fn() },
    )));

    it("previews the last reply, not the record that follows it", () => {
      const markup = draw(bot({
        messages: [spoken, { id: "b1", role: "bot", kind: "text", text: "Sunny in Pune.", at: at(1) }, record] as Bot["messages"],
      }));
      expect(markup).toContain("Sunny in Pune.");
      expect(markup).not.toContain("call with Atlas");
    });

    it("previews a failed turn's row when the record follows it", () => {
      const markup = draw(bot({
        messages: [spoken, { id: "e1", role: "bot", kind: "activity", at: at(1), tool: { name: "error: this computer isn't a place on your madani cloud: its bots run in the cloud.", ok: false } }, record] as Bot["messages"],
      }));
      expect(markup).toContain("this computer isn&#x27;t a place on your madani cloud: its bots run in the cloud.");
      expect(markup).not.toContain("call with Atlas");
    });

    it("times the open row by the last reply, not by the hang-up", () => {
      const markup = draw(bot({
        messages: [spoken, { id: "b1", role: "bot", kind: "text", text: "Sunny in Pune.", at: at(1) }, record] as Bot["messages"],
      }), { selected: true });
      expect(markup).toContain(formatTime(at(1)));
      expect(markup).not.toContain(formatTime(at(2)));
    });

  });

  it("previews a failed turn without its error marker", () => {
    const markup = renderRow(bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "check the site", at: 1 },
        { id: "e1", role: "bot", kind: "activity", at: 2, tool: { name: "error: this computer isn't a place on your madani cloud: its bots run in the cloud.", ok: false } },
      ] as Bot["messages"],
    }));
    expect(markup).toContain("this computer isn&#x27;t a place on your madani cloud: its bots run in the cloud.");
    expect(markup).not.toContain("error:");
  });

  describe("an approval card that ends the chat", () => {
    const approval = (card: Partial<NonNullable<Bot["messages"][number]["card"]>>): Bot => bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "list the files", at: 1 },
        {
          id: "c1", role: "bot", kind: "options", at: 2,
          card: { title: "Approval needed", subtitle: "ls -la", options: ["allow", "deny"], requestId: "r1", tool: "Bash", ...card },
        },
      ] as Bot["messages"],
    });

    it("keeps the request's title while it is still open", () => {
      expect(renderRow(approval({}))).toContain("Approval needed");
    });

    it("says Allowed once it was allowed", () => {
      const markup = renderRow(approval({ answered: "allow" }));
      expect(markup).toContain("Allowed");
      expect(markup).not.toContain("Approval needed");
    });

    it("says Denied once it was denied, or closed by Stop", () => {
      for (const answered of ["deny", "unavailable"]) {
        const markup = renderRow(approval({ answered, dismissed: answered === "unavailable" }));
        expect(markup).toContain("Denied");
        expect(markup).not.toContain("Approval needed");
      }
    });

    it("says it got no answer in time once nothing can answer it", () => {
      const markup = renderRow(approval({ expired: true, options: [] }));
      expect(markup).toContain("No answer in time");
      expect(markup).not.toContain("Approval needed");
    });
  });

  it("leaves the full Chief card as one selectable hit area", () => {
    const markup = renderRow(bot({ chiefOfStaff: true }));

    expect(markup).toContain('data-sidebar-bot-row="atlas"');
    expect(markup).not.toContain('aria-label="Archive Atlas"');
  });


  it("draws no role for a bot without one", () => {
    for (const title of ["", "  "]) {
      const markup = renderRow(bot({ title }));
      expect(markup).not.toContain('data-testid="bot-role"');
      expect(markup).not.toContain('class="sr-only">, ');
    }
  });

  it("gives the Chief of Staff the same row as every other bot", () => {
    const portrait = (markup: string) => /width="(\d+)px" height="\d+px"/.exec(markup)?.[1];
    const rowClass = (markup: string) => /data-sidebar-bot-row="atlas" class="([^"]*)"/.exec(markup)?.[1];
    const chief = renderRow(bot({ chiefOfStaff: true, title: "Chief of staff" }));
    const plain = renderRow(bot({ title: "Developer" }));
    expect(portrait(chief)).toBe(portrait(plain));
    expect(rowClass(chief)).toBe(rowClass(plain));
  });

  it("previews the last reply as plain text, without its markdown", () => {
    const markup = renderRow(bot({
      messages: [{ id: "b1", role: "bot", kind: "text", text: "I read **[goatedgrokbotalternative/madanibot](https://github.com/goatedgrokbotalternative/madanibot)**. Run `pnpm install` first.", at: 1 }] as Bot["messages"],
    }));
    expect(markup).toContain(">I read goatedgrokbotalternative/madanibot. Run pnpm install first.<");
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("](https://");
  });

  it("marks the bot this window is on a Live call with by a green phone badge", () => {
    expect(renderRow(bot())).not.toContain('data-testid="live-call-badge"');

    vi.stubGlobal("window", { madaniDesktop: { speechStop: vi.fn(async () => {}) } });
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: "atlas", threadId: "thread-atlas" });

    const markup = renderRow(bot());
    expect(markup).toContain('data-testid="live-call-badge"');
    expect(markup).toContain('aria-label="On a live call"');
    expect(markup.indexOf('data-testid="live-call-badge"')).toBeGreaterThan(markup.indexOf(">Atlas<"));
    expect(renderRow(bot({ id: "other" }))).not.toContain('data-testid="live-call-badge"');

    const icons = renderRow(bot(), "icons");
    expect(icons).toContain('data-testid="live-call-badge"');
    expect(icons).toContain('aria-label="Atlas · On a live call"');
  });

  it("marks an idle bot waiting on a teammate with a quiet dot, never the work signals", () => {
    const markup = renderRow(bot({ waitingForTeammates: true, busy: false, activity: "idle" }));
    expect(markup).toContain('data-testid="teammate-wait-dot"');
    expect(markup).not.toContain('data-testid="working-dot"');
    expect(markup).not.toContain("animate-status-pulse");
    expect(markup).toContain("Waiting on a teammate…");
  });

});

describe("archive / delete confirmation", () => {
  it("rechecks the latest fleet after a confirmation was opened", () => {
    const snapshot = bot();
    const other = bot({ id: "other" });
    const renamed = bot({ name: "New name" });
    expect(currentArchivableBot([renamed, other], snapshot.id)).toBe(renamed);
    expect(currentArchivableBot([bot({ chiefOfStaff: true }), other], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([bot({ hidden: true }), other], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([snapshot], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([other, bot({ id: "third" })], snapshot.id)).toBeUndefined();
  });
  it("archive copy uses the menu's word and says where the bot goes", () => {
    const copy = botConfirmCopy("archive", "Juniper");

    expect(copy.title).toContain("Juniper");
    expect(copy.title).toBe("Archive Juniper?");
    expect(copy.confirmLabel).toBe("Archive");
    expect(copy.body).toMatch(/archived bots/);
    expect(copy.tone).toBe("neutral");
  });

  it("delete copy names the bot and warns about its owned computer", () => {
    const copy = botConfirmCopy("delete", "Willow");

    expect(copy.title).toContain("Willow");
    expect(copy.body).toBe("Its chats, memory, files and private desktop go too. This can't be undone.");
    expect(copy.tone).toBe("danger");
  });

  it("renders as an alert dialog with cancel and the action button", () => {
    const markup = renderToStaticMarkup(createElement(ConfirmDialogCard, {
      open: true,
      ...botConfirmCopy("delete", "Willow"),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Delete Willow?");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain(">Delete</button>");
    expect(markup).toContain("bg-danger");
  });
});

describe("bot deletion feedback", () => {
  it("disables the destructive action while the bot and its computer are deleted", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: true,
      onClick: vi.fn(),
    }));

    expect(markup).toContain("Deleting the bot and its desktop…");
    expect(markup).toContain('title="Deleting this bot and any desktop it owns"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
  });

  it("offers Delete again after the check settles", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: false,
      onClick: vi.fn(),
    }));

    expect(markup).toContain(">Delete</span></button>");
    expect(markup).not.toContain('disabled=""');
  });
});
