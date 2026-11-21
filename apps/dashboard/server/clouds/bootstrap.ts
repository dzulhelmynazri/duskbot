import { CLOUD_HOME } from "../../../../electron/legacy-names.mjs";
import { generateKeyPairSync } from "node:crypto";

export const CLOUD_HOME_MARKER_FILE = ".omb-cloud-home.json";

export interface DashboardLink {
  v: 1;
  url: string;
  workspaceId: string;
  publicKey: string;
  privateKey: string;
  enrolledAt: number;
  claimed: boolean;
}
interface HomeInput { cloudId: string; adminOrigin: string; secret: string; origin: string; dashboardUrl: string; team?: { id: string; name: string } }
interface BootstrapInput extends Omit<HomeInput, "origin"> { link: DashboardLink }

export function linkKeys(): { publicKey: string; privateKey: string } {
  const keys = generateKeyPairSync("ed25519");
  return { publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateKey: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
}

export function homeEnv(input: HomeInput): Record<string, string> {
  // this service pushes a signed entitlement to every home it makes, so each one refuses clients without it
  const env: Record<string, string> = { MADANI_CLOUD_ROLE: "home", MADANI_CLOUD_MACHINE_ID: input.cloudId, MADANI_CLOUD_ADMIN_URL: input.adminOrigin, MADANI_CLOUD_BOOTSTRAP_SECRET: input.secret, MADANI_PUBLIC_URL: input.origin, MADANI_DASHBOARD_URL: input.dashboardUrl, MADANI_CLOUD_ENTITLEMENT: "required" };
  if (input.team) Object.assign(env, { MADANI_CLOUD_ROLE: "team", MADANI_CLOUD_TEAM_ID: input.team.id, MADANI_CLOUD_TEAM_NAME: input.team.name });
  if (Object.values(env).some(value => /[\r\n\0]/.test(value))) throw new Error("Invalid cloud environment value.");
  return env;
}

export function originFor(template: string | undefined, input: { ipv4: string; cloudId: string }): string {
  if (!/^c[0-9a-f]{24}$/.test(input.cloudId) || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(input.ipv4) || input.ipv4.split(".").some(v => Number(v) > 255)) throw new Error("Invalid cloud address.");
  const origin = (template ?? "https://{ip-dashed}.sslip.io").replaceAll("{ip-dashed}", input.ipv4.replaceAll(".", "-")).replaceAll("{id}", input.cloudId);
  try {
    const url = new URL(origin);
    if (origin !== url.origin || url.protocol !== "https:" || !url.hostname.includes(".") || url.username || url.password) throw new Error();
    return origin;
  } catch { throw new Error("Invalid cloud origin template."); }
}

export function poolBootstrap(input: BootstrapInput & { origin: string }): string {
  return JSON.stringify({ env: { ...homeEnv(input), HOME: "/data", MADANI_DATA_DIR: CLOUD_HOME.data, MADANI_PORT: "8799" }, files: [{ path: `${CLOUD_HOME.data}/dashboard-link.json`, mode: 0o600, content: JSON.stringify(input.link) }, { path: `/data/${CLOUD_HOME_MARKER_FILE}`, mode: 0o600, content: JSON.stringify({ version: 1, machine: input.cloudId }) }] });
}

export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export function dedicatedUserData(input: BootstrapInput & { image: string; originTemplate?: string }): string {
  if (/[\r\n\0]/.test(input.image) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/(?:[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*\/)*[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/.test(input.image)) throw new Error("Invalid Cloud home image.");
  originFor(input.originTemplate, { ipv4: "203.0.113.2", cloudId: input.cloudId });
  const setup = `const fs = require("node:fs");
const input = JSON.parse(process.argv[1]);
const ipv4 = process.argv[2].trim();
if (!/^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(ipv4) || ipv4.split(".").some(v => Number(v) > 255)) process.exit(1);
const origin = input.template.replaceAll("{ip-dashed}", ipv4.replaceAll(".", "-")).replaceAll("{id}", input.cloudId);
const url = new URL(origin);
if (origin !== url.origin || url.protocol !== "https:" || !url.hostname.includes(".") || url.username || url.password) process.exit(1);
const env = { ...input.env, MADANI_PUBLIC_URL: origin };
if (Object.values(env).some(v => /[\\r\\n\\0]/.test(v))) process.exit(1);
fs.writeFileSync("/root/omb-home.env", Object.entries(env).map(([k,v]) => k + "=" + v).join("\\n") + "\\n", { mode: 0o600 });
fs.writeFileSync("/srv/madani-data/${CLOUD_HOME.dataName}/dashboard-link.json", JSON.stringify(input.link), { mode: 0o600 });
fs.writeFileSync("/srv/madani-data/${CLOUD_HOME_MARKER_FILE}", JSON.stringify({ version: 1, machine: input.cloudId }), { mode: 0o600 });
fs.writeFileSync("/etc/caddy/Caddyfile", url.host + " {\\n reverse_proxy 127.0.0.1:8080\\n}\\n");`;
  const payload = { cloudId: input.cloudId, template: input.originTemplate ?? "https://{ip-dashed}.sslip.io", env: homeEnv({ ...input, origin: "" }), link: input.link };
  const image = shellQuote(input.image);
  const storage = `#!/bin/bash
set -euo pipefail
shopt -s nullglob
for attempt in {1..30}; do
  devices=(/dev/disk/by-id/scsi-0HC_Volume_*)
  if [ "\${#devices[@]}" -eq 1 ] && [ -b "\${devices[0]}" ]; then break; fi
  sleep 1
done
if [ "\${#devices[@]}" -ne 1 ] || [ ! -b "\${devices[0]}" ]; then exit 1; fi
install -d -m 700 /srv/madani-data
mountpoint -q /srv/madani-data || mount -o discard,defaults "\${devices[0]}" /srv/madani-data
resize2fs "\${devices[0]}"
`;
  const storageUnit = `[Unit]
Before=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/omb-storage
[Install]
WantedBy=multi-user.target
`;
  return `#!/bin/bash
set +x
set -euo pipefail
umask 077
apt-get update
apt-get install -y ca-certificates curl caddy nodejs
apt-get install -y docker.io e2fsprogs
install -d -m 755 /etc/systemd/system/docker.service.d
install -m 700 /dev/stdin /usr/local/sbin/omb-storage <<'MADANI_STORAGE'
${storage}MADANI_STORAGE
install -m 644 /dev/stdin /etc/systemd/system/omb-storage.service <<'MADANI_STORAGE_UNIT'
${storageUnit}MADANI_STORAGE_UNIT
install -m 644 /dev/stdin /etc/systemd/system/docker.service.d/omb-storage.conf <<'MADANI_DOCKER_UNIT'
[Unit]
Requires=omb-storage.service
After=omb-storage.service
MADANI_DOCKER_UNIT
systemctl daemon-reload
systemctl enable --now omb-storage
systemctl enable --now docker
install -d -m 700 /srv/madani-data /srv/madani-data/${CLOUD_HOME.dataName}
ipv4="$(curl -fsS --max-time 10 http://169.254.169.254/hetzner/v1/metadata/public-ipv4)"
node -e ${shellQuote(setup)} ${shellQuote(JSON.stringify(payload))} "$ipv4"
maus_uid="$(docker run --rm --entrypoint id ${image} -u maus)"
maus_gid="$(docker run --rm --entrypoint id ${image} -g maus)"
chown -R "$maus_uid:$maus_gid" /srv/madani-data
docker run -d --name omb-home --restart unless-stopped --env-file /root/omb-home.env -v /srv/madani-data:/data -p 127.0.0.1:8080:8080 ${image}
chmod 644 /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy
`;
}
