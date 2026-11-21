import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { desktopErrorDsn, startDesktopErrorReporting } from "./desktop-errors.mjs";

const DSN = "https://k@errors.example.com/3";

function fakeApp(packageJson) {
  const dir = mkdtempSync(join(tmpdir(), "madani-app-"));
  if (packageJson) writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson));
  const listeners = {};
  return { dir, listeners, app: { getAppPath: () => dir, getPath: () => dir, getVersion: () => "0.1.150", isPackaged: true, on: (name, fn) => { listeners[name] = fn; } } };
}

test("the build's dsn comes from the environment first, then package.json", () => {
  const { dir } = fakeApp({ madanibot: { errorDsn: DSN } });
  assert.equal(desktopErrorDsn({}, dir), DSN);
  assert.equal(desktopErrorDsn({ MADANI_ERROR_DSN: "https://x@other.example/1" }, dir), "https://x@other.example/1");
  assert.equal(desktopErrorDsn({}, fakeApp().dir), null);
});

test("turning reports off keeps the server child from inheriting the dsn", () => {
  const { app, listeners } = fakeApp({ madanibot: { errorDsn: DSN } });
  const env = { MADANI_ERROR_DSN: DSN };
  assert.equal(startDesktopErrorReporting({ app, prefs: { errorReports: () => false }, env }).enabled, false);
  assert.equal(env.MADANI_ERROR_DSN, undefined);
  assert.equal(listeners["render-process-gone"], undefined);
});

test("with reports on, the server child gets the dsn and page crashes are watched", () => {
  const { app, listeners } = fakeApp({ madanibot: { errorDsn: DSN } });
  const env = {};
  assert.equal(startDesktopErrorReporting({ app, prefs: { errorReports: () => true }, env }).enabled, true);
  assert.equal(env.MADANI_ERROR_DSN, DSN);
  assert.equal(typeof listeners["render-process-gone"], "function");
  process.removeAllListeners("uncaughtExceptionMonitor");
});
