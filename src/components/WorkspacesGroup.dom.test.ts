// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: [], config: {} }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/places", async (original) => ({ ...await original<typeof import("@/lib/places")>(), usePlaces: () => ({ places: [] }) }));
vi.mock("./DesktopWorkspaceSwitcher", () => ({ useWorkspacePlace: () => ({ current: null, error: "" }) }));
vi.mock("@/lib/vps-cloud-move", () => ({ useVpsCloudMove: () => ({ view: null }) }));
vi.mock("./CloudMoveSettings", () => ({ CloudMoveRow: () => null }));
import { WorkspacesGroup } from "./WorkspacesSettings";

afterEach(() => { vi.unstubAllGlobals(); delete (window as { madaniDesktop?: unknown }).madaniDesktop; document.body.replaceChildren(); });

async function addRow(desktop: unknown) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  (window as { madaniDesktop?: unknown }).madaniDesktop = desktop;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const onAdd = vi.fn();
  await act(async () => root.render(createElement(WorkspacesGroup, { onAdd })));
  const row = host.querySelector<HTMLElement>('[data-settings-open="add-workspace"]');
  if (row) await act(async () => row.click());
  await act(async () => root.unmount());
  return { shown: Boolean(row), onAdd };
}

it("offers adding a cloud or a server of one's own on this computer's own page, as before", async () => {
  const { shown, onAdd } = await addRow({ app: { version: "1", ownPage: true }, workspaces: {} });
  expect(shown).toBe(true);
  expect(onAdd).toHaveBeenCalledTimes(1);
});

it("leaves the row out entirely in a madani cloud or server window and in a remote client", async () => {
  expect((await addRow({ app: { version: "1", ownPage: false }, workspaces: {} })).shown).toBe(false);
  expect((await addRow({ app: { version: "1", ownPage: true }, remoteClient: { active: true } })).shown).toBe(false);
});
