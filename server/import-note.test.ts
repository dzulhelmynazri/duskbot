import { describe, expect, it } from "vitest";

import { importNoteSchema } from "../shared/import-note.ts";
import { importedSoul } from "../shared/imported-soul.ts";
import { importNoteText } from "./import-note.ts";

describe("the first bot's note after a bring-in", () => {
  it("says briefly what came in and where it went, in sentence case, never an em dash", () => {
    const text = importNoteText({
      from: ["Hermes Agent", "Claude Code"], bots: ["Hermes", "Coder", "Code Reviewer"], facts: 3, memories: 5, skills: 4, tools: 2,
      routines: 2, instructions: ["Claude Code"], reconnect: 1,
    })!;
    expect(text).toBe([
      "I brought in what you had in Hermes Agent and Claude Code:",
      "- 3 new bots: Hermes, Coder, and Code Reviewer",
      "- 3 things about you, now in about me",
      "- 5 memories, kept in memory",
      "- Your instructions from Claude Code, in my notes",
      "- 4 skills",
      "- 2 tools, switched off until you turn them on in apps",
      "",
      "2 routines came over paused: switch one on when you want it. Connect 1 app again in apps for the bot that used it. Ask me about any of it.",
    ].join("\n"));
    expect(text).not.toMatch(/\u2014/);
  });

  it("as the bringing in starts, says it got them and is setting things up", () => {
    expect(importNoteText({ from: ["ChatGPT"], start: true })).toBe("Got it. Setting up your bots, memories and routines now…");
  });

  it("says it found the notes in Downloads when they came by themselves", () => {
    expect(importNoteText({ from: ["ChatGPT"], facts: 4, via: "downloads" })).toMatch(/^I found your notes from ChatGPT in Downloads and brought them in:\n- 4 things about you/);
  });

  it("is nothing when nothing came in, and takes counts and names only", () => {
    expect(importNoteText({ from: ["Codex"] })).toBeNull();
    expect(importNoteSchema.safeParse({ from: ["Codex"], text: "anything I like" }).success).toBe(false);
    expect(importNoteSchema.safeParse({ from: [] }).success).toBe(false);
    expect(importNoteSchema.parse({ from: ["  Hermes\u0000 Agent "] }).from).toEqual(["Hermes Agent"]);
  });
});

describe("an imported bot's instructions", () => {
  const facts = { name: "Scout", title: "Researcher", description: "Finds sources.", instructions: "Always cite sources.", from: "OpenClaw",
    topics: ["memory/openclaw-setup.md"], skills: ["sources"], routines: ["News sweep"], apps: ["Linear"], aboutMe: true };

  it("keep the source's words whole inside the working shape", () => {
    const soul = importedSoul(facts, 24_000);
    for (const part of ["## What you are for\nYou are Scout, Researcher. Finds sources.", "## Your instructions from OpenClaw\nAlways cite sources.",
      "## What you know", "memory/openclaw-setup.md", "in their about me", "## Skills", "sources", "## Routines\nThese came over paused: News sweep.",
      "## Apps\nIn OpenClaw you used Linear.", "## Limits", "## Reporting back"]) expect(soul).toContain(part);
    expect(soul).not.toMatch(/\u2014|\bMadani\b/);
  });

  it("fit the limit by cutting the source's words from the end, and say so", () => {
    const soul = importedSoul({ ...facts, instructions: "x".repeat(30_000) }, 24_000);
    expect(new TextEncoder().encode(soul).length).toBeLessThanOrEqual(24_000);
    expect(soul).toContain("(The rest of the original was too long to keep here.)");
    expect(soul).toContain("## Reporting back");
    expect(importedSoul({ ...facts, instructions: "" }, 24_000)).toContain("OpenClaw kept no written instructions for you.");
  });
});
