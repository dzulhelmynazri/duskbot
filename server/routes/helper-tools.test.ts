// The decide and extract tools' internal route: a plain "not set up", strict shapes, files only from the bot's own
// folders, and typed answers. The decider and extractor are fakes: no model is called.
import { mkdtempSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { Decider } from "../decider/index.ts";
import type { Extractor } from "../extractor/index.ts";
import { createHelperToolRoutes, HELPER_MESSAGES, type HelperToolContext } from "./helper-tools.ts";
import { openMessageFile } from "../message-file.ts";
import { pdfFixture } from "../testing/pdf-fixture.ts";
import { PASS } from "./table.ts";

const home = mkdtempSync(join(tmpdir(), "madani-helper-tools-"));
const work = join(home, "work");
const elsewhere = join(home, "elsewhere");
mkdirSync(work);
mkdirSync(elsewhere);
writeFileSync(join(work, "invoice.txt"), "Invoice INV-2291, total $1,080.00");
writeFileSync(join(work, "receipt.png"), Buffer.from("iVBORw0KGgo=", "base64"));
writeFileSync(join(work, "scan.pdf"), "%PDF-1.7");
writeFileSync(join(elsewhere, "secret.txt"), "not yours");

type Ask = Decider["ask"];
type Extract = Extractor["extract"];

async function call(path: string, body: unknown, deps: { ask?: Ask; extract?: Extract; folders?: HelperToolContext["folders"]; openAttachment?: HelperToolContext["openAttachment"] } = {}) {
  const ask = vi.fn<Ask>(deps.ask ?? (async () => ({ ok: false, reason: "disabled" } as never)));
  const extract = vi.fn<Extract>(deps.extract ?? (async () => ({ ok: false, reason: "disabled" })));
  const route = createHelperToolRoutes({ decider: { ask: ask as unknown as Ask }, extractor: { extract } });
  const json = vi.fn();
  const res = new EventEmitter() as never;
  const outcome = await route({ method: "POST", path, res, json, botId: "bot-1", readBody: async () => body,
    folders: deps.folders ?? (async () => ({ roots: [work], vmWorkspace: null })), openAttachment: deps.openAttachment });
  const [, status, payload] = json.mock.calls[0] ?? [];
  return { outcome, status: status as number | undefined, payload: payload as { text?: string; error?: string } | undefined, ask, extract };
}

const QUESTIONS = {
  team: { type: "choice", instructions: "Which team?", options: { billing: "Money", technical: "Outages" } },
  urgent: { type: "yesno", instructions: "Is it urgent?" },
};

describe("decide", () => {
  it("says plainly that it is not set up, and how to set it up", async () => {
    const { status, payload } = await call("/api/internal/helpers/decide", { state: "Checkout is down", questions: QUESTIONS });
    expect(status).toBe(409);
    expect(payload?.error).toBe(HELPER_MESSAGES.decideOff);
    expect(payload?.error).toContain("Settings → Decision and extraction");
  });

  it("asks as botDecide, carefully, and answers with rounded probabilities", async () => {
    const { status, payload, ask } = await call("/api/internal/helpers/decide", { state: "Checkout is down", questions: QUESTIONS }, {
      ask: (async () => ({
        ok: true, provider: "workersai", latencyMs: 40,
        answers: { team: { type: "choice", choice: "technical", pTop: 0.9512, margin: 0.9, probabilities: { technical: 0.9512, billing: 0.0488 } }, urgent: { type: "yesno", p: 0.934 } },
      })) as never,
    });
    expect(status).toBe(200);
    expect(ask).toHaveBeenCalledWith("botDecide", "Checkout is down", {
      team: { type: "choice", instructions: "Which team?", options: { billing: "Money", technical: "Outages" } },
      urgent: { type: "yesno", instructions: "Is it urgent?" },
    }, expect.objectContaining({ careful: true }));
    const [line] = payload!.text!.split("\n");
    expect(JSON.parse(line!)).toEqual({
      answers: { team: { choice: "technical", p: 0.95, probabilities: { technical: 0.95, billing: 0.05 } }, urgent: { yes: 0.93 } },
      by: "Cloudflare Workers AI",
    });
  });

  it.each([
    ["no questions", { state: "x", questions: {} }, "questions must be"],
    ["a choice with no options", { state: "x", questions: { a: { type: "choice", instructions: "Which?" } } }, "a choice needs options"],
    ["an unknown type", { state: "x", questions: { a: { type: "guess", instructions: "Which?" } } }, "type is choice, yesno or score"],
    ["nine questions", { state: "x", questions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, { type: "yesno", instructions: "Is it?" }])) }, "Keep to 8 questions"],
    ["an empty state", { state: "", questions: QUESTIONS }, "Keep to 8 questions"],
  ])("refuses %s before any model is asked", async (_name, body, error) => {
    const { status, payload, ask } = await call("/api/internal/helpers/decide", body);
    expect(status).toBe(400);
    expect(payload?.error).toContain(error);
    expect(ask).not.toHaveBeenCalled();
  });

  it("too large says so, and that the same again will not work", async () => {
    const { status, payload } = await call("/api/internal/helpers/decide", { state: "x", questions: QUESTIONS }, { ask: (async () => ({ ok: false, reason: "too_large", status: 413 })) as never });
    expect(status).toBe(502);
    expect(payload?.error).toMatch(/too large .* will not work/);
  });

  it("a failing model says what to do, never the vendor's words", async () => {
    const { status, payload } = await call("/api/internal/helpers/decide", { state: "x", questions: QUESTIONS }, { ask: (async () => ({ ok: false, reason: "rate_limited", status: 429 })) as never });
    expect(status).toBe(502);
    expect(payload?.error).toMatch(/used up for now/);
  });
});

describe("extract", () => {
  const FIELDS = { total: { type: "number" }, paid: { type: "boolean" } };
  const answered: Extract = async () => ({ ok: true, provider: "jev", values: { total: 1080, paid: null }, latencyMs: 30 });

  it("says plainly that it is not set up", async () => {
    const { status, payload } = await call("/api/internal/helpers/extract", { fields: FIELDS, text: "Total $1,080" });
    expect(status).toBe(409);
    expect(payload?.error).toBe(HELPER_MESSAGES.extractOff);
  });

  it("reads text as botExtract and answers with typed values", async () => {
    const { status, payload, extract } = await call("/api/internal/helpers/extract", { fields: FIELDS, text: "Total $1,080" }, { extract: answered });
    expect(status).toBe(200);
    expect(extract).toHaveBeenCalledWith("botExtract", FIELDS, { text: "Total $1,080" }, expect.anything());
    expect(JSON.parse(payload!.text!.split("\n")[0]!)).toEqual({ values: { total: 1080, paid: null }, by: "Jev" });
  });

  it("reads a text file or an image from the bot's working folder", async () => {
    const text = await call("/api/internal/helpers/extract", { fields: FIELDS, file: "invoice.txt" }, { extract: answered });
    expect(text.extract.mock.calls[0]![2]).toEqual({ text: "Invoice INV-2291, total $1,080.00" });
    const image = await call("/api/internal/helpers/extract", { fields: FIELDS, file: join(work, "receipt.png") }, { extract: answered });
    expect(image.extract.mock.calls[0]![2]).toEqual({ images: [{ mime: "image/png", data: "iVBORw0KGgo=" }] });
  });
  it("reads an authorized attachment without claiming or waiting for a desktop", async () => {
    const opened = await openMessageFile(join(elsewhere, "secret.txt"), [elsewhere]);
    const folders = vi.fn(async () => { throw new Error("Desktop is held by the person"); });
    const result = await call("/api/internal/helpers/extract", { fields: FIELDS, file: "attached.txt" }, {
      extract: answered, folders, openAttachment: async path => path === "attached.txt" ? opened : null,
    });
    expect(result.status).toBe(200);
    expect(folders).not.toHaveBeenCalled();
    expect(opened.handle.fd).toBe(-1);
  });

  it.each([
    ["a file outside its folders", { file: join(elsewhere, "secret.txt") }, 400, "Only files in your working folder"],
    ["a path that escapes with ..", { file: "../elsewhere/secret.txt" }, 400, "Only files in your working folder"],
    ["a missing file", { file: "nope.txt" }, 400, "Nothing was found"],
    ["a corrupt PDF", { file: "scan.pdf" }, 400, "PDF"],
    ["no text and no file", {}, 400, "give text or an image"],
    ["a bad field", { text: "x", fieldsOverride: { "due-date": { type: "date" } } }, 400, "field name"],
  ])("refuses %s, and the model is never asked", async (_name, extra, status, error) => {
    const { fieldsOverride, ...rest } = extra as Record<string, unknown>;
    const result = await call("/api/internal/helpers/extract", { fields: fieldsOverride ?? FIELDS, ...rest }, { extract: answered });
    expect(result.status).toBe(status);
    expect(result.payload?.error).toContain(error);
    expect(result.extract).not.toHaveBeenCalled();
  });

  it("other paths and methods pass through", async () => {
    expect((await call("/api/internal/x/search", {})).outcome).toBe(PASS);
  });
  it.each([
    ["a long text file", "long.txt", () => writeFileSync(join(work, "long.txt"), "x".repeat(200_001)), 200_000],
    ["a text file whose characters take two bytes", "wide.txt", () => writeFileSync(join(work, "wide.txt"), "é".repeat(150_000)), undefined],
    ["a PDF with more text than one extraction", "long.pdf", () => writeFileSync(join(work, "long.pdf"),
      pdfFixture(Array.from({ length: 55 }, () => Array.from({ length: 60 }, () => "x".repeat(70)).join("\n")))), 200_000],
  ])("reads the start of %s and tells the model the rest was cut", async (_name, file, write, chars) => {
    write();
    const result = await call("/api/internal/helpers/extract", { fields: FIELDS, file }, { extract: answered });
    expect(result.status).toBe(200);
    const sent = result.extract.mock.calls[0]![2].text!;
    if (chars !== undefined) expect(sent).toHaveLength(chars);
    expect(Buffer.byteLength(JSON.stringify({ fields: FIELDS, input: { text: sent } }))).toBeLessThanOrEqual(256 * 1024);
    expect(result.payload?.text).toContain(`only its first ${sent.length.toLocaleString("en-US")} characters were read`);
  });
  it("says nothing was cut when a file fits whole", async () => {
    const result = await call("/api/internal/helpers/extract", { fields: FIELDS, file: "invoice.txt" }, { extract: answered });
    expect(result.payload?.text).not.toContain("too long");
  });
  it("bounds PDF input before starting a parser or model", async () => {
    const file = join(work, "oversize.pdf");
    writeFileSync(file, "%PDF-1.7");
    truncateSync(file, 25 * 1024 * 1024 + 1);
    const result = await call("/api/internal/helpers/extract", { fields: FIELDS, file }, { extract: answered });
    expect(result.status).toBe(400);
    expect(result.payload?.error).toContain("over 25 MB");
    expect(result.extract).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === "win32")("refuses a PDF symlink outside the bot's working roots", async () => {
    const secret = join(elsewhere, "private.pdf");
    writeFileSync(secret, "%PDF-1.7");
    symlinkSync(secret, join(work, "linked.pdf"));
    const result = await call("/api/internal/helpers/extract", { fields: FIELDS, file: "linked.pdf" }, { extract: answered });
    expect(result.status).toBe(400);
    expect(result.payload?.error).toContain("Only files");
    expect(result.extract).not.toHaveBeenCalled();
  });
});
