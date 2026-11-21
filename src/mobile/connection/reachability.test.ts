import { afterEach, expect, it } from "vitest";
import { forgetWorkspaceAnswers, noteWorkspaceAnswer, onWorkspaceAnswer, placeAnswered, workspaceAnsweredAt } from "./reachability";

afterEach(() => forgetWorkspaceAnswers());
const answer = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });

it("counts the place's own answers, never the edge's sleeping, waking or down ones", () => {
  expect(placeAnswered(answer(200))).toBe(true);
  expect(placeAnswered(answer(404))).toBe(true);
  expect(placeAnswered(answer(503, { "x-madani-cloud-power": "asleep" }))).toBe(false);
  expect(placeAnswered(answer(503, { "x-madani-cloud-power": "waking", "retry-after": "5" }))).toBe(false);
  expect(placeAnswered(answer(502))).toBe(false);
});

it("keeps when the place last answered, telling listeners at most once a second", () => {
  const heard: number[] = [];
  const stop = onWorkspaceAnswer((at) => heard.push(at));
  noteWorkspaceAnswer(1_000);
  noteWorkspaceAnswer(1_500);
  noteWorkspaceAnswer(2_100);
  stop();
  expect(heard).toEqual([1_000, 2_100]);
  expect(workspaceAnsweredAt()).toBe(2_100);
  forgetWorkspaceAnswers();
  expect(workspaceAnsweredAt()).toBeNull();
});
