import { describe, expect, it } from "vitest";
import { withoutRepeats, announcesAction, claimsUnmadeChange, effectfulCall, ownsFailure, leakedReasoning, leakedToolSyntax, LeakHoldback, MAX_RETRY_WAIT_MS, retryDelay, withRetryAfter } from "./openai-chat-habits.ts";

describe("announcesAction before anything ran", () => {
  it.each([
    "On it, pulling this week's Delhi to Goa fares.",
    "Sure, I'll set that up now.",
    "Got it — setting up your weekday reminder.",
    "Okay! Let me create the automation.",
    "I’m setting up your weekday list of top three priorities.",
    "I'm putting together the content plan.",
    "On it.",
  ])("an ack that only names the work is an announcement: %s", text => {
    expect(announcesAction(text, false)).toBe(true);
  });

  it.each([
    "Sure! Here are three posts:\n\n1. Dark mode is here.",
    "Got it. Your standup is at 10:30 and you're vegetarian; both are saved.",
    "Okay, which of your two calendars should it go in?",
    "Done. I'll send your top three priorities here every weekday at 8:00 AM.",
  ])("a result or a question is not: %s", text => {
    expect(announcesAction(text, false)).toBe(false);
  });

  it("after an effectful call, an ack-shaped closing line is the final answer", () => {
    expect(announcesAction("Sure, I'll send it every weekday at 8.", true)).toBe(false);
    expect(announcesAction("Got it — setting up was quick, it runs at 8.", true)).toBe(false);
    expect(announcesAction("I'm setting it to run at 8 every weekday from tomorrow.", true)).toBe(false);
  });
});

describe("claimsUnmadeChange", () => {
  it.each([
    "I've sent the email to your landlord.",
    "Your post is now live.",
    "The folder has been renamed to madani-bot.",
    "Posted.",
    "I cancelled your daily morning summary.",
    "Your daily summary has been successfully cancelled.",
  ])("a claimed change with no effectful call in the turn: %s", text => {
    expect(claimsUnmadeChange(text, 0)).toBe(true);
  });

  it.each([
    "I haven't sent anything yet; here is the draft.",
    "Nothing was sent. Connect Gmail and I'll send it.",
    "I couldn't post it because X isn't connected.",
    "Here's the draft:\n\nHi, rent will be two days late.",
    "Once you approve, it will be sent.",
    "I created a draft below.",
    "Done. Here is the shorter version.",
    "I can't rename it from here: I have no access to your Documents folder.",
  ])("an honest status is not: %s", text => {
    expect(claimsUnmadeChange(text, 0)).toBe(false);
  });

  it("a turn whose tools made a change may say so", () => {
    expect(claimsUnmadeChange("I've set up the reminder for 9:00 tomorrow.", 1)).toBe(false);
  });
});

describe("effectfulCall", () => {
  it("counts changes and not lookups, a bridged call by the tool it ran", () => {
    expect(effectfulCall("agents_memory_update", "{}")).toBe(true);
    expect(effectfulCall("agents_use_tool", JSON.stringify({ name: "trigger", arguments: {} }))).toBe(true);
    expect(effectfulCall("agents_use_tool", JSON.stringify({ name: "trigger_info" }))).toBe(false);
    expect(effectfulCall("agents_set_status", "{}")).toBe(false);
    expect(effectfulCall("agents_find_tool", "{}")).toBe(false);
    expect(effectfulCall("agents_list_bots", "{}")).toBe(false);
    expect(effectfulCall("data_data_sql", "{}")).toBe(false);
    expect(effectfulCall("agents_use_tool", "not json")).toBe(true);
  });
});

describe("retryDelay", () => {
  const transient = { transient: true, reason: "rate_limited" };
  it("retries a transient failure within the attempts, waiting at least what the provider asked", () => {
    expect(retryDelay(new Error("429"), transient, 0)).toBeGreaterThan(0);
    expect(retryDelay(Object.assign(new Error("429"), { retryAfterMs: 20_000 }), transient, 0)).toBe(20_000);
    expect(retryDelay(new Error("429"), transient, 2)).toBeNull();
  });
  it("never retries a terminal failure or one asking for a longer wait than a hiccup", () => {
    expect(retryDelay(new Error("401"), { transient: false, reason: "auth" }, 0)).toBeNull();
    expect(retryDelay(Object.assign(new Error("429"), { retryAfterMs: MAX_RETRY_WAIT_MS + 1 }), transient, 0)).toBeNull();
  });
});

describe("withRetryAfter", () => {
  it("reads seconds, milliseconds and an HTTP date", () => {
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect((withRetryAfter(new Error("x"), new Headers({ "retry-after": "7" }), now) as any).retryAfterMs).toBe(7_000);
    expect((withRetryAfter(new Error("x"), new Headers({ "retry-after-ms": "1500" }), now) as any).retryAfterMs).toBe(1_500);
    expect((withRetryAfter(new Error("x"), new Headers({ "retry-after": "Thu, 19 Nov 2026 10:00:30 GMT" }), now) as any).retryAfterMs).toBe(30_000);
    expect((withRetryAfter(new Error("x"), new Headers(), now) as any).retryAfterMs).toBeUndefined();
  });
  it("reads the reset a rate limit's body names, and a far one is waited for, never retried into", () => {
    const now = Date.now();
    const body = JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day.", code: 429, metadata: { headers: { "X-RateLimit-Reset": String(now + 3_600_000) } } } });
    const error = withRetryAfter(new Error("429"), new Headers(), now, body);
    expect((error as any).limitResetAt).toBe(now + 3_600_000);
    expect(retryDelay(error, { transient: true, reason: "rate_limited" }, 0)).toBeNull();
    expect((withRetryAfter(new Error("429"), new Headers(), now, "Too Many Requests") as any).limitResetAt).toBeUndefined();
  });
});

describe("leakedToolSyntax", () => {
  it("reads gpt-oss harmony tokens a provider passed on as text", () => {
    expect(leakedToolSyntax("<|start|>assistant<|channel|>commentary to=functions.find_tool <|constrain|>json<|message|>{\n  \"query\": \"trigger\"\n}<|call|>")).toBe(true);
    expect(leakedToolSyntax("Writing three posts now.\n---\n<|channel|>commentary to=functions.find_tool <|message|>{}<|call|>")).toBe(true);
  });
  it("leaves ordinary replies, including ones that mention the tokens in prose, alone", () => {
    expect(leakedToolSyntax("Here are three posts for X.")).toBe(false);
    expect(leakedToolSyntax("Harmony uses a <|channel|> token to split reasoning from the answer.")).toBe(false);
  });
});

describe("leakedReasoning", () => {
  it("reads gpt-oss working notes passed on as the reply", () => {
    expect(leakedReasoning("We need to respond to the user. The request: \"Post this on my X account\". We have no browser, but we can coordinate with a teammate. According to guidelines, after sending coordinate_bots, we should end turn.")).toBe(true);
    expect(leakedReasoning("The user wants three posts. We should keep each under 200 characters. According to the instructions we must not post.")).toBe(true);
  });
  it("leaves replies that speak to the person alone, even ones that start with we", () => {
    expect(leakedReasoning("We need to move your standup: the 10:30 slot clashes with your dentist. I've kept 11:00 free.")).toBe(false);
    expect(leakedReasoning("Here are three posts for X announcing dark mode.")).toBe(false);
  });
});

describe("LeakHoldback", () => {
  const stream = (chunks: string[]) => { const hold = new LeakHoldback(); const live = chunks.map((chunk) => hold.feed(chunk)).join(""); return { hold, live }; };
  it("passes an ordinary reply through after its first few words", () => {
    const { hold, live } = stream(["Here are three ", "posts for X about ", "dark mode."]);
    expect(live).toBe("Here are three posts for X about dark mode.");
    expect(hold.flush()).toBe("");
  });
  it("holds a reply that opens like working notes to its end, and everything from a chat-format token on", () => {
    expect(stream(["We need to respond ", "to the user. The user wants"]).live).toBe("");
    const tokens = stream(["Writing the posts now. ", "Then <|channel|>commentary to=functions.x", "<|call|>"]);
    expect(tokens.live).toBe("Writing the posts now. Then ");
    expect(tokens.hold.kept()).toBe("");
  });
  it("gives back held words when the reply was no leak, or was cut short before it could tell", () => {
    const short = stream(["Already started."]);
    expect(short.live).toBe("");
    expect(short.hold.kept()).toBe("Already started.");
    const notes = stream(["We need to move your standup to 11."]);
    expect(notes.hold.flush()).toBe("We need to move your standup to 11.");
  });
});

describe("ownsFailure", () => {
  it("reads a reply that says what failed, and not one that claims it worked or says nothing of it", () => {
    expect(ownsFailure("I couldn't post it: X isn't connected. Connect X under Connect apps and I'll post it.")).toBe(true);
    expect(ownsFailure("Nothing was sent; the page did not load.")).toBe(true);
    expect(ownsFailure("Done.")).toBe(false);
    expect(ownsFailure("I've posted it, though the preview failed to load.")).toBe(false);
  });
});

describe("withoutRepeats", () => {
  const earlier = ["Reminder set for 6pm today to call mom. It will appear here in chat."];
  it("takes out a message the reply repeats from earlier in the turn, keeping the new part", () => {
    expect(withoutRepeats("Reminder set for 6pm today to call mom.  It will appear here in chat.\n\nGift ideas:\n- a book\n- a plant", earlier)).toBe("Gift ideas:\n- a book\n- a plant");
    expect(withoutRepeats("Reminder set for 6pm today to call mom. It will appear here in chat.", earlier)).toBe("");
  });
  it("leaves a reply that repeats nothing, or only a short phrase, exactly as it was", () => {
    const reply = "Gift ideas:\n\n- a book\n- a plant";
    expect(withoutRepeats(reply, earlier)).toBe(reply);
    expect(withoutRepeats("Done. Also done.", ["Done."])).toBe("Done. Also done.");
  });
});

