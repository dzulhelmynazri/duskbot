import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { promptWithReply } from "./replies.ts";
import { QUOTED_ATTACHMENTS_INTRO, QUOTED_IMAGE_OVER_BUDGET, quotedAttachmentBlock, quotedAttachmentLines, withQuotedImages } from "./reply-attachments.ts";
import type { Message } from "./store.ts";
import type { TurnImageInput } from "./contracts.ts";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(24, 1)]);
const ID = (n: number) => `123e4567-e89b-42d3-a456-42661417400${n}`;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const store = () => { const root = mkdtempSync(join(tmpdir(), "madani-reply-attachments-")); roots.push(root); return root; };
const picture = (root: string, n: number) => { const path = join(root, `${ID(n)}.png`); writeFileSync(path, PNG); return path; };

const old = (patch: Partial<Message>): Message => ({ id: "old", at: 1, role: "user", kind: "text", text: "", ...patch });

describe("a reply to a message with attachments", () => {
  it("carries the quoted person's picture and file however old, and engines that read pictures get the picture as one", () => {
    const root = store();
    const image = picture(root, 1);
    const file = join(root, `${ID(2)}.pdf`);
    writeFileSync(file, "%PDF");
    const target = old({ text: `look at this\n\n<attached-image path="${image}" name="Shot.png" />\n<attached-file path="${file}" name="Plan.pdf" />` });

    const prompt = promptWithReply("what was in it?", target, "Ada", root);
    expect(prompt).toContain(QUOTED_ATTACHMENTS_INTRO);
    expect(prompt).toContain(`<attached-image path="${image}" name="Shot.png" />`);
    expect(prompt).toContain(`<attached-file path="${file}" name="Plan.pdf" />`);
    expect(prompt.indexOf(QUOTED_ATTACHMENTS_INTRO)).toBeLessThan(prompt.indexOf("Current message:"));

    const native = withQuotedImages(prompt, [], true, { attachmentsDir: root });
    expect(native.images).toEqual([{ path: image, mime: "image/png", bytes: PNG.length }]);
    expect(native.text).not.toContain("<attached-image");
    expect(native.text).toContain(`<attached-file path="${file}"`);

    // an engine that reads no pictures opens it by its path
    expect(withQuotedImages(prompt, [], false, { attachmentsDir: root })).toEqual({ text: prompt, images: [] });
  });

  it("carries a bot's own image attachment, and a reply to a picture with no words is allowed", () => {
    const root = store();
    const image = picture(root, 3);
    const target = old({ role: "bot", text: "", attachments: [{ kind: "image", path: image, mime: "image/png", name: "chart.png" }] });
    const prompt = promptWithReply("make it blue", target, "Ada", root);
    expect(prompt).toContain(`<attached-image path="${image}" name="chart.png" />`);
    expect(withQuotedImages(prompt, [], true, { attachmentsDir: root }).images).toHaveLength(1);
  });

  it("says plainly when the quoted picture is gone", () => {
    const root = store();
    const gone = join(root, `${ID(4)}.png`);
    const lines = quotedAttachmentLines(old({ text: `<attached-image path="${gone}" name="Receipt.png" />` }), root);
    expect(lines).toEqual([QUOTED_ATTACHMENTS_INTRO, `[The quoted message's image "Receipt.png" is no longer stored, so it can't be shown.]`]);
  });

  it("never turns a tag naming a path outside the upload store into an attachment", () => {
    const root = store();
    expect(quotedAttachmentLines(old({ text: '<attached-image path="/etc/hosts.png" />' }), root)).toEqual([]);
    expect(quotedAttachmentLines(old({ role: "bot", text: `<attached-image path="${picture(root, 5)}" />` }), root)).toEqual([]);
  });

  it("keeps the turn within its picture budget and notes the one left out", () => {
    const root = store();
    const image = picture(root, 6);
    const full: TurnImageInput[] = Array.from({ length: 10 }, () => ({ path: image, mime: "image/png", bytes: 1 }));
    const prompt = promptWithReply("and this?", old({ text: `<attached-image path="${image}" />` }), "Ada", root);
    const fitted = withQuotedImages(prompt, full, true, { attachmentsDir: root });
    expect(fitted.images).toEqual([]);
    expect(fitted.text).toContain(QUOTED_IMAGE_OVER_BUDGET);
  });

  it("finds the quoted message for a room turn by its id", () => {
    const root = store();
    const image = picture(root, 7);
    const messages = [old({ text: `<attached-image path="${image}" />` }), old({ id: "new", text: "this one", replyToId: "old" })];
    const block = quotedAttachmentBlock(messages, "old", root);
    expect(block.startsWith(`\n\n${QUOTED_ATTACHMENTS_INTRO}\n`)).toBe(true);
    expect(withQuotedImages(`room transcript${block}`, [], true, { attachmentsDir: root }).images).toHaveLength(1);
    expect(quotedAttachmentBlock(messages, undefined, root)).toBe("");
  });
});
