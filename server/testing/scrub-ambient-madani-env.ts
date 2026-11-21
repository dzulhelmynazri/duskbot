// Side-effect import that scrubs ambient madani bot env before a module snapshots it (scripts/mcp-server.ts reads
// MADANI_URL / MADANI_PORT at evaluation). Import order is the contract: keep it above the module under test.
import { isAmbientMadaniKey } from "./madani-env.ts";

for (const key of Object.keys(process.env)) {
  if (isAmbientMadaniKey(key)) delete process.env[key];
}
