import { describe, expect, it } from "vitest";
import type { AppEntry } from "@/components/connect-apps/catalog";
import { appIsAdded } from "./ConnectorsSheet";
import { routineResultsThread } from "./RoutinesSheet";
import { accountRows, shownComputer } from "./SettingsSheet";
import { LEGAL_LINKS, SUPPORT_EMAIL, supportMail } from "../legal";
import { swipeOffset, swipeRestingPosition } from "./SwipeRow";

describe("swipe row release", () => {
  it("uses the flick direction to open or close beyond the midpoint", () => {
    expect(swipeRestingPosition(-20, -300, 132)).toBe(-132);
    expect(swipeRestingPosition(-100, 300, 132)).toBe(0);
    expect(swipeRestingPosition(-65, 0, 132)).toBe(0);
    expect(swipeRestingPosition(-67, 0, 132)).toBe(-132);
  });

  it("tracks the finger inside its bounds and limits overshoot at either edge", () => {
    expect(swipeOffset(-70, 132)).toBe(-70);
    expect(swipeOffset(-132, 132)).toBe(-132);
    expect(swipeOffset(0, 132)).toBe(0);
    expect(swipeOffset(-1000, 132)).toBeGreaterThan(-180);
    expect(swipeOffset(-1000, 132)).toBeLessThan(-132);
    expect(swipeOffset(1000, 132)).toBeGreaterThan(0);
    expect(swipeOffset(1000, 132)).toBeLessThan(48);
  });
});

describe("merged app connections", () => {
  const entry: AppEntry = { id: "notion", kind: "remote", label: "Notion", description: "", categories: [], icon: {}, composio: "notion_mcp", remote: "notion-remote", aliases: ["notion_io"] };

  it("recognises each provider and alias as the same connected app", () => {
    for (const id of ["notion", "notion_mcp", "notion-remote", "notion_io"]) expect(appIsAdded(entry, new Set([id]))).toBe(true);
  });

  it("does not treat a different app or an empty inventory as connected", () => {
    expect(appIsAdded(entry, new Set(["slack"]))).toBe(false);
    expect(appIsAdded(entry, new Set())).toBe(false);
  });
});

describe("routine results navigation", () => {
  const bot = { threadId: "current-task", mainThreadId: "main-chat" };

  it("opens the configured results thread before the bot's main conversation", () => {
    expect(routineResultsThread({ resultsThreadId: "reports" }, bot)).toBe("reports");
    expect(routineResultsThread({}, bot)).toBe("main-chat");
  });

  it("falls back to the current conversation when there is no main thread", () => {
    expect(routineResultsThread({}, { threadId: "current-task" })).toBe("current-task");
  });
});

const session = { kind: "account", email: "sam@example.com", session: true } as const;
const fromCloud = { kind: "account", email: "sam@example.com", session: false } as const;
const cloudOnly = { kind: "cloud", name: "my cloud" } as const;
const computerOnly = { kind: "computer", name: "Studio Mac" } as const;
const nothing = { kind: "none" } as const;

describe("settings account rows", () => {
  it("the store apps never link to the dashboard that sells plans", () => {
    expect(accountRows({ native: true, identity: session }).dashboard).toBe(false);
    expect(accountRows({ native: true, identity: nothing }).dashboard).toBe(false);
    expect(accountRows({ native: false, identity: nothing }).dashboard).toBe(true);
  });

  it("a signed-in phone can sign out and delete the account", () => {
    expect(accountRows({ native: true, identity: session, offered: true })).toEqual({ dashboard: false, signOut: true, deleteAccount: true, signIn: false, cloudSignIn: false });
    expect(accountRows({ native: true, identity: nothing }).signOut).toBe(false);
  });

  it("a phone on a madani cloud is on its account even without the session: Sign out, never Log in", () => {
    expect(accountRows({ native: true, identity: fromCloud, offered: true })).toEqual({ dashboard: false, signOut: true, deleteAccount: false, signIn: false, cloudSignIn: false });
    expect(accountRows({ native: true, identity: cloudOnly, offered: true })).toEqual({ dashboard: false, signOut: true, deleteAccount: false, signIn: false, cloudSignIn: false });
  });

  it("a phone with only its own computers gets the madani cloud sign-in lower down, not Log in", () => {
    expect(accountRows({ native: true, identity: computerOnly, offered: true })).toMatchObject({ signIn: false, cloudSignIn: true, signOut: false });
  });

  it("offers Remove this computer only for a computer on screen, never for a madani cloud", () => {
    const place = (id: string, origin: string) => ({ id, origin, environmentId: id, label: id, transport: "https" as const, sessionRef: `token.${id}`, capabilities: {} as never, addedAt: 1, lastUsedAt: 1 });
    const records = [place("cloud", "https://d0123456789abcdef0123.madani.bot"), place("box", "https://box.example.org")];
    expect(shownComputer(records, "box")?.id).toBe("box");
    expect(shownComputer(records, "cloud")).toBeNull();
    expect(shownComputer(records, null)).toBeNull();
  });

  it("a phone with no account is offered the sign-in, never the sign-out row", () => {
    expect(accountRows({ native: true, identity: nothing, offered: true })).toMatchObject({ signIn: true, signOut: false });
    expect(accountRows({ native: true, identity: session, offered: true }).signIn).toBe(false);
    expect(accountRows({ native: true, identity: nothing, offered: false }).signIn).toBe(false);
    expect(LEGAL_LINKS.privacy).toBe("https://madani.bot/privacy");
  });

  it("a report or a question opens a mail to a person, spaces kept as spaces", () => {
    expect(supportMail("report a bot reply", "it said x")).toBe(`mailto:${SUPPORT_EMAIL}?subject=report%20a%20bot%20reply&body=it%20said%20x`);
  });
});
