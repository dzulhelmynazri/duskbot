import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// attachments.ts reads DATA_DIR at import time.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "madani-scratch-chat-"));
process.env.MADANI_DATA_DIR = join(DATA_ROOT, "data");
const { saveBotAttachment } = await import("./bot-attachment.ts");
const { ATTACHMENTS_DIR } = await import("./attachments.ts");
const { openMessageFile } = await import("./message-file.ts");
const { ScratchLedger, sweepScratch } = await import("./scratch.ts");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a screenshot")]);

afterAll(() => rmSync(DATA_ROOT, { recursive: true, force: true }));

/** What the conversation route does for a bot's attached image: it opens the stored copy, never the source. */
async function chatImage(path: string): Promise<Buffer> {
  const opened = await openMessageFile(path, [ATTACHMENTS_DIR]);
  try { return await opened.handle.readFile(); } finally { await opened.handle.close(); }
}

describe("chat images outlive the scratch they came from", () => {
  it("a desktop screenshot attached from /home/cua/scratch still shows after the scratch folder is emptied", async () => {
    const desktopHome = join(DATA_ROOT, "desktop-home");
    const shot = join(desktopHome, "scratch", "checkout.png");
    mkdirSync(join(desktopHome, "scratch"), { recursive: true });
    writeFileSync(shot, PNG);

    const saved = await saveBotAttachment({ path: "/home/cua/scratch/checkout.png", roots: [], guest: { root: "/home/cua", host: desktopHome } });
    expect(saved.attachment.kind).toBe("image");
    expect(saved.attachment.path.startsWith(ATTACHMENTS_DIR)).toBe(true);

    rmSync(join(desktopHome, "scratch"), { recursive: true, force: true });
    expect(existsSync(shot)).toBe(false);
    expect(await chatImage(saved.attachment.path)).toEqual(PNG);
  });

  it("a browser screenshot the turn attached still shows after its turn released and the day-old sweep ran", async () => {
    const screenshots = join(DATA_ROOT, "data", "browser", "screenshots", "hash");
    const workspace = join(DATA_ROOT, "workspace");
    mkdirSync(screenshots, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const scratchShot = join(screenshots, "browser-screenshot-page.png");
    writeFileSync(scratchShot, PNG);
    writeFileSync(join(workspace, "page.png"), readFileSync(scratchShot));

    const saved = await saveBotAttachment({ path: join(workspace, "page.png"), roots: [workspace] });
    const ledger = new ScratchLedger([join(DATA_ROOT, "data", "browser", "screenshots")]);
    ledger.mark("browser:bot-a", scratchShot);
    ledger.release("browser:bot-a");
    sweepScratch([join(DATA_ROOT, "data", "browser", "screenshots")], { now: Date.now() + 2 * 24 * 60 * 60_000 });

    expect(existsSync(scratchShot)).toBe(false);
    expect(existsSync(join(workspace, "page.png"))).toBe(true);
    expect(await chatImage(saved.attachment.path)).toEqual(PNG);
  });
});
