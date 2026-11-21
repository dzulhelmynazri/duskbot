// CuaDriver.app (the helper a copy run from source drives this Mac through) holds its socket back while macOS lacks a
// grant and waits behind its own panel. Its re-exec arguments are the only place that says which grant it is waiting for.

const GATE_FLAGS = [
  ["--cua-internal-gate-missing-screen-recording", "Screen Recording"],
  ["--cua-internal-gate-missing-accessibility", "Accessibility"],
];

/** The grants a waiting CuaDriver names in `ps -axo args=` output, or null when none is waiting. */
export function parseDriverGate(psOutput) {
  if (typeof psOutput !== "string") return null;
  for (const line of psOutput.split("\n")) {
    if (!line.includes("CuaDriver.app/") || !line.includes("--cua-internal-gate-engaged")) continue;
    const missing = GATE_FLAGS.filter(([flag]) => line.includes(flag)).map(([, name]) => name);
    if (missing.length) return missing;
  }
  return null;
}

/** The record's reason: names each grant ("... required") so the app can open its pane, and the app that needs it
 * (shared/your-computer.ts `COMPUTER_HELPER_APP`), since macOS lists CuaDriver there, not madani bot. */
export function driverGateReason(missing) {
  return `${missing.join(" and ")} required for CuaDriver; turn on CuaDriver in System Settings > Privacy & Security`;
}

/** The grants named by a reason `driverGateReason` wrote, or null for any other reason. */
export function driverGateFromReason(reason) {
  const named = typeof reason === "string" ? reason.match(/^(.+) required for CuaDriver; /)?.[1] : null;
  if (!named) return null;
  const missing = named.split(" and ");
  return missing.every((name) => GATE_FLAGS.some(([, known]) => known === name)) ? missing : null;
}
