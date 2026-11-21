// CI (or the operator, with the release key) signs the update policy: the floor no install may run below, the
// versions pulled, a pause on every install, and a desktop version's staged rollout share. The account service serves
// the file it is given as MADANI_UPDATE_POLICY_FILE at /v1/updates/policy and reads it again when it changes; the VPS link
// service hands the same file to installs (<data>/packages/update-policy.json); desktops read either.
// The serial must grow with each new policy: an install never takes one older than the one it holds.
//
//   MADANI_RELEASE_SIGNING_KEY=... node apps/cloud-service/scripts/sign-update-policy.ts --serial 7 --floor 0.1.150 --block 0.1.152,0.1.153 [--pause] [--rollout 0.2.26=10] --out update-policy.json
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePolicy } from "../../../shared/update-guard.ts";
import { parseReleaseKeys, PINNED_RELEASE_KEYS } from "../src/release-signing.ts";
import { signPolicy, verifyPolicy } from "../src/update-policy.ts";

const { values } = parseArgs({ options: { serial: { type: "string" }, floor: { type: "string" }, block: { type: "string" }, pause: { type: "boolean" }, rollout: { type: "string", multiple: true }, out: { type: "string" } } });
const key = process.env.MADANI_RELEASE_SIGNING_KEY;
if (!key || !values.serial || !values.out) {
  console.error("usage: MADANI_RELEASE_SIGNING_KEY=... sign-update-policy.ts --serial <n> [--floor <x.y.z>] [--block <a,b>] [--pause] [--rollout <x.y.z>=<0-100>] --out <file>");
  process.exit(2);
}
const rollout = Object.fromEntries((values.rollout ?? []).map(item => { const [version, share] = item.split("="); return [version, Number(share)]; }));
const policy = parsePolicy({ serial: Number(values.serial), floor: values.floor ?? null, blocked: values.block ? values.block.split(",").map(v => v.trim()).filter(Boolean) : [],
  ...(values.pause ? { paused: true } : {}), ...(Object.keys(rollout).length ? { rollout } : {}) });
const signed = signPolicy(policy, key);
// a key nothing pins would sign a policy every install ignores: refuse it here
verifyPolicy(signed, [...PINNED_RELEASE_KEYS, ...parseReleaseKeys(process.env.MADANI_RELEASE_PUBLIC_KEYS)]);
writeFileSync(values.out, `${JSON.stringify(signed)}\n`);
console.log(`${values.out}: serial ${policy.serial}, floor ${policy.floor ?? "none"}, ${policy.blocked.length} blocked${policy.paused ? ", paused" : ""}${policy.rollout ? `, rollout ${JSON.stringify(policy.rollout)}` : ""}`);
