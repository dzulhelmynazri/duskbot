import { useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { createPortal } from "react-dom";

import {
  DOCS_URL,
  LICENSE_URL,
  RELEASES_URL,
  THIRD_PARTY_NOTICES_URL,
  appVersion,
  openExternalLink,
  platformLabel,
} from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { useOtherServerName } from "@/lib/other-server";
import { copyText } from "@/lib/copy-text";
import { formCloseCls, formSheetCls, mdSecondaryCls, rowHintCls, useDialogKeys } from "./ui/GrokDialog";
import { Icon } from "./Icon";
import { ScrimMotion, SheetMotion, useDialogMotion } from "./ui/SheetMotion";
import { cn } from "@/lib/cn";

/** The app's own version first; `server` (useOtherServerName: set only when the app's window shows another server) adds a
 * line naming it with the version its page runs. A browser, or an app too old to say, keeps the page's version on one line. */
export function aboutVersionLines({ app, bundle, platform, server }: {
  app?: { version: string } | null;
  bundle: string;
  platform: string | null;
  server: string | null;
}): string[] {
  const line = (version: string) => `${t("about.version", { version })}${platform ? ` · ${platform}` : ""}`;
  if (!app?.version) return [line(bundle)];
  return server ? [line(app.version), t("about.connectedTo", { name: server, version: bundle })] : [line(app.version)];
}

/** Grok's About: the icon, the name and version, Copy version info, and a close at the corner. */
export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <AnimatePresence>{open && <AboutSheet key="about" onClose={onClose} />}</AnimatePresence>;
}

function AboutSheet({ onClose }: { onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const close = useDialogKeys(sheet, onClose);
  const played = useDialogMotion();
  const server = useOtherServerName(true);
  const [copied, setCopied] = useState(false);
  const lines = aboutVersionLines({ app: window.madaniDesktop?.app, bundle: appVersion(), platform: platformLabel(window.madaniDesktop?.platform), server });
  const [version, connected] = lines;
  const copy = () => void copyText([productName(), ...lines].join("\n")).then((result) => setCopied(result === "copied"));

  return createPortal(
    <div {...played.layer} className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <ScrimMotion {...played.scrim} aria-hidden="true" className="ui-dialog-scrim absolute inset-0" onMouseDown={() => close.current()} />
      <SheetMotion
        {...played.sheet}
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        tabIndex={-1}
        className={cn(formSheetCls, "max-w-[320px] items-center px-6 pb-6 pt-8 text-center")}
      >
        <button type="button" aria-label={t("common.close")} onClick={() => close.current()} className={cn(formCloseCls, "absolute right-3 top-3")}>
          <Icon name="close" size={16} />
        </button>
        <img src="/app-icon.svg" alt="" width={64} height={64} className="size-16" />
        <h2 id="about-dialog-title" className="m-0 mt-2 text-[20px] font-semibold leading-7 text-ink">{productName()}</h2>
        <p className="m-0 mt-1 text-[12px] leading-4 tracking-[0.01em] text-ink">{version}</p>
        {connected && <p className="m-0 mt-0.5 text-[12px] leading-4 tracking-[0.01em] text-ink/68">{connected}</p>}
        <p className={cn(rowHintCls, "m-0 mt-2 text-[11px] leading-4 text-pretty")}>
          {t("about.license")}
        </p>
        <div className="mt-1.5 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[12px] leading-4">
          <AboutLink href={DOCS_URL} label={t("about.docs")} />
          <AboutLink href={RELEASES_URL} label={t("about.releases")} />
          <AboutLink href={LICENSE_URL} label={t("about.licenseLink")} />
          <a href={THIRD_PARTY_NOTICES_URL} target="_blank" rel="license noopener noreferrer" className={aboutLinkCls}>{t("about.notices")}</a>
        </div>
        <button type="button" data-autofocus onClick={copy} className={cn(mdSecondaryCls, "mt-4")}>
          {copied ? t("about.copied") : t("about.copyVersion")}
        </button>
      </SheetMotion>
    </div>,
    document.body,
  );
}

const aboutLinkCls = "rounded-sm text-ink/68 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

function AboutLink({ href, label }: { href: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => void openExternalLink(href)}
      className={aboutLinkCls}
    >
      {label}
    </button>
  );
}
