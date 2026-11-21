import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DOCUMENT_MAX_BYTES, DOCUMENT_VERSIONS_KEPT, documentCard, documentFileName, markdownLines, parseSheet, sheetExportCsv } from "../shared/documents.ts";
import { BotDocuments } from "./bot-documents.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTempDir)); });

function store() {
  const root = mkdtempSync(join(tmpdir(), "madani-documents-"));
  roots.push(root);
  let clock = 1_000;
  return { documents: new BotDocuments(root, () => (clock += 10)), root };
}

const created = (result: ReturnType<BotDocuments["create"]>) => {
  if (!result.ok) throw new Error(result.error);
  return result.document;
};

describe("a bot's documents", () => {
  it("creates, lists newest first and reads one back", () => {
    const { documents } = store();
    const plan = created(documents.create("bot1", { title: "  Launch   plan ", kind: "markdown", content: "# Plan\n\nShip it." }, "bot"));
    const sheet = created(documents.create("bot1", { title: "Leads", kind: "sheet", content: "name,email\nAda,a@x.io\nLin,l@x.io\n" }, "bot"));
    expect(plan).toMatchObject({ title: "Launch plan", kind: "markdown", version: 1, by: "bot", versions: [] });
    expect(sheet).toMatchObject({ rows: 2, columns: 2 });
    expect(documents.list("bot1").map((doc) => doc.id)).toEqual([sheet.id, plan.id]);
    expect(documents.list("bot2")).toEqual([]);
    expect(documents.get("bot1", plan.id)?.content).toBe("# Plan\n\nShip it.");
    expect(documents.get("bot2", plan.id)).toBeNull();
  });

  it("refuses a bad title, kind, size or path", () => {
    const { documents } = store();
    expect(documents.create("bot1", { title: "", kind: "markdown", content: "x" }, "bot")).toMatchObject({ ok: false, status: 400 });
    expect(documents.create("bot1", { title: "A", kind: "pdf", content: "x" }, "bot")).toMatchObject({ ok: false, status: 400 });
    expect(documents.create("bot1", { title: "A", kind: "markdown", content: "x".repeat(DOCUMENT_MAX_BYTES + 1) }, "bot")).toMatchObject({ ok: false, status: 413 });
    expect(documents.create("../evil", { title: "A", kind: "markdown", content: "x" }, "bot")).toMatchObject({ ok: false, status: 404 });
    expect(documents.get("bot1", "../../etc/passwd")).toBeNull();
  });

  it("keeps earlier versions, the newest few, and brings one back as a new version", () => {
    const { documents } = store();
    const doc = created(documents.create("bot1", { title: "Notes", kind: "markdown", content: "v1" }, "bot"));
    for (let n = 2; n <= DOCUMENT_VERSIONS_KEPT + 3; n++) documents.update("bot1", doc.id, { content: `v${n}` }, n % 2 ? "bot" : "person");
    const now = documents.get("bot1", doc.id)!;
    expect(now.version).toBe(DOCUMENT_VERSIONS_KEPT + 3);
    expect(now.versions).toHaveLength(DOCUMENT_VERSIONS_KEPT);
    expect(now.versions[0]!.version).toBe(DOCUMENT_VERSIONS_KEPT + 2);
    const restored = documents.restore("bot1", doc.id, DOCUMENT_VERSIONS_KEPT + 2, "person");
    expect(restored).toMatchObject({ ok: true, document: { content: `v${DOCUMENT_VERSIONS_KEPT + 2}`, version: DOCUMENT_VERSIONS_KEPT + 4, by: "person" } });
    expect(documents.restore("bot1", doc.id, 1, "person")).toMatchObject({ ok: false, status: 404 });
  });

  it("renames without a new version, refuses a stale edit and deletes", () => {
    const { documents } = store();
    const doc = created(documents.create("bot1", { title: "Notes", kind: "markdown", content: "a" }, "bot"));
    expect(documents.update("bot1", doc.id, { title: "Renamed" }, "person")).toMatchObject({ ok: true, document: { title: "Renamed", version: 1 } });
    documents.update("bot1", doc.id, { content: "b" }, "bot");
    expect(documents.update("bot1", doc.id, { content: "c", expectedVersion: 1 }, "person")).toMatchObject({ ok: false, status: 409 });
    expect(documents.remove("bot1", doc.id)).toBe(true);
    expect(documents.remove("bot1", doc.id)).toBe(false);
    expect(documents.list("bot1")).toEqual([]);
  });
});

describe("document cards and files", () => {
  it("previews Markdown as plain lines and a sheet as its first rows", () => {
    expect(markdownLines("# Title\n\n- **Bold** item\n```\ncode\n```\n| a | b |\n|---|---|\n> [link](http://x)\n1. last\n2. extra")).toEqual(["Title", "Bold item", "| a | b |", "link"]);
    const meta = { id: "d_000000000000", botId: "b", title: "T", kind: "sheet" as const, bytes: 1, rows: 5, columns: 6, createdAt: 1, updatedAt: 2, version: 1, by: "bot" as const };
    const card = documentCard(meta, "a,b,c,d,e,f\n1,2,3,4,5,6\n1,2,3,4,5,6\n1,2,3,4,5,6\n1,2,3,4,5,6", "created");
    expect(card.grid).toHaveLength(4);
    expect(card.grid![0]).toEqual(["a", "b", "c", "d"]);
  });

  it("parses loose CSV into an even grid and quotes formulas on export", () => {
    expect(parseSheet("a,b,c\n1\n\n2,3")).toEqual([["a", "b", "c"], ["1", "", ""], ["2", "3", ""]]);
    expect(parseSheet("")).toEqual([[""]]);
    expect(sheetExportCsv([["=SUM(A1)", "-12.5"]])).toBe("\"'=SUM(A1)\",-12.5");
    expect(documentFileName("Q3: plan/draft", "sheet")).toBe("Q3_ plan_draft.csv");
  });
});
