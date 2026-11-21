// the lab's relay: one link service node on loopback, behind a tls front on 443 (both address families), in the relay
// namespace. argv: certs dir, stats token
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFront, linkRoot, waitHttp } from "../harness.mjs";

const [dir, statsToken] = process.argv.slice(2);
const node = spawn(process.execPath, [join(linkRoot, "src/server.mjs")], { stdio: "inherit", env: { ...process.env, PORT: "8790", HOST: "127.0.0.1", LINK_BASE: "https://198.51.100.10", LINK_DATA_DIR: join(dir, "relay-data"), MADANI_LINK_OPEN: "1", LINK_STATS_TOKEN: statsToken, LINK_TRUST_PROXY: "1" } });
await waitHttp("http://127.0.0.1:8790/healthz");
const front = await createFront({ key: readFileSync(join(dir, "site.key")), cert: readFileSync(join(dir, "site.pem")), target: 8790, listen: [["0.0.0.0", 443], ["::", 443]] });
console.log(`relay up (front ${front.port})`);
process.on("SIGTERM", () => { node.kill(); process.exit(0); });
