import { describe, expect, it } from "vitest";
import { madaniChooser, madaniRoutingPrompt, parseMadaniChoice } from "./madani-chooser.ts";
import { decideRoomResponder } from "./room-routing.ts";

const input = {
  room: "Launch", humans: ["Sam"],
  members: [{ id: "nova", name: "Nova" }, { id: "quill", name: "Quill", title: "Writer" }, { id: "ray", name: "Ray" }],
  recent: [{ from: "Sam", text: "hi" }],
  message: { from: "Sam", text: "Quill and Ray, your parts please" },
};

describe("Madani decides", () => {
  it("reads one key, several joined by +, and refuses keys it does not know", () => {
    expect(parseMadaniChoice('sure: {"choice": "quill", "confidence": 0.9}', ["quill", "ray"])).toEqual({ choice: "quill", pTop: 0.9 });
    expect(parseMadaniChoice('{"choice": "quill + ray"}', ["quill", "ray"])).toEqual({ choice: "quill+ray", pTop: 0.7 });
    expect(parseMadaniChoice('{"choice": "pixel"}', ["quill"])).toBeNull();
    expect(parseMadaniChoice("no json", ["quill"])).toBeNull();
  });

  it("shares the room router's contract: one member, several, everyone, or the fallback", async () => {
    const answer = (reply: string) => madaniChooser(() => async () => reply);
    expect(await decideRoomResponder(answer('{"choice":"quill","confidence":0.8}'), input)).toEqual({ kind: "member", botId: "quill", probability: 0.8, provider: "madani" });
    expect(await decideRoomResponder(answer('{"choice":"quill+ray","confidence":0.8}'), input)).toEqual({ kind: "members", botIds: ["quill", "ray"], probability: 0.8, provider: "madani" });
    expect(await decideRoomResponder(answer('{"choice":"__everyone__","confidence":0.9}'), input)).toMatchObject({ kind: "everyone" });
    expect(await decideRoomResponder(answer('{"choice":"quill","confidence":0.2}'), input)).toEqual({ kind: "fallback", reason: "low_confidence" });
    expect(await decideRoomResponder(madaniChooser(() => null), input)).toEqual({ kind: "fallback", reason: "disabled" });
    expect(await decideRoomResponder(madaniChooser(() => async () => { throw new Error("down"); }), input)).toEqual({ kind: "fallback", reason: "malformed" });
  });

  it("asks with the members' options and the chat as data", () => {
    const prompt = madaniRoutingPrompt({ new_message: { text: "hi" } }, { instructions: "Who answers?", options: { quill: "Quill, Writer bot.", __everyone__: "Several" } });
    expect(prompt).toContain("- quill: Quill, Writer bot.");
    expect(prompt).toContain('joined with "+"');
    expect(prompt).toContain('{"new_message":{"text":"hi"}}');
  });
});
