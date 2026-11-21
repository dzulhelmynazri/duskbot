import { useEffect } from "react";
import { effectiveLanguage, useLanguageChoice, usePageLanguage } from "@/lib/language-preference";
import { wearSkin } from "@/lib/skins";
import { AccountsSheet, useAccountsSheet } from "./AccountMenu";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";

/** The rail's page (main's chrome-rail.mjs), in the skin and language of the app. The window shows no strip of places, so
 * the page only hosts the accounts sheet, which main lays over the whole window while it is open. */
export function ChromeRail() {
  usePageLanguage(effectiveLanguage(useLanguageChoice(), undefined));
  // The page beside the rail chose its skin: the rail wears the same one.
  useEffect(() => window.madaniDesktop?.rail?.onSkin?.(wearSkin), []);
  const accounts = useAccountsSheet();
  return <DesktopCapabilitiesProvider><div data-chrome-rail className="h-full">{accounts.open && <AccountsSheet onClose={accounts.close} />}</div></DesktopCapabilitiesProvider>;
}
