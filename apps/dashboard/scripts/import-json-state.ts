// One-shot import of an account service data folder (the JSON files tests and local fixtures write) into MongoDB.
// Refuses a database that already holds account state, so it never merges two histories. Stop the service first: it
// holds the writer lease.
//   MONGODB_URI=... MONGODB_DB=madani node apps/dashboard/scripts/import-json-state.ts <data folder>
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openMongoBackend } from "../server/persistence/mongo.ts";
import { STORE_LAYOUTS } from "../server/persistence/layouts.ts";

const dir = process.argv[2], uri = process.env.MONGODB_URI;
if (!dir || !uri) { console.error("usage: MONGODB_URI=... import-json-state.ts <data folder>"); process.exit(2); }
const files = readdirSync(dir).filter(name => name.endsWith(".json") && !name.endsWith(".tmp"));
// a fixture's folder (made-up ledger rows, the fake provider's checkouts) never goes into a real database
const billing = files.includes("billing.json") ? JSON.parse(readFileSync(join(dir, "billing.json"), "utf8")) as { ledger?: Array<{ via?: string }>; checkouts?: Array<{ providerSessionId?: string | null }> } : null;
if (billing?.ledger?.some(row => row.via === "fixture") || billing?.checkouts?.some(row => row.providerSessionId?.startsWith("fake_"))) {
  console.error("refused: this folder holds fixture or fake-provider billing records."); process.exit(2);
}
const database = await openMongoBackend({ uri, db: process.env.MONGODB_DB || "madani" });
try {
  const held = await database.db.collection("stores").countDocuments() + await database.db.collection("accounts").countDocuments();
  if (held > 0) throw new Error("This database already holds account state; import into an empty one.");
  for (const file of files) {
    const name = file.replace(/\.json$/, ""), path = join(dir, file);
    if (!existsSync(path)) continue;
    const loaded = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) { console.warn(`skipped ${file}: not a state object`); continue; }
    const store = database.backend.open(name, () => loaded, (value): value is Record<string, unknown> => !!value && typeof value === "object");
    store.commit();
    const rows = Object.keys(STORE_LAYOUTS[name] ?? {}).map(field => `${field} ${(loaded[field] as unknown[] | undefined)?.length ?? 0}`).join(", ");
    console.log(`imported ${file}${rows ? `: ${rows}` : ""}`);
  }
  await database.backend.settled(60_000);
} finally {
  await database.close();
}
