import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { FUN_AFTER_MS, FUN_FULL_MS, WORD_POOLS, friendlyNowPhrases, funChance, funWords, plainWord, poolWords, startsAnywhere, toolService, workingWord, type PoolName } from "./friendly-activity";

const running = (name: string, extra: Partial<NonNullable<Message["tool"]>> = {}): Message =>
  ({ id: "m", role: "bot", kind: "activity", at: 1, tool: { name, ...extra } });

const NORMAL = ["Thinking", "Working", "On it", "Getting it done", "Figuring it out", "Almost there"];

describe("Simple mode's working line", () => {
  it("says plain words while nothing is reported, with the fun ones kept apart", () => {
    const generic = friendlyNowPhrases(null);
    expect(generic.phase).toBe("friendly:generic");
    expect(generic.phrases).toEqual(NORMAL);
    expect(generic.fun).toEqual(expect.arrayContaining(["Pondering", "Percolating", "Shenaniganing", "Whipping up", "Stargazing", "Scheming"]));
    expect(generic.fun).toHaveLength(28);
    expect(generic.fun!.some((word) => NORMAL.includes(word)), "the two pools never share a word").toBe(false);
    expect(friendlyNowPhrases({ activity: "thinking" })).toEqual({ phase: "friendly:thinking", phrases: NORMAL, fun: generic.fun });
    expect(startsAnywhere(generic.phase) && startsAnywhere("friendly:thinking")).toBe(true);
    expect(startsAnywhere("friendly:commands"), "a step leads with what it is").toBe(false);
    expect(plainWord("thinking")).toBe("Thinking");
    expect(plainWord("working")).toBe("Working");
  });

  it("keeps every word short (four at most), Sentence case, with no dots, emoji or machine talk", () => {
    const words = [...(Object.keys(WORD_POOLS) as PoolName[]).filter((name) => name !== "publish").flatMap((name) => poolWords(name)), ...funWords()];
    for (const word of words) {
      expect(word.split(" ").length, word).toBeLessThanOrEqual(4);
      expect(word, "sentence case").toMatch(/^[A-Z][^A-Z]*$/);
      expect(word).not.toMatch(/[.…]|\p{Extended_Pictographic}|\bAI\b|processing|loading/iu);
    }
  });

  it("puts a step's own word first: a kind of work never says a generic or fun word", () => {
    const loose = new Set([...poolWords("generic"), ...funWords()]);
    for (const shown of [
      friendlyNowPhrases({ activity: "command", itemId: "x", target: "scrape.py" }),
      friendlyNowPhrases({ activity: "web", itemId: "s", target: "standing desks" }),
      friendlyNowPhrases({ activity: "fetch", itemId: "f", target: "linkedin.com" }),
      friendlyNowPhrases({ activity: "write", file: "index.html", itemId: "w" }),
      friendlyNowPhrases(null, running("mcp__playwright__browser_click")),
    ]) {
      expect(shown.phase).not.toBe("friendly:generic");
      expect(shown.fun, "fun words only sprinkle into plain work").toBeUndefined();
      for (const word of shown.phrases) expect(loose.has(word), word).toBe(false);
    }
  });

  it("names the kind of work in the owner's plain words, never a file name or size", () => {
    const said = (status: Parameters<typeof friendlyNowPhrases>[0], message?: Message) => friendlyNowPhrases(status, message).phrases;
    expect(friendlyNowPhrases({ activity: "reply" })).toEqual({ phase: "friendly:chat.typing", phrases: ["Writing", "Wrapping up"] });
    expect(said({ activity: "web", itemId: "s" })).toEqual(["Searching"]);
    expect(said({ activity: "fetch", itemId: "f" })).toEqual(["Reading"]);
    expect(said({ activity: "command", itemId: "x" })).toEqual(["Running a command"]);
    expect(said({ activity: "write", file: "index.html", bytes: 14_000, itemId: "w" })).toEqual(["Writing code"]);
    expect(said({ activity: "write", file: "notes.md", itemId: "w" })).toEqual(["Saving"]);
    expect(said({ activity: "edit", file: "notes.md", itemId: "e" })).toEqual(["Editing files"]);
    expect(said({ activity: "read", file: "notes.md", itemId: "r" })).toEqual(["Checking files"]);
    expect(said(null, running("Bash"))).toEqual(["Running a command"]);
    expect(said(null, running("mcp__computer__click"))).toEqual(["Clicking"]);
    expect(said(null, running("mcp__playwright__browser_click"))).toEqual(["Clicking"]);
    expect(said(null, running("mcp__playwright__browser_type"))).toEqual(["Typing"]);
    expect(said(null, running("mcp__playwright__browser_fill_form"))).toEqual(["Filling a form"]);
    expect(said(null, running("mcp__playwright__browser_navigate"))).toEqual(["Opening a page"]);
    expect(said(null, running("mcp__playwright__browser_snapshot"))).toEqual(["Browsing"]);
    expect(said(null, running("mcp__computer__screenshot"))).toEqual(["Looking at the screen"]);
    expect(said(null, running("computer"))).toEqual(["Using the computer"]);
    expect(said(null, running("mcp__madani__search_memory"))).toEqual(["Remembering"]);
    expect(said(null, running("delegate_bot"))).toEqual(["Asking a teammate"]);
  });

  it("reads a step by its tool, not the narration the server writes for calls", () => {
    expect(friendlyNowPhrases(null, running("Bash", { spoken: "Running the test suite" })).phrases[0]).toBe("Running a command");
  });

  it("never says the command, search or address itself, as grok's line does not", () => {
    const said = [
      friendlyNowPhrases({ activity: "command", itemId: "x", target: "scrape.py" }),
      friendlyNowPhrases({ activity: "web", itemId: "s", target: "Acme construction leads" }),
      friendlyNowPhrases(null, running("WebFetch", { step: { activity: "fetch", target: "linkedin.com" } })),
      friendlyNowPhrases(null, running("Write", { step: { activity: "write", target: "report.md" } })),
    ].flatMap((shown) => shown.phrases).join("|");
    expect(said).not.toMatch(/scrape\.py|Acme|linkedin|report\.md/);
  });

  it("says which outside service the bot is working in", () => {
    expect(toolService("mcp__notion__search")).toBe("Notion");
    expect(toolService("mcp__composio__GMAIL_SEND_EMAIL")).toBe("Gmail");
    expect(toolService("mcp__github__create_pull_request"), "a known app keeps its own spelling").toBe("GitHub");
    expect(toolService("mcp__composio__HUBSPOT_SEARCH")).toBe("HubSpot");
    expect(toolService("mcp__madani__ask_user")).toBeNull();
    expect(toolService("Bash")).toBeNull();
    expect(friendlyNowPhrases(null, running("mcp__notion__search")).phrases).toEqual(["Working in Notion"]);
  });
});

describe("the plain line's words over a turn", () => {
  const fun = funWords();
  /** A turn's words, one every 3 s from its opening, as the line says them. */
  const walk = (seed: string, seconds: number) => {
    const said: string[] = [];
    for (let step = 0; step * 3 <= seconds; step++) said.push(workingWord(NORMAL, fun, seed, step, step * 3_000, said.at(-1)));
    return said;
  };
  const seeds = Array.from({ length: 40 }, (_, index) => `bot:thread:${index}|friendly:generic`);

  it("opens every turn with Thinking", () => {
    for (const seed of seeds) expect(workingWord(NORMAL, fun, seed, 0, 0)).toBe("Thinking");
  });

  it("says only plain words in a short turn", () => {
    for (const seed of seeds) for (const word of walk(seed, 14)) expect(NORMAL, `${seed}: ${word}`).toContain(word);
  });

  it("mixes fun words into a long turn, about 1 in 4 after 15 s and 1 in 2 past a minute", () => {
    expect(funChance(FUN_AFTER_MS - 1)).toBe(0);
    expect(funChance(FUN_AFTER_MS)).toBe(0.25);
    expect(funChance(FUN_FULL_MS)).toBe(0.5);
    expect(funChance(10 * FUN_FULL_MS)).toBe(0.5);
    const share = (from: number, to: number) => {
      let playful = 0, all = 0;
      for (const seed of seeds) {
        for (let step = 1; step < 400; step++) {
          const at = from + ((to - from) * step) / 400;
          if (fun.includes(workingWord(NORMAL, fun, seed, step, at))) playful++;
          all++;
        }
      }
      return playful / all;
    };
    expect(share(FUN_AFTER_MS, FUN_AFTER_MS + 1)).toBeGreaterThan(0.2);
    expect(share(FUN_AFTER_MS, FUN_AFTER_MS + 1)).toBeLessThan(0.3);
    expect(share(2 * FUN_FULL_MS, 3 * FUN_FULL_MS)).toBeGreaterThan(0.45);
    expect(share(2 * FUN_FULL_MS, 3 * FUN_FULL_MS)).toBeLessThan(0.55);
    for (const seed of seeds.slice(0, 5)) expect(walk(seed, 180).some((word) => fun.includes(word)), seed).toBe(true);
  });

  it("never says one word twice in a row", () => {
    for (const seed of seeds) {
      const said = walk(seed, 600);
      for (let i = 1; i < said.length; i++) expect(said[i], `${seed} step ${i}`).not.toBe(said[i - 1]);
    }
  });

  it("is the same walk for the same turn, and a different one for another", () => {
    expect(walk(seeds[0]!, 120)).toEqual(walk(seeds[0]!, 120));
    expect(new Set(seeds.slice(0, 6).map((seed) => walk(seed, 120).join("|"))).size).toBeGreaterThan(1);
  });
});
