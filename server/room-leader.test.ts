import { describe, expect, it } from "vitest";
import { LEADER_MAX_ROUNDS, LEADER_MAX_TASKS, leaderCapRefusal, leaderSystemNote, memberSystemNote, roomLeaderId } from "./room-leader.ts";
import { normalizeGroupDefaultResponder } from "./store.ts";
import { checkedGroupResponder } from "./routes/groups.ts";

const room = (defaultResponder: any, memberIds = ["nova", "quill"], dm = false) => ({ defaultResponder, memberIds, dm });

describe("a group's leader", () => {
  it("is the member a leader responder names, only while it is in the room and never in a direct chat", () => {
    expect(roomLeaderId(room({ kind: "member", botId: "nova", leader: true }))).toBe("nova");
    expect(roomLeaderId(room({ kind: "member", botId: "nova" }))).toBeUndefined();
    expect(roomLeaderId(room({ kind: "member", botId: "gone", leader: true }))).toBeUndefined();
    expect(roomLeaderId(room({ kind: "member", botId: "nova", leader: true }, ["nova", "quill"], true))).toBeUndefined();
    expect(roomLeaderId(room({ kind: "everyone" }))).toBeUndefined();
  });

  it("survives saving, and a leader who left hands the room to the first member", () => {
    expect(normalizeGroupDefaultResponder({ kind: "member", botId: "quill", leader: true }, ["nova", "quill"])).toEqual({ kind: "member", botId: "quill", leader: true });
    expect(normalizeGroupDefaultResponder({ kind: "member", botId: "gone", leader: true }, ["nova", "quill"])).toEqual({ kind: "member", botId: "nova", leader: true });
    expect(normalizeGroupDefaultResponder({ kind: "auto", by: "madani", fallbackBotId: "quill" }, ["nova", "quill"])).toEqual({ kind: "auto", fallbackBotId: "quill", by: "madani" });
    expect(checkedGroupResponder({ kind: "member", botId: "quill", leader: true }, ["nova", "quill"])).toEqual({ kind: "member", botId: "quill", leader: true });
    expect(checkedGroupResponder({ kind: "member", botId: "quill", leader: "yes" }, ["nova", "quill"])).toBeNull();
    expect(checkedGroupResponder({ kind: "auto", by: "someone" }, ["nova"])).toBeNull();
    expect(checkedGroupResponder({ kind: "auto", by: "madani" }, ["nova"])).toEqual({ kind: "auto", by: "madani" });
  });

  it("is told who is on the team with ids and roles, and how to hand off; members are told who they work for", () => {
    const note = leaderSystemNote({ id: "nova", name: "Nova" }, [
      { id: "nova", name: "Nova" }, { id: "quill", name: "Quill", title: "Writer" }, { id: "ray", name: "Ray", description: "Draws\nbanners" }, { id: "x", name: "Hidden", hidden: true },
    ], "Sam");
    expect(note).toContain("Sam talks with you");
    expect(note).toContain("- Quill [id: quill]: Writer");
    expect(note).toContain("- Ray [id: ray]: Draws banners");
    expect(note).not.toContain("Hidden");
    expect(note).not.toContain("[id: nova]");
    expect(note).toContain("coordinate_bots");
    expect(memberSystemNote("Nova", "Launch")).toContain('working for Nova, who leads the group "Launch"');
    // a check-in to the whole group gets one combined answer, and a member's report is plain talk
    expect(note).toContain("When Sam asks the whole group something");
    expect(note).toContain("you answer once for the team");
    expect(memberSystemNote("Nova", "Launch")).toContain('No headers and no "Status update" preamble');
    expect(note + memberSystemNote("Nova", "Launch")).not.toContain(String.fromCharCode(0x2014));
  });

  it("caps rounds and tasks for one message", () => {
    expect(leaderCapRefusal({ round: 1, tasksSoFar: 0, adding: 2 })).toBeNull();
    expect(leaderCapRefusal({ round: LEADER_MAX_ROUNDS, tasksSoFar: 2, adding: 1 })).toBeNull();
    expect(leaderCapRefusal({ round: LEADER_MAX_ROUNDS + 1, tasksSoFar: 2, adding: 1 })).toContain("the limit");
    expect(leaderCapRefusal({ round: 2, tasksSoFar: LEADER_MAX_TASKS - 1, adding: 2 })).toContain(`the limit is ${LEADER_MAX_TASKS}`);
  });
});
