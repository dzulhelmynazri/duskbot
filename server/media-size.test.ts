import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WireMessage } from "../shared/wire.ts";
import { attachmentImageSize, imageDimensions, messageImageNames, missingMediaSizes, withMediaSizes } from "./media-size.ts";

function pngHeader(w: number, h: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  head[24] = 8;
  head[25] = 6;
  return head;
}

function jpeg(w: number, h: number, orientation?: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write("II", 0, "latin1");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const app1 = Buffer.alloc(4);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(body.length + 2, 2);
    parts.push(app1, body);
  }
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function webpVp8x(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

function webpLossless(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8L", 12, "latin1");
  b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function store(files: Record<string, Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "madani-media-"));
  dirs.push(dir);
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return dir;
}

describe("image dimensions from file headers", () => {
  it("reads png, gif, webp and jpeg sizes", () => {
    expect(imageDimensions(pngHeader(1280, 720))).toEqual({ w: 1280, h: 720 });
    const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
    expect(imageDimensions(gif)).toEqual({ w: 320, h: 240 });
    expect(imageDimensions(webpVp8x(1920, 1080))).toEqual({ w: 1920, h: 1080 });
    expect(imageDimensions(webpLossless(640, 480))).toEqual({ w: 640, h: 480 });
    expect(imageDimensions(jpeg(800, 600))).toEqual({ w: 800, h: 600 });
  });

  it("swaps a jpeg's sides when its EXIF orientation turns it", () => {
    expect(imageDimensions(jpeg(4032, 3024, 6))).toEqual({ w: 3024, h: 4032 });
    expect(imageDimensions(jpeg(4032, 3024, 3))).toEqual({ w: 4032, h: 3024 });
  });

  it("answers null for bytes that are not a picture", () => {
    expect(imageDimensions(Buffer.from("not an image at all, just words"))).toBeNull();
    expect(imageDimensions(Buffer.alloc(0))).toBeNull();
  });
});

describe("message media sizes", () => {
  const generated = "11111111-1111-4111-8111-111111111111.png";
  const sent = "22222222-2222-4222-8222-222222222222.jpg";

  it("names every stored picture a message shows", () => {
    expect(messageImageNames({
      text: `look\n<attached-image path="/data/attachments/${sent}" name="a.jpg" />\n![x](/api/attachments/${generated})`,
      attachments: [{ kind: "image", path: `/data/attachments/${generated}`, mime: "image/png" }, { kind: "file", path: "/data/attachments/x.pdf", mime: "application/pdf", name: "x.pdf" }],
    }).sort()).toEqual([generated, sent].sort());
  });

  it("fills the sizes it can measure and leaves a message that has them alone", () => {
    const dir = store({ [generated]: pngHeader(1024, 1536), [sent]: jpeg(1600, 900) });
    const message: Pick<WireMessage, "kind" | "text" | "attachments" | "media"> = { kind: "text", text: `<attached-image path="/x/${sent}" name="a.jpg" />`, attachments: [{ kind: "image", path: `/x/${generated}`, mime: "image/png" }] };
    const filled = withMediaSizes(message, dir);
    expect(filled.media).toEqual({ [generated]: { w: 1024, h: 1536 }, [sent]: { w: 1600, h: 900 } });
    expect(withMediaSizes(filled, dir)).toBe(filled);
    expect(missingMediaSizes({ kind: "text", text: "no pictures" }, dir)).toBeNull();
  });

  it("measures a screen row from its own png", () => {
    const png = pngHeader(1280, 800).toString("base64");
    expect(missingMediaSizes({ kind: "screen", png }, "/nowhere")).toEqual({ screen: { w: 1280, h: 800 } });
  });

  it("refuses names that are not stored attachment names", () => {
    const dir = store({ "evil.png": pngHeader(10, 10) });
    expect(attachmentImageSize("../evil.png", dir)).toBeNull();
    expect(attachmentImageSize("evil.svg", dir)).toBeNull();
  });
});
