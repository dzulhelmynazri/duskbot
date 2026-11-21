// The portable description of a home's state: what a volume backup holds, file by file, sorted into the layers of
// docs/home-data.md, with each file's hash. A migration checks a restored machine against it before its home starts; a
// bundle that leaves this service is the volume and its manifest sealed with a passphrase. Host-neutral: the volume
// layout is the same on every host, and the same server runs on This Mac and a VPS.
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { MARKER_FILE, tarEntries } from "./backups.ts";

export const BUNDLE_FORMAT = "madani-home-bundle";
export const BUNDLE_VERSION = 1;
export type Layer = "marker" | "identity" | "chats" | "memory" | "files" | "routines" | "config" | "skills" | "credentials" | "engines" | "browser" | "machine" | "disposable" | "other";
export interface BundleFile { path: string; bytes: number; sha256: string; layer: Layer }
export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  v: typeof BUNDLE_VERSION;
  cloudId: string;
  createdAt: number;
  source: { kind: "managed" | "mac" | "vps"; host?: string };
  /** paths are relative to the volume's root (the folder holding the marker) */
  files: BundleFile[];
  layers: Partial<Record<Layer, { files: number; bytes: number }>>;
}

const DATA = CLOUD_HOME.dataName;
const RULES: Array<[RegExp, Layer]> = [
  [new RegExp(`^${esc(MARKER_FILE)}$`), "marker"],
  [new RegExp(`^${esc(DATA)}/(?:dashboard-link\\.json|cloud-entitlement|cloud-sleep\\.json|moved\\.json|environment-id|phone-relay\\.json)$`), "machine"],
  [new RegExp(`^${esc(DATA)}/(?:tmp|cache|\\.cache|\\.backups|tools|browser)/`), "disposable"],
  [new RegExp(`^${esc(DATA)}/(?:bots\\.json|groups\\.json|bots/|people/)`), "identity"],
  [new RegExp(`^${esc(DATA)}/(?:messages\\.db|runtime\\.db|events/|attachments/)`), "chats"],
  [new RegExp(`^${esc(DATA)}/workspaces/[^/]+/(?:MEMORY\\.md|memory/)`), "memory"],
  [new RegExp(`^${esc(DATA)}/(?:workspaces/|task-workspaces/|sync/)`), "files"],
  [new RegExp(`^${esc(DATA)}/(?:routines\\.json|webhooks\\.json)$`), "routines"],
  [new RegExp(`^${esc(DATA)}/(?:config\\.json|engine\\.json|providers/)`), "config"],
  [new RegExp(`^${esc(DATA)}/(?:skill-state/|org-library/)`), "skills"],
  [new RegExp(`^${esc(DATA)}/(?:sessions\\.json|mcp-oauth\\.json|logins\\.json\\.enc|logins-key|saved-secrets\\.json\\.enc|slack-secrets\\.json\\.enc|composio-auth-configs\\.json|seal-identity\\.key)$`), "credentials"],
  [new RegExp(`^${esc(DATA)}/(?:agent-browser-profiles/|browser-engine-key$)`), "browser"],
  [/^(?:\.claude|\.codex|\.config|\.hermes|engine-homes)(?:\/|$)|^\.claude\.json$/, "engines"],
];
function esc(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** which layer a path under the volume's root belongs to */
export function layerOf(path: string): Layer { return RULES.find(([pattern]) => pattern.test(path))?.[1] ?? "other"; }

/** a tar entry's layer for a backup's size report (`data/...`): a cache or a top folder of the volume's own when the layer
 *  says only "other", by name only when it is a tool's dot folder, never a person's */
export function volumeLayer(entry: string): string {
  const path = entry.replace(/^data\//, ""), layer = layerOf(path), parts = path.split("/");
  const word = (name: string | undefined) => name && /^[a-z0-9_.-]{1,24}$/i.test(name) ? name.replace(/[^a-z0-9]/gi, "_").toLowerCase() : null;
  if (layer === "disposable" || layer === "browser") return `${layer}_${word(parts[1]) ?? "x"}`;
  if (layer !== "other") return layer;
  if (parts.length > 2 && parts[0] === ".cache") return `cache_${word(parts[1]) ?? "x"}`;
  return parts.length > 1 && parts[0]!.startsWith(".") && word(parts[0]) ? `dot${word(parts[0])}` : "other";
}

/** the manifest of a home volume's tar (a backup), with the root its entries share */
export function volumeManifest(tar: Buffer, cloudId: string, source: BundleManifest["source"], now = Date.now()): BundleManifest & { root: string } {
  const entries = tarEntries(tar).filter(e => e.type === "0" || e.type === "");
  const marker = entries.find(e => e.name.split("/").at(-1) === MARKER_FILE && e.name.split("/").length <= 3);
  if (!marker) throw new Error("Not a home volume: no marker.");
  if ((JSON.parse(marker.data.toString("utf8")) as { machine?: unknown }).machine !== cloudId) throw new Error("Another cloud's volume.");
  const root = marker.name.split("/").slice(0, -1).join("/");
  const prefix = root ? `${root}/` : "";
  // a file appended again later (a live backup adds consistent database copies last) is the one a restore keeps
  const byPath = new Map<string, BundleFile>();
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    const path = e.name.slice(prefix.length);
    if (!path) continue;
    byPath.set(path, { path, bytes: e.size, sha256: createHash("sha256").update(e.data).digest("hex"), layer: layerOf(path) });
  }
  const files = [...byPath.values()].sort((a, b) => a.path < b.path ? -1 : 1);
  const layers: BundleManifest["layers"] = {};
  for (const f of files) { const l = (layers[f.layer] ??= { files: 0, bytes: 0 }); l.files++; l.bytes += f.bytes; }
  return { format: BUNDLE_FORMAT, v: BUNDLE_VERSION, cloudId, createdAt: now, source, files, layers, root };
}

/** `sha256sum -c` lines for the files a restored volume must hold as they were: never the machine's own identity (each
 *  machine gets its own) nor a top-level entry the target keeps for itself; names a checksum line cannot carry are skipped */
export function checkLines(manifest: Pick<BundleManifest, "files">, options: { mount?: string; keep?: readonly string[] } = {}): { text: string; checked: number; skipped: number } {
  const mount = options.mount ?? "/data", keep = options.keep ?? [];
  const kept = (path: string) => { const top = path.split("/")[0]!; return keep.some(k => k.endsWith("*") ? top.startsWith(k.slice(0, -1)) : top === k); };
  let checked = 0, skipped = 0;
  const lines: string[] = [];
  for (const f of manifest.files) {
    if (f.layer === "machine" || kept(f.path)) continue;
    if (/[\n\r\\]/.test(f.path)) { skipped++; continue; }
    lines.push(`${f.sha256}  ${mount}/${f.path}`); checked++;
  }
  return { text: lines.length ? `${lines.join("\n")}\n` : "", checked, skipped };
}

const SEALED = Buffer.from("MADANIHB1\n");
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
/** a bundle for outside this service: the manifest and the volume, AES-256-GCM under a passphrase (scrypt) */
export function sealBundle(manifest: BundleManifest, tar: Buffer, passphrase: string): Buffer {
  if (passphrase.length < 12) throw new Error("A bundle passphrase needs at least 12 characters.");
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(passphrase, salt, 32, SCRYPT);
  const head = Buffer.from(JSON.stringify(manifest));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.concat([SEALED, salt, iv]));
  const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(head.length));
  const body = Buffer.concat([cipher.update(length), cipher.update(head), cipher.update(tar), cipher.final()]);
  return Buffer.concat([SEALED, salt, iv, body, cipher.getAuthTag()]);
}
export function openBundle(sealed: Buffer, passphrase: string): { manifest: BundleManifest; tar: Buffer } {
  if (!sealed.subarray(0, SEALED.length).equals(SEALED) || sealed.length < SEALED.length + 16 + 12 + 8 + 16) throw new Error("Not a home bundle.");
  const salt = sealed.subarray(SEALED.length, SEALED.length + 16), iv = sealed.subarray(SEALED.length + 16, SEALED.length + 28);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.concat([SEALED, salt, iv]));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  let plain: Buffer;
  try { plain = Buffer.concat([decipher.update(sealed.subarray(SEALED.length + 28, sealed.length - 16)), decipher.final()]); }
  catch { throw new Error("The bundle does not open with this passphrase, or it was changed."); }
  const length = Number(plain.readBigUInt64BE(0));
  const manifest = JSON.parse(plain.subarray(8, 8 + length).toString("utf8")) as BundleManifest;
  if (manifest.format !== BUNDLE_FORMAT || manifest.v !== BUNDLE_VERSION) throw new Error("A home bundle of another format or version.");
  return { manifest, tar: plain.subarray(8 + length) };
}

/** the files of the manifest the tar no longer matches (a bundle checked after a copy) */
export function bundleMismatches(manifest: BundleManifest, tar: Buffer): string[] {
  const now = volumeManifest(tar, manifest.cloudId, manifest.source, manifest.createdAt);
  const have = new Map(now.files.map(f => [f.path, f.sha256]));
  return manifest.files.filter(f => have.get(f.path) !== f.sha256).map(f => f.path);
}
