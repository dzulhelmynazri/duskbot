// The VPS move sheet in the real app, on an isolated fake-engine server (scripts/testing/vps-cloud-move-preview.tsx).
// Run: node --experimental-strip-types scripts/testing/vps-cloud-move-preview-serve.ts
import { launchVerificationServer } from "../control-madani.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  ui = await mountPreview(fixture, { entry: "/scripts/testing/vps-cloud-move-preview.tsx", route: "/__vps-cloud-move.html", title: "VPS move to madani cloud", logLevel: "warn", hmr: false });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
