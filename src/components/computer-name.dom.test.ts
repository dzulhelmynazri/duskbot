// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useComputerName } from "./SidebarProfileMenu";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("stops standing in with the computer's name once the profile has its own (an account signed in)", async () => {
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = { desktopProfile: { systemName: async () => "Sam Mac" } };
  const seen: Array<string | null> = [];
  const Probe = ({ enabled }: { enabled: boolean }) => { seen.push(useComputerName(enabled)); return null; };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Probe, { enabled: true })); });
  expect(seen.at(-1)).toBe("Sam Mac");
  await act(async () => { root.render(createElement(Probe, { enabled: false })); });
  expect(seen.at(-1)).toBeNull();
  act(() => root.unmount());
});
