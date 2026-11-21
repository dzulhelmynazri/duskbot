// signs the link agent the link service hands out, for servers that pin release keys (agent.mjs RELEASE_KEYS or
// MADANI_LINK_RELEASE_KEYS). keep the private key off the link service's machine, or the signature vouches for nothing.
//   node release.mjs keygen <private-key-file>   makes a key pair: the private half only in that file (0600), the
//                                                public half printed for RELEASE_KEYS
//   node release.mjs sign <private-key-file>     writes agent.mjs.sig beside agent.mjs for the agent as it is now
//   node release.mjs sign-env                    the same with the key from MADANI_LINK_RELEASE_KEY (the pem, base64), as
//                                                ci keeps it (.github/workflows/link-agent-sign.yml)
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { releaseMessage, releaseOf } from "./agent.mjs";

const agentFile = fileURLToPath(new URL("./agent.mjs", import.meta.url));

export function signRelease(agentText, privateKey) {
  const { version, protocol } = releaseOf(agentText);
  if (!version || !protocol) throw new Error("agent.mjs has no AGENT_VERSION or LINK_PROTOCOL line");
  const sha256 = createHash("sha256").update(agentText).digest("hex");
  return sign(null, releaseMessage({ version, protocol, sha256 }), privateKey).toString("base64");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, keyFile] = process.argv.slice(2);
  if (command === "keygen" && keyFile) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    console.log(publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"));
  } else if ((command === "sign" && keyFile) || (command === "sign-env" && process.env.MADANI_LINK_RELEASE_KEY)) {
    const pem = command === "sign" ? readFileSync(keyFile) : Buffer.from(process.env.MADANI_LINK_RELEASE_KEY, "base64");
    const signature = signRelease(readFileSync(agentFile, "utf8"), createPrivateKey(pem));
    writeFileSync(`${agentFile}.sig`, `${signature}\n`);
    console.log(`signed agent ${releaseOf(readFileSync(agentFile, "utf8")).version}`);
  } else {
    console.error("usage: node release.mjs keygen|sign <private-key-file>, or sign-env with MADANI_LINK_RELEASE_KEY set");
    process.exit(2);
  }
}
