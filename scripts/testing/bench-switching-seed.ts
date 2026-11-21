// Seeds a fixture data folder for scripts/bench-switching.ts before its server starts: five conversations of text,
// tool rows and pictures of different shapes, and some quiet bots around them. Runs only in a child whose
// MADANI_DATA_DIR and HOME are the fixture's own folder; prints the ids the bench needs as JSON.
//   MADANI_DATA_DIR=... node --experimental-strip-types scripts/testing/bench-switching-seed.ts MESSAGES
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const dataDir = process.env.MADANI_DATA_DIR;
if (!dataDir || !dataDir.includes("madanibot-bench-")) throw new Error("bench-switching-seed runs only on a bench fixture folder");
const [messages = 80] = process.argv.slice(2).map(Number);

const { Store } = await import("../../server/store.ts");
const { ATTACHMENTS_DIR } = await import("../../server/attachments.ts");
type Message = import("../../server/store.ts").Message;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
/** A banded RGB picture, so it has real bytes to fetch and decode. */
function png(width: number, height: number, hue: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const p = at + 1 + x * 3;
      rows[p] = (hue + x * 7 + y) & 0xff;
      rows[p + 1] = (hue * 3 + y * 5) & 0xff;
      rows[p + 2] = (x ^ y) & 0xff;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
const SHAPES: Array<[number, number]> = [[1200, 800], [640, 960], [1600, 420], [320, 200], [900, 900]];
const pictures = SHAPES.map(([width, height], index) => {
  const path = join(ATTACHMENTS_DIR, `bench-switch-${index}.png`);
  writeFileSync(path, png(width, height, index * 40));
  return { path, width, height };
});

const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
const start = Date.now() - 3 * 24 * 3600_000;
let clock = start;
const tick = (ms = 45_000) => (clock += ms);
let serial = 0;
const id = (prefix: string) => `${prefix}-${(serial += 1).toString(36).padStart(6, "0")}`;

function botText(name: string, turn: number): string {
  const parts = [
    `${name} here. Turn ${turn}: I checked **item ${turn}** and the [report](https://example.com/report/${turn}) is ready.`,
    `- The sync finished in ${turn % 17 + 3} minutes.\n- Three records were skipped.\n- The draft is in your inbox.`,
  ];
  if (turn % 5 === 0) parts.push("```ts\nexport const total = rows.reduce((sum, row) => sum + row.value, 0);\n```");
  parts.push(`Next I will ${turn % 2 ? "check the remaining accounts" : "send the summary"}.`);
  return parts.join("\n\n");
}

function conversation(name: string, count: number, offset: number): Message[] {
  const rows: Message[] = [];
  let parentId: string | null = null;
  const push = (message: Omit<Message, "id" | "at" | "parentId">) => {
    const row = { ...message, id: id("m"), at: tick(), parentId } as Message;
    rows.push(row);
    parentId = row.id;
  };
  for (let turn = 1; rows.length < count; turn += 1) {
    const turnId = id("turn");
    const picture = pictures[(turn + offset) % pictures.length]!;
    push({ role: "user", kind: "text", text: turn % 7 === 3
      ? `What is in this one?\n<attached-image path="${picture.path}" name="photo-${turn}.png" />`
      : `Item ${turn} please, ${name}` });
    if (rows.length < count - 1) push({ role: "bot", kind: "activity", turnId, tool: { name: "Read", ok: true, summary: `Read item-${turn}`, input: `{"path":"item-${turn}"}`, output: "ok" } } as Omit<Message, "id" | "at" | "parentId">);
    if (rows.length >= count) break;
    push({
      role: "bot", kind: "text", turnId, text: botText(name, turn), turnTerminal: true, turnCompletedAt: clock,
      ...(turn % 3 === 0 ? { attachments: [{ kind: "image" as const, path: picture.path, mime: "image/png", name: `chart-${turn}.png` }] } : {}),
    } as Omit<Message, "id" | "at" | "parentId">);
  }
  // the newest reply always carries a picture, so the bottom of every chat has one to load
  const last = rows.at(-1)!;
  if (last.role === "bot" && last.kind === "text" && !last.attachments) {
    const picture = pictures[offset % pictures.length]!;
    last.attachments = [{ kind: "image", path: picture.path, mime: "image/png", name: "latest.png" }];
  }
  return rows;
}

const NAMES = ["Bolt", "Nova", "Quill", "Rivet", "Tally"];
const chats: Array<{ id: string; threadId: string; name: string; lastId: string }> = [];
for (const [index, name] of NAMES.entries()) {
  const bot = store.createBot({ name, section: "Team", description: `${name} helps with things.` }, { seedMessages: false });
  const rows = conversation(name, messages + index * 7, index);
  store.importTranscript(bot.threadId, rows, rows.at(-1)!.id);
  chats.push({ id: bot.id, threadId: bot.threadId, name, lastId: rows.at(-1)!.id });
}
for (let index = 0; index < 10; index += 1) {
  const bot = store.createBot({ name: `Quiet ${index + 1}`, section: "Others", description: "A quiet bot." }, { seedMessages: false });
  const rows = conversation(bot.name, 4, index);
  store.importTranscript(bot.threadId, rows, rows.at(-1)!.id);
}

process.stdout.write(`${JSON.stringify({ chats, pictures: pictures.map(({ width, height }) => ({ width, height })) })}\n`);
