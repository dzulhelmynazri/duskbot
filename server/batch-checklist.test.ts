import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checklistDir, checklistPath, counts, formatChecklist, openItems, parseChecklist, progressLine, readChecklist, startChecklist, tick, writeChecklist,
} from "./batch-checklist.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const people = (n: number) => Array.from({ length: n }, (_, i) => `@person${i + 1}`);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(removeTempDir)); });

describe("a bot's progress checklist", () => {
  it("round-trips through its Markdown file, notes and verb included", () => {
    let list = startChecklist(null, { title: "DM the webinar signups", items: people(3), verb: "sent" });
    list = tick(list, ["@person1"], "done").list;
    list = tick(list, ["person2"], "skipped", "DMs closed").list;
    const text = formatChecklist(list);
    expect(text).toContain("- [x] @person1\n- [~] @person2 (skipped: DMs closed)\n- [ ] @person3");
    expect(parseChecklist(text)).toEqual(list);
    expect(progressLine(list)).toBe("1 of 3 sent, 1 skipped");
  });

  it("never unticks an item when the same list is started again while items are still open", () => {
    let list = startChecklist(null, { title: "DMs", items: people(94), verb: "sent" });
    list = tick(list, people(12), "done").list;
    const again = startChecklist(list, { title: "DMs", items: people(94).slice(5) });
    expect(counts(again)).toEqual({ done: 12, skipped: 0, open: 82, total: 94 });
    expect(openItems(again)).not.toContain("@person1");
    expect(again.verb).toBe("sent");
  });

  it("starts fresh once the earlier list is finished", () => {
    let list = startChecklist(null, { title: "DMs", items: people(2) });
    list = tick(list, people(2), "done").list;
    expect(counts(startChecklist(list, { title: "Round two", items: people(2) })).open).toBe(2);
  });

  it("matches an item however its handle is spelled, and reports repeats and strangers", () => {
    const list = tick(startChecklist(null, { title: "DMs", items: ["@Alice", "@bob"] }), ["@alice"], "done").list;
    const again = tick(list, ["ALICE", "@carol"], "done");
    expect(again.ticked).toEqual([]);
    expect(again.already).toEqual(["@Alice"]);
    expect(again.unknown).toEqual(["@carol"]);
  });

  it("reads a list the bot edited by hand, and keeps its file in the conversation's task workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "madani-checklist-"));
    dirs.push(root);
    const dir = checklistDir(root, "bot1", "thread1")!;
    expect(checklistDir(root, "../bot", "thread1")).toBeNull();
    writeChecklist(dir, startChecklist(null, { title: "DMs", items: people(2) }));
    writeFileSync(checklistPath(dir), "# DMs\n\n- [X] @person1\n* [ ] @person2\n");
    expect(counts(readChecklist(dir)!)).toEqual({ done: 1, skipped: 0, open: 1, total: 2 });
    expect(readChecklist(join(root, "none"))).toBeNull();
  });
});
