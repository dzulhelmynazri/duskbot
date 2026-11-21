// @vitest-environment happy-dom
// Grok keeps settled cards in the chat: an answered question with only its answer, a dismissed one greyed, a decided
// permission as one centred grey line. A stopped card still leaves no row.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { t } = await import("@/lib/i18n");

const at = (minute: number) => new Date(2026, 9, 21, 9, minute).getTime();
const transcript = (tail: Message[]): Message[] => [
  { id: "m1", parentId: null, role: "user", kind: "text", text: "Draft the weekly update.", at: at(1) },
  { id: "m2", parentId: "m1", role: "bot", kind: "text", text: "Here is the draft.", at: at(2), turnId: "t1", turnTerminal: true },
  ...tail,
];
const pepper = (messages: Message[]): Bot => ({
  id: "pepper", threadId: "main", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)!.id, modelSelection: { instanceId: "test", model: "m" },
  tasks: [
    { threadId: "main", title: "Chat", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" },
    { threadId: "run-1-thread", title: "Inbox brief · Oct 21", createdAt: 2, busy: false, activity: "idle", routineRunId: "run-1", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" },
  ],
});

const dispatch = vi.fn();
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(messages: Message[]) {
  const bot = pepper(messages);
  const state: AppState = {
    ...initialState, connected: true, selectedId: "pepper", bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
  };
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  await settle();
}
beforeAll(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

const question = { title: "Your bot has a question", subtitle: "Which page?", options: ["Home", "Pricing"], requestId: "q1", requestType: "question" as const };
const permission = { title: "Approval needed", subtitle: "ls ~/Desktop", options: ["Allow", "Deny"], requestId: "p1", requestType: "permission" as const, tool: "Bash" };
const card = (id: string, fields: NonNullable<Message["card"]>): Message => ({ id, parentId: "m2", role: "bot", kind: "options", text: fields.subtitle, at: at(3), card: fields });

describe("a settled card in a simple chat", () => {
  // the server dismisses the intro's card on the first typed message (dismissOnboardingCard); its bubbles must stay
  it("keeps Madani's intro after the person has written, with only its chips gone", async () => {
    const intro: Message = { id: "i1", parentId: null, role: "bot", kind: "options", helperIntro: true, text: "Hey!", at: at(0),
      card: { title: "Hey!", subtitle: "", options: ["What are my bots up to?"], dismissed: true } };
    await draw([intro, { ...transcript([])[0]!, parentId: "i1" }, transcript([])[1]!]);
    expect(document.querySelector('[data-helper-intro="i1"]')).not.toBeNull();
    expect(document.querySelectorAll("[data-helper-line]").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-helper-step]")).toBeNull();
  });

  it("keeps an answered question in place, its title grey and only the picked choice", async () => {
    await draw(transcript([card("c1", { ...question, answered: "answer", answeredText: "Pricing" })]));
    const answered = document.querySelector<HTMLElement>('[data-ask-card="answered"]');
    expect(answered).not.toBeNull();
    expect(answered!.textContent).toContain("Which page?");
    expect(answered!.textContent).toContain("Pricing");
    expect(answered!.textContent).not.toContain("Home");
  });

  it("keeps a dismissed question with every choice greyed", async () => {
    await draw(transcript([card("c1", { ...question, dismissed: true })]));
    const dismissed = document.querySelector<HTMLElement>('[data-ask-card="dismissed"]');
    expect(dismissed?.textContent).toContain("Home");
    expect(dismissed?.querySelector("button")).toBeNull();
  });

  it("folds a decided permission to one centred grey line", async () => {
    await draw(transcript([card("c1", { ...permission, answered: "deny" })]));
    const row = document.querySelector<HTMLElement>('[data-approval-row="settled"]');
    expect(row).not.toBeNull();
    expect(row!.className).toContain("text-center");
    expect(row!.textContent).toContain(t("approval.status.denied"));
  });

  it("leaves no row for a stopped question", async () => {
    await draw(transcript([card("c1", { ...question, answered: "answer", answeredText: "Pricing", stopped: true })]));
    expect(document.querySelector("[data-ask-card]")).toBeNull();
  });
});
