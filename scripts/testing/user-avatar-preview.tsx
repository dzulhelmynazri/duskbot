// The person's avatar on this app's own page: the account card, the picker open over it, and the sidebar's person row,
// against a mocked accounts bridge. ?skin= picks the skin; ?sheet=0 leaves the sheet closed.
// Served only by scripts/testing/user-avatar-shots.ts.
import { createRoot } from "react-dom/client";
import { AccountsSheet } from "../../src/components/AccountMenu";
import { SidebarProfileMenu } from "../../src/components/SidebarProfileMenu";
import { applySkin, SKINS } from "../../src/lib/skins";
import { StoreProvider } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

const params = new URLSearchParams(location.search);
applySkin(SKINS.find((one) => one.id === params.get("skin"))?.id ?? "grok");
const active = { id: params.get("id") ?? "acc_7f3k2m9q", email: "ada@example.test", name: "Ada Lovelace", plan: { status: "active", tier: "pro" } };
const view = { active };
window.madaniDesktop = {
  platform: "darwin",
  remoteClient: { active: false },
  app: { ownPage: true },
  getCapabilities: async () => ({}),
  onCapabilitiesChanged: () => () => {},
  accounts: {
    list: async () => view,
    onChanged: () => () => {},
    setAvatar: async () => ({ outcome: "saved", view }),
    signOut: async () => ({ outcome: "signed-out", view: { active: null } }),
  },
} as unknown as typeof window.madaniDesktop;

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <div className="flex min-h-[100dvh] bg-app text-ink">
      <aside className="flex w-[260px] flex-col justify-end border-e border-hairline bg-panel p-2">
        <SidebarProfileMenu />
      </aside>
      <main className="relative flex-1">{params.get("sheet") !== "0" && <AccountsSheet onClose={() => {}} />}</main>
    </div>
  </StoreProvider>,
);
