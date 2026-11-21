// A person's first line: a job, or only hello (first-message-job.ts)
import { describe, expect, it } from "vitest";

import { isJob } from "./first-message-job.ts";

describe("isJob", () => {
  it("is not a job: empty, emoji, greetings, pleasantries, thanks, a bare command or a request for orientation", () => {
    for (const line of ["", "   ", "👋", "🙂🙂", "hi", "Hi!", "hey there", "hello Madani 👋", "good morning!", "yo, what's up?",
      "Hi, how are you?", "how are you doing", "thanks!", "thank you so much", "ok", "cool, thanks", "hola", "oi, tudo bem", "안녕하세요", "test", "...",
      "/help", "help", "what can you do?", "Hi! Who are you?"]) expect(isJob(line), line).toBe(false);
  });

  it("is a job: anything actionable, alone or after a greeting, in any language", () => {
    for (const line of ["Sort my inbox every morning", "hi, can you research our competitors?", "Hey Madani, summarize my unread email",
      "book a table for two tonight", "translate this", "remind me at 5", "/setup sort my inbox", "Hola, ordena mi bandeja de entrada",
      "매일 아침 받은편지함 정리해 줘", "weather?", "https://example.com summarize"]) expect(isJob(line), line).toBe(true);
  });
});
