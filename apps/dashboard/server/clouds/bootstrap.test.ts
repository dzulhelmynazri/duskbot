import { CLOUD_HOME } from "../../../../electron/legacy-names.mjs";
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { CLOUD_HOME_MARKER, prepareCloudHomeVolume } from "../../../../server/cloud-home.ts";
import { CLOUD_HOME_MARKER_FILE, dedicatedUserData, homeEnv, linkKeys, originFor, poolBootstrap, shellQuote } from "./bootstrap.ts";

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temporaryDir(): string { const dir = mkdtempSync(join(tmpdir(), "madani-cloud-bootstrap-")); cleanup.push(dir); return dir; }
const image = `ghcr.io/example/madanibot-cloud-home@sha256:${"a".repeat(64)}`;
const cloudId = `c${"a".repeat(24)}`;
const input = { cloudId, adminOrigin: "https://admin.example.test", secret: "S".repeat(43), dashboardUrl: "https://dash.example.test", link: { v: 1 as const, url: "https://dash.example.test", workspaceId: "w1", ...linkKeys(), enrolledAt: 123, claimed: true } };
it("generates dashboard-compatible ed25519 keys", () => {
  const keys = linkKeys(), privateKey = createPrivateKey({ key: Buffer.from(keys.privateKey, "base64"), format: "der", type: "pkcs8" }), publicKey = createPublicKey({ key: Buffer.from(keys.publicKey, "base64"), format: "der", type: "spki" });
  expect(verify(null, Buffer.from("report"), publicKey, sign(null, Buffer.from("report"), privateKey))).toBe(true);
});
it("expands only valid https origins", () => {
  expect(originFor(undefined, { ipv4: "203.0.113.2", cloudId })).toBe("https://203-0-113-2.sslip.io");
  expect(originFor("https://{id}.example.test", { ipv4: "203.0.113.2", cloudId })).toBe(`https://${cloudId}.example.test`);
  for (const template of ["http://{id}.example.test", "https://localhost", "https://a.example.test/path", "https://user@a.example.test"]) expect(() => originFor(template, { ipv4: "203.0.113.2", cloudId })).toThrow();
  expect(() => originFor(undefined, { ipv4: "999.0.0.1", cloudId })).toThrow();
});
it("quotes shell inputs and runs the Cloud home image with its own volume ownership and edge", () => {
  const value = "quoted'$(false) value";
  expect(execFileSync("bash", ["-c", `printf '%s' ${shellQuote(value + "\n")}`], { encoding: "utf8" })).toBe(value + "\n");
  const script = dedicatedUserData({ ...input, secret: value, image });
  execFileSync("bash", ["-n"], { input: script });
  const dir = temporaryDir();
  const mocks = `fixture=${shellQuote(dir)}
apt-get(){ printf 'apt-get %s\n' "$*" >> "$fixture/commands"; }
install(){ printf 'install %s\n' "$*" >> "$fixture/commands"; }
curl(){ printf '%s' 203.0.113.2; }
node(){ printf '%s\\0' "$@" > "$fixture/setup"; }
docker(){
  printf 'docker %s\n' "$*" >> "$fixture/commands"
  case "$*" in
    *'-u maus') printf 1234 ;;
    *'-g maus') printf 5678 ;;
  esac
}
chown(){ printf 'chown %s\n' "$*" >> "$fixture/commands"; }
chmod(){ printf 'chmod %s\n' "$*" >> "$fixture/commands"; }
systemctl(){ printf 'systemctl %s\n' "$*" >> "$fixture/commands"; }
`;
  expect(execFileSync("bash", ["-c", mocks + script], { encoding: "utf8" })).toBe("");
  const args = readFileSync(join(dir, "setup"), "utf8").split("\0");
  const files = new Map<string, { content: string; mode?: number }>();
  const runSetup = (ipv4 = args[3]) => runInNewContext(args[1], { require: () => ({ writeFileSync: (path: string, content: string, options?: { mode: number }) => { files.set(path, { content, ...options }); } }), process: { argv: ["node", args[2], ipv4], exit: () => { throw new Error("invalid"); } }, URL });
  runSetup();
  const env = files.get("/root/omb-home.env")!;
  expect(env).toEqual({ mode: 0o600, content: Object.entries(homeEnv({ ...input, secret: value, origin: "https://203-0-113-2.sslip.io" })).map(([k, v]) => `${k}=${v}`).join("\n") + "\n" });
  expect(files.get(`/srv/madani-data/${CLOUD_HOME.dataName}/dashboard-link.json`)).toEqual({ mode: 0o600, content: JSON.stringify(input.link) });
  expect(files.get(`/srv/madani-data/${CLOUD_HOME_MARKER_FILE}`)).toEqual({ mode: 0o600, content: JSON.stringify({ version: 1, machine: cloudId }) });
  expect(files.get("/etc/caddy/Caddyfile")?.content).toBe("203-0-113-2.sslip.io {\n reverse_proxy 127.0.0.1:8080\n}\n");
  const commands = readFileSync(join(dir, "commands"), "utf8").trim().split("\n");
  expect(commands).toEqual([
    "apt-get update", "apt-get install -y ca-certificates curl caddy nodejs", "apt-get install -y docker.io e2fsprogs", "install -d -m 755 /etc/systemd/system/docker.service.d",
    "install -m 700 /dev/stdin /usr/local/sbin/omb-storage", "install -m 644 /dev/stdin /etc/systemd/system/omb-storage.service",
    "install -m 644 /dev/stdin /etc/systemd/system/docker.service.d/omb-storage.conf", "systemctl daemon-reload", "systemctl enable --now omb-storage", "systemctl enable --now docker",
    `install -d -m 700 /srv/madani-data /srv/madani-data/${CLOUD_HOME.dataName}`,
    `docker run --rm --entrypoint id ${image} -u maus`, `docker run --rm --entrypoint id ${image} -g maus`,
    "chown -R 1234:5678 /srv/madani-data",
    `docker run -d --name omb-home --restart unless-stopped --env-file /root/omb-home.env -v /srv/madani-data:/data -p 127.0.0.1:8080:8080 ${image}`,
    "chmod 644 /etc/caddy/Caddyfile", "systemctl enable caddy", "systemctl restart caddy",
  ]);
  expect(script).toContain("set +x\nset -euo pipefail\numask 077");
  expect(script).not.toContain("set -x");
  expect(script).not.toContain("madanibot serve");
  expect(script).not.toContain("npm install");
  for (const ipv4 of ["999.0.0.1", "203.0.113.2;false", "not-an-ip"]) expect(() => runSetup(ipv4)).toThrow("invalid");
});
it.each([
  "ghcr.io/example/madanibot-cloud-home", "ghcr.io/example/madanibot-cloud-home:1.2.3",
  `registry.example.test:5000/team/cloud_home:release-1@sha256:${"b".repeat(64)}`,
])("accepts a container image reference: %s", image => {
  expect(dedicatedUserData({ ...input, image })).toContain(shellQuote(image));
});
it.each([
  "", "madanibot", "https://ghcr.io/example/home", "ghcr.io//home", "ghcr.io/example/../home", "ghcr.io/Example/home",
  "ghcr.io/example/home:", "ghcr.io/example/home:tag;false", "ghcr.io/example/home:$(false)", "ghcr.io/example/home tag",
  "ghcr.io/example/home@sha256:abc", `ghcr.io/example/home@sha256:${"z".repeat(64)}`, "ghcr.io/example/home\n", "ghcr.io/example/home\r",
])("rejects an invalid image reference: %j", image => {
  expect(() => dedicatedUserData({ ...input, image })).toThrow("Invalid Cloud home image.");
});
it("rejects environment line injection and invalid templates before bootstrapping", () => {
  for (const key of ["cloudId", "adminOrigin", "secret", "dashboardUrl"] as const) {
    for (const newline of ["\n", "\r"]) expect(() => dedicatedUserData({ ...input, image, [key]: input[key] + newline + "INJECTED=1" })).toThrow();
  }
  for (const originTemplate of ["https://{id}.example.test\n", "https://{id}.example.test\r", "http://{id}.example.test", "https://localhost", "https://a.example.test/path", "https://user@a.example.test"]) {
    expect(() => dedicatedUserData({ ...input, image, originTemplate })).toThrow();
  }
});
it("gives the pool image the same env, link and volume marker", () => {
  const payload = JSON.parse(poolBootstrap({ ...input, origin: `https://${cloudId}.pool.example.test` }));
  expect(payload.env).toEqual({ ...homeEnv({ ...input, origin: `https://${cloudId}.pool.example.test` }), HOME: "/data", MADANI_DATA_DIR: CLOUD_HOME.data, MADANI_PORT: "8799" });
  expect(payload.files).toEqual([
    { path: `${CLOUD_HOME.data}/dashboard-link.json`, mode: 0o600, content: JSON.stringify(input.link) },
    { path: `/data/${CLOUD_HOME_MARKER_FILE}`, mode: 0o600, content: JSON.stringify({ version: 1, machine: cloudId }) },
  ]);
  expect(CLOUD_HOME_MARKER_FILE).toBe(CLOUD_HOME_MARKER);
  const dir = temporaryDir();
  mkdirSync(join(dir, CLOUD_HOME.dataName), { mode: 0o700 });
  for (const file of payload.files) writeFileSync(join(dir, file.path.slice("/data/".length)), file.content, { mode: file.mode });
  expect(prepareCloudHomeVolume(dir, cloudId)).toBe("existing");
});

it("mounts and grows the data volume before Docker starts, failing closed without exactly one disk", () => {
  const script = dedicatedUserData({ ...input, image }), dir = temporaryDir();
  const storage = script.split("<<'MADANI_STORAGE'\n")[1].split("MADANI_STORAGE\n")[0].replaceAll("/dev/disk/by-id", dir).replaceAll(" -b ", " -f ");
  const mocks = `sleep(){ :; }
install(){ :; }
mountpoint(){ return 1; }
mount(){ printf 'mount %s\\n' "$*"; }
resize2fs(){ printf 'resize %s\\n' "$*"; }
`;
  expect(() => execFileSync("bash", ["-c", mocks + storage], { encoding: "utf8" })).toThrow();
  writeFileSync(join(dir, "scsi-0HC_Volume_1"), "fixture device");
  expect(execFileSync("bash", ["-c", mocks + storage], { encoding: "utf8" })).toBe(`mount -o discard,defaults ${dir}/scsi-0HC_Volume_1 /srv/madani-data\nresize ${dir}/scsi-0HC_Volume_1\n`);
  writeFileSync(join(dir, "scsi-0HC_Volume_2"), "fixture device");
  expect(() => execFileSync("bash", ["-c", mocks + storage], { encoding: "utf8" })).toThrow();
  expect(script).toContain('Requires=omb-storage.service\nAfter=omb-storage.service');
  expect(script.indexOf('systemctl enable --now omb-storage')).toBeLessThan(script.indexOf('node -e'));
});
