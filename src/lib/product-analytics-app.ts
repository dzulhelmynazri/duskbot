import { useEffect, useRef } from "react";
import { syncHelpImprove } from "./help-improve";
import { configure, feature, screen } from "./product-analytics";

export function startDesktopAnalytics(): void {
  const bridge = window.madaniDesktop;
  if (!bridge) return;
  const platform = bridge.platform;
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return;
  const relay = bridge.productEvents;
  if (bridge.desktopAnalytics) { setTimeout(() => void syncHelpImprove(), 15_000); setInterval(() => void syncHelpImprove(), 10 * 60_000); }
  if (relay) {
    configure({ origin: null, token: null, relay, platform, version: bridge.app?.version || __APP_VERSION__, kind: "desktop" });
    return;
  }
  const apply = (staging = false) => configure({
    origin: import.meta.env.VITE_MADANI_ACCOUNT_ORIGIN || (staging ? "https://preview.madani.bot" : "https://madani.bot"),
    token: null, platform, version: bridge.app?.version || __APP_VERSION__, kind: "desktop",
  });
  if (bridge.cloudAccount) void bridge.cloudAccount.state().then(state => apply(state.staging === true), () => apply());
  else apply();
}

export function useProductScreen(path: string, chatId?: string | null): void {
  const lastChat = useRef<string | null>(null);
  useEffect(() => { screen(path); }, [path]);
  useEffect(() => {
    if (chatId && lastChat.current !== chatId) feature("chat_opened");
    lastChat.current = chatId ?? null;
  }, [chatId]);
}

export function useComputerAnalytics(id: string, visible: boolean): void {
  const shown = useRef("");
  useEffect(() => {
    const current = visible ? id : "";
    if (current && shown.current !== current) feature("computer_used");
    shown.current = current;
  }, [id, visible]);
}
