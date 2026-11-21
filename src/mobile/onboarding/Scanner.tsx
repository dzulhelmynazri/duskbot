import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Flashlight, FlashlightOff, Keyboard, Link2, X } from "../../icons";
import { MausAvatar } from "@/components/Avatar";
import { WorkingDots } from "@/components/WorkingIndicator";
import { t } from "@/lib/i18n";
import { haptic } from "../haptics";
import { dur, ease, spring } from "../motion";
import type { CameraSession, MobilePlatform } from "../platform";

/** The viewfinder fills the width but a margin, up to a size that still leaves room for the title and the buttons. */
const frameSize = () => Math.round(Math.max(240, Math.min((globalThis.innerWidth || 390) - 56, 360)));
/** One camera session at a time: a new scanner waits for the last one to finish closing (a quick close and reopen, or a
 * dev double mount), since a start racing a stop leaves the native preview dark. */
let lastStop: Promise<unknown> = Promise.resolve();

/** Our own viewfinder over the live camera: four soft corners, a slow sweep, and a mascot peeking over the top edge that
 * looks down at the code. The camera itself draws behind a transparent page natively, or into a <video> in a browser. */
export function Scanner({ platform, busy, onCode, onClose, onEnterCode, onPaste }: {
  platform: MobilePlatform;
  /** A code was read and is being redeemed: the sweep stops and the mascot works. */
  busy: boolean;
  onCode: (text: string) => void;
  onClose: () => void;
  onEnterCode: () => void;
  onPaste: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const session = useRef<CameraSession | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [seen, setSeen] = useState(false);
  const [frame] = useState(frameSize);
  // an iPhone may draw the whole scanner natively; until it says, the page draws nothing of its own over the camera
  const [mode, setMode] = useState<"pending" | "web" | "native">(platform.kind === "ios" ? "pending" : "web");
  const read = useRef(onCode);
  read.current = onCode;
  const actions = useRef({ onClose, onEnterCode, onPaste });
  actions.current = { onClose, onEnterCode, onPaste };
  const native = mode === "native";

  useEffect(() => {
    let stopped = false;
    const camera = platform.camera;
    if (!camera) { setUnavailable(true); return; }
    let fullScreen = false;
    const starting = lastStop.catch(() => {}).then(() => stopped ? null : camera.start({
      video: videoRef.current,
      overlay: {
        title: t("mobile.onboarding.scanTitle"),
        hint: t("mobile.onboarding.scanHint"),
        close: t("mobile.sheet.close"),
        torch: t("mobile.onboarding.torch"),
        actions: [
          { key: "code", title: t("mobile.onboarding.enterCode"), icon: "keyboard" },
          { key: "paste", title: t("mobile.onboarding.pasteLink"), icon: "link" },
        ],
      },
      onAction: (key) => {
        if (stopped) return;
        if (key === "close") actions.current.onClose();
        else if (key === "code") actions.current.onEnterCode();
        else if (key === "paste") actions.current.onPaste();
      },
      onCode: (text) => {
        if (stopped) return;
        // the system's scanner gives its own haptic as it reads
        if (!fullScreen) haptic("hold");
        setSeen(true);
        read.current(text);
      },
      onError: (message) => { if (message === "unsupported") setUnavailable(true); },
    }));
    void starting.then((live) => {
      if (!live) return;
      session.current = live;
      fullScreen = Boolean(live.fullScreen);
      if (stopped) return;
      setMode(fullScreen ? "native" : "web");
      if (live.torch) setTorch(false);
    }).catch(() => { if (!stopped) { setUnavailable(true); setMode("web"); } });
    return () => {
      stopped = true;
      session.current = null;
      // the native camera needs a beat after closing before it will open again
      lastStop = starting.then((live) => live?.stop()).then(() => new Promise((resolve) => setTimeout(resolve, 250))).catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    if (native) session.current?.busy?.(busy, t("mobile.onboarding.linking"));
  }, [native, busy]);

  const toggleTorch = () => {
    const live = session.current;
    if (!live?.torch || torch === null) return;
    haptic("pick");
    void live.torch.set(!torch).then(() => setTorch(!torch)).catch(() => {});
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 overflow-hidden"
      data-scan-clear
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.16 } }}
      transition={{ duration: dur.base }}
      role="dialog" aria-modal="true" aria-label={t("mobile.onboarding.scanTitle")}
    >
      {platform.kind === "web" && <video ref={videoRef} className="absolute inset-0 size-full object-cover" muted playsInline autoPlay aria-hidden />}
      {(unavailable || mode !== "web") && <div aria-hidden className="absolute inset-0 bg-[#121212]" />}
      {mode === "web" && <>

      <div className="absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2" style={{ width: frame, height: frame }}>
        <div aria-hidden className="absolute inset-0 rounded-[44px]" style={{ boxShadow: "0 0 0 200vmax rgb(6 8 14 / 0.64)" }} />
        {(["left-0 top-0 border-l-[3.5px] border-t-[3.5px] rounded-tl-[44px]", "right-0 top-0 border-r-[3.5px] border-t-[3.5px] rounded-tr-[44px]", "bottom-0 left-0 border-b-[3.5px] border-l-[3.5px] rounded-bl-[44px]", "bottom-0 right-0 border-b-[3.5px] border-r-[3.5px] rounded-br-[44px]"]).map((corner) => (
          <motion.span key={corner} aria-hidden className={`absolute size-16 border-white ${corner}`}
            animate={{ scale: seen ? 0.94 : 1, borderColor: seen ? "#7ce3b0" : "#ffffff" }} transition={spring.lively} />
        ))}
        {!busy && !unavailable && (
          <div aria-hidden className="absolute inset-x-6 top-6 overflow-hidden" style={{ height: frame - 48 }}>
            <span className="madani-scanline absolute inset-x-0 top-0 block h-16" style={{ ["--scan-travel" as string]: `${frame - 48 - 64}px`, background: "linear-gradient(180deg, transparent, rgb(255 255 255 / 0.14) 70%, rgb(255 255 255 / 0.55) 100%)", borderRadius: 2 }} />
          </div>
        )}
        <div aria-hidden className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[62%]">
          <MausAvatar color="blue" bodyId="kit" size={64} state={busy ? "working" : seen ? "happy" : "curious"} gaze={{ x: 0, y: 1 }} label="" />
        </div>
        {unavailable && (
          <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-[15px] leading-6 text-white/75">{t("mobile.onboarding.noCamera")}</div>
        )}
        <AnimatePresence>
          {busy && (
            <motion.div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-[44px] bg-[rgb(10_12_20/0.55)] text-white" role="status"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: dur.fast }}>
              <WorkingDots size={5} />
              <span className="text-[15px] font-medium">{t("mobile.onboarding.linking")}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-[calc(var(--m-safe-top)+8px)]">
        <button type="button" onClick={onClose} aria-label={t("mobile.sheet.close")} className="mobile-press flex size-11 items-center justify-center rounded-full bg-white/[0.14] text-white backdrop-blur-md"><X size={20} /></button>
        {torch !== null && (
          <button type="button" onClick={toggleTorch} aria-pressed={torch} aria-label={t("mobile.onboarding.torch")} className="mobile-press flex size-11 items-center justify-center rounded-full bg-white/[0.14] text-white backdrop-blur-md">
            {torch ? <Flashlight size={19} /> : <FlashlightOff size={19} />}
          </button>
        )}
      </div>

      <motion.div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-5 px-6 pb-[calc(var(--m-safe-bottom)+24px)] text-center"
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: dur.base, ease: ease.out, delay: 0.08 }}>
        <div>
          <p className="text-[19px] font-semibold text-white">{t("mobile.onboarding.scanTitle")}</p>
          <p className="mt-1.5 text-[15px] leading-6 text-white/65">{t("mobile.onboarding.scanHint")}</p>
        </div>
        <div className="flex gap-2.5">
          <button type="button" onClick={onEnterCode} className="mobile-press flex h-11 items-center gap-2 rounded-full bg-white/[0.14] px-4 text-[15px] font-medium text-white backdrop-blur-md"><Keyboard size={17} />{t("mobile.onboarding.enterCode")}</button>
          <button type="button" onClick={onPaste} className="mobile-press flex h-11 items-center gap-2 rounded-full bg-white/[0.14] px-4 text-[15px] font-medium text-white backdrop-blur-md"><Link2 size={17} />{t("mobile.onboarding.pasteLink")}</button>
        </div>
      </motion.div>
      </>}
    </motion.div>
  );
}
