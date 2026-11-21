import { expect, it } from "vitest";
import { linkRanges } from "./link-ranges";

const found = (text: string) => linkRanges(text).map(({ start, end, href }) => [text.slice(start, end), href]);

it("finds full addresses, www. and bare domains", () => {
  expect(found("see https://madani.bot/docs?a=1#b, www.example.org, notion.so and example.com/path.")).toEqual([
    ["https://madani.bot/docs?a=1#b", "https://madani.bot/docs?a=1#b"],
    ["www.example.org", "https://www.example.org"],
    ["notion.so", "https://notion.so"],
    ["example.com/path", "https://example.com/path"],
  ]);
});

it("keeps a bracket the address opened and drops one around it", () => {
  expect(found("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
    ["https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"],
  ]);
});

it("skips file names, emails and words with dots", () => {
  expect(found("open README.md, run main.py, mail me@example.com, e.g. v1.2 index.ts node.js")).toEqual([]);
});

it("leaves a bare scheme alone while it is still being typed", () => {
  expect(found("https://")).toEqual([]);
});
