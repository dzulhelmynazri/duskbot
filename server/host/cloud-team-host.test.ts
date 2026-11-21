import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { workspaceDir } from "../workspace.ts";
import { createCloudTeamHost } from "./cloud-team-host.ts";

function host(team: { id: string; name: string } | null) {
  const starters = new Map([["ada-chat", "p_ada"], ["cleo-chat", "p_cleo"], ["main-chat", "nobody"]]);
  return createCloudTeamHost({
    team, dataDir: mkdtempSync(join(tmpdir(), "madani-team-host-")),
    store: { groupByThread: (threadId) => (threadId === "room-chat" ? { id: "launch" } : undefined) },
    starters, markers: new Set(["nobody"]),
  });
}

describe("whose browser a conversation uses", () => {
  it("on a Team Cloud: the member's for her private chat, the group chat's, the team's for the bot's main chat", () => {
    const team = host({ id: "team-acme-1", name: "Acme" });
    expect(team.browserAudience("ada-chat")).toBe("member:p_ada");
    expect(team.browserAudience("cleo-chat")).toBe("member:p_cleo");
    expect(team.browserAudience("room-chat")).toBe("room:launch");
    expect(team.browserAudience("main-chat")).toBe("team");
  });

  it("elsewhere: always the bot's own, whoever opened the conversation", () => {
    const mine = host(null);
    for (const thread of ["ada-chat", "room-chat", "main-chat"]) expect(mine.browserAudience(thread)).toBe("team");
    expect(mine.viewerBrowserAudience({ threadId: "cleo-chat", sees: () => false, person: "p_ada" })).toBe("team");
  });
});

describe("whose browser a person's live view shows", () => {
  const team = host({ id: "team-acme-1", name: "Acme" });
  const sees = (visible: string[]) => (threadId: string) => visible.includes(threadId);

  it("the conversation's they look at, when they may read it; none for one hidden from them", () => {
    expect(team.viewerBrowserAudience({ threadId: "ada-chat", sees: sees(["ada-chat"]), person: "p_ada" })).toBe("member:p_ada");
    expect(team.viewerBrowserAudience({ threadId: "ada-chat", sees: sees(["ada-chat", "cleo-chat"]), person: "p_ben" }), "an admin reading Ada's chat sees Ada's browser").toBe("member:p_ada");
    expect(team.viewerBrowserAudience({ threadId: "cleo-chat", sees: sees(["ada-chat"]), person: "p_ada" })).toBeNull();
    expect(team.viewerBrowserAudience({ threadId: "room-chat", sees: sees(["room-chat"]), person: "p_cleo" })).toBe("room:launch");
  });

  it("their own with no conversation named (the phone's view), and the team's for a session that names no person", () => {
    expect(team.viewerBrowserAudience({ threadId: null, sees: () => false, person: "p_ada" })).toBe("member:p_ada");
    expect(team.viewerBrowserAudience({ threadId: null, sees: () => true, person: null })).toBe("team");
  });
});

describe("which of a bot's folders a conversation's box puts back", () => {
  const made = (team: { id: string; name: string } | null) => {
    const dataDir = mkdtempSync(join(tmpdir(), "madani-team-host-"));
    const chats = join(dataDir, "task-workspaces", "scout");
    for (const thread of ["ada-chat", "ada-later", "cleo-chat", "main-chat", "team-later", "room-chat"]) mkdirSync(join(chats, thread), { recursive: true });
    const starters = new Map([["ada-chat", "p_ada"], ["ada-later", "p_ada"], ["cleo-chat", "p_cleo"], ["main-chat", "nobody"]]);
    const host = createCloudTeamHost({
      team, dataDir, starters, markers: new Set(["nobody"]),
      store: { groupByThread: (threadId) => (threadId === "room-chat" ? { id: "launch" } : undefined) },
    });
    return { host, dataDir, chats };
  };

  it("off a team: every conversation folder of the bot, so a file from an earlier chat is still there", () => {
    const { host, chats } = made(null);
    expect(host.boxFolders("scout", "main-chat")).toEqual([chats]);
  });

  it("on a team: only the bot's conversations with the same audience, never another member's or a room's", () => {
    const { host, chats } = made({ id: "team-acme-1", name: "Acme" });
    expect(host.boxFolders("scout", "main-chat")).toEqual([join(chats, "team-later")]);
    expect(host.boxFolders("scout", "ada-chat")).toEqual([workspaceDir("scout--member-p_ada"), join(chats, "ada-later")]);
    expect(host.boxFolders("scout", "room-chat")).toEqual([workspaceDir("scout--room-launch")]);
  });
});
