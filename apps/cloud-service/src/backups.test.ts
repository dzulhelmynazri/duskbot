import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { createBackupStore, homeBackupKey, homeVolumeProblem, homeVolumeScan, makeTar, MARKER_FILE, tarEntries } from "./backups.ts";

const ID = `c${"a".repeat(24)}`, KEY = homeBackupKey(Buffer.alloc(32, 7), ID);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const store = () => { const dir = mkdtempSync(join(tmpdir(), "madani-backups-")); dirs.push(dir); return { dir, backups: createBackupStore({ dir }) }; };
const marker = (machine = ID) => ({ name: `home/${MARKER_FILE}`, data: JSON.stringify({ machine }) });
const home = (extra: Array<{ name: string; data: string }> = []) => makeTar([marker(), { name: `home/${CLOUD_HOME.dataName}/state.json`, data: "{}" }, ...extra]);
async function* pieces(buf: Buffer, size: number) { for (let at = 0; at < buf.length; at += size) yield buf.subarray(at, at + size); }

/** the check as it was over a whole tar in memory: the streaming one must agree with it */
function reference(tar: Buffer, cloudId = ID) {
  let entries;
  try { entries = tarEntries(tar); } catch { return "unreadable"; }
  const found = entries.find(e => e.name.split("/").slice(-1)[0] === MARKER_FILE && e.name.split("/").length <= 3);
  if (!found) return "no_marker";
  try { if ((JSON.parse(found.data.toString("utf8")) as { machine?: unknown }).machine !== cloudId) return "other_cloud"; } catch { return "bad_marker"; }
  return entries.some(e => e.name.split("/").slice(0, -1).includes(CLOUD_HOME.dataName)) ? null : "no_data";
}

/** a ustar header for an entry of `size` bytes whose data follows separately */
function header(name: string, size: number) {
  const h = makeTar([{ name, data: "" }]).subarray(0, 512);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124); h.write("        ", 148);
  let sum = 0; for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

it("checks a tar arriving in pieces of any size exactly as it checks a whole one", () => {
  const long = `home/${CLOUD_HOME.dataName}/${"n".repeat(140)}.txt`;
  const cases = [home(), home([{ name: long, data: "x".repeat(700) }]), makeTar([marker()]), makeTar([marker(`c${"b".repeat(24)}`), { name: `home/${CLOUD_HOME.dataName}/a`, data: "1" }]),
    makeTar([{ name: `home/${CLOUD_HOME.dataName}/a`, data: "1" }]), home().subarray(0, 1100), home([{ name: long, data: "x".repeat(700) }]).subarray(0, 2700), Buffer.from("not a tar at all, just some bytes".repeat(40))];
  for (const tar of cases) {
    const whole = homeVolumeProblem(tar, ID);
    expect(whole).toBe(reference(tar));
    for (const size of [1, 7, 511, 512, 513, 4096]) {
      const scan = homeVolumeScan(ID);
      for (let at = 0; at < tar.length; at += size) scan.push(tar.subarray(at, at + size));
      expect(scan.end()).toBe(whole);
    }
  }
  expect(cases.map(tar => homeVolumeProblem(tar, ID))).toEqual([null, null, "no_data", "other_cloud", "no_marker", "no_data", "unreadable", "unreadable"]);
});

it("seals a stream to disk, reads it back a piece at a time, and catches a changed byte", async () => {
  const { dir, backups } = store(), tar = home([{ name: `home/${CLOUD_HOME.dataName}/big.bin`, data: "z".repeat(3 * 1024 * 1024 + 5) }]);
  const record = await backups.writeStream(ID, KEY, pieces(tar, 65_536));
  expect(record.plainBytes).toBe(tar.length);
  expect(backups.list(ID)).toEqual([record.file]); expect(readdirSync(join(dir, ID))).toEqual([record.file]);
  expect(backups.read(ID, KEY, record.file).equals(tar)).toBe(true);
  expect(await backups.check(ID, KEY, record.file)).toEqual({ problem: null, sha256: record.sha256 });
  expect(backups.sha256(ID, record.file)).toBe(record.sha256);
  expect((await backups.check(ID, homeBackupKey(Buffer.alloc(32, 8), ID), record.file)).problem).toBe("unreadable");
  const path = join(dir, ID, record.file), sealed = readFileSync(path); sealed[sealed.length >> 1] ^= 1;
  chmodSync(path, 0o600); writeFileSync(path, sealed);
  expect((await backups.check(ID, KEY, record.file)).problem).toBe("unreadable");
});

it("leaves nothing behind when a stream is stopped part way, and drops a half-written file on start", async () => {
  const { dir, backups } = store();
  let seen = 0;
  await expect(backups.writeStream(ID, KEY, pieces(home(), 512), chunk => { seen += chunk.length; if (seen > 1024) throw new Error("too_large"); })).rejects.toThrow("too_large");
  expect(readdirSync(join(dir, ID))).toEqual([]);
  writeFileSync(join(dir, ID, ".1790000000000-abcd0123.ombb.part"), "half");
  createBackupStore({ dir });
  expect(readdirSync(join(dir, ID))).toEqual([]);
});

it("streams a volume far larger than the memory it uses", async () => {
  const { backups } = store(), size = 192 * 1024 * 1024, block = Buffer.alloc(1024 * 1024, 0x61), head = home().subarray(0, 2048);
  async function* volume() {
    yield head; yield header(`home/${CLOUD_HOME.dataName}/huge.bin`, size);
    for (let n = 0; n < size / block.length; n++) yield block;
    yield Buffer.alloc(1024);
  }
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0;
  const record = await backups.writeStream(ID, KEY, volume(), () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); });
  expect(record.plainBytes).toBeGreaterThan(size);
  expect(peak).toBeLessThan(48 * 1024 * 1024);
  const checked = await backups.check(ID, KEY, record.file);
  expect(checked).toEqual({ problem: null, sha256: record.sha256 });
}, 60_000);
