import { MADANI_BODY_IDS } from "../../shared/body-migration.ts";
import { stillFrame } from "./core.ts";

/** A body's still frame as the iPhone's Live Activity draws it: `<G>:` then G by G digits, row by row, 0 empty, 1 body,
 * 2 eye. */
export function mascotCode(body: string): string {
  const frame = stillFrame(body);
  let digits = "";
  for (let y = 0; y < frame.G; y++) {
    for (let x = 0; x < frame.G; x++) {
      const value = frame.paint[(y + frame.pt) * frame.W + x + frame.px] ?? 0;
      digits += value === 1 || value === 2 ? String(value) : "0";
    }
  }
  return `${frame.G}:${digits}`;
}

/** The widget's table of every body, as its Swift source. */
export function mascotSwiftSource(): string {
  const rows = MADANI_BODY_IDS.map((id) => `        "${id}": "${mascotCode(id)}",`).join("\n");
  return `// Generated from src/pixel/mascot-code.ts (mascotSwiftSource); src/pixel/mascot-code.test.ts fails when it is stale.\n\nenum MascotBodies {\n    static let codes: [String: String] = [\n${rows}\n    ]\n}\n`;
}
