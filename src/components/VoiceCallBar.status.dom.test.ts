// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { statusText } from "./VoiceCallBar";

setLocale("en");
const blocked = { phase: "error", error: { kind: "microphone-blocked", message: "" } } as unknown as Parameters<typeof statusText>[0];

describe("the call bar's status", () => {
  it("says the microphone is off in a short sentence on a small phone, and in full where there is room", () => {
    expect(statusText(blocked, "Nova", true)).toBe("Microphone is off");
    expect(statusText(blocked, "Nova")).toBe("Microphone access is off for madani bot");
  });
});
