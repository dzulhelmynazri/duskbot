import { Download } from "@/icons";
import android from "../art/os/android.svg";
import apple from "../art/os/apple.svg";
import linux from "../art/os/linux.svg";
import windows from "../art/os/windows.svg";
import { track } from "../lib/analytics";
import { detectOs, useReleaseState, WAITLIST_URL, type Platform } from "../lib/downloads";
import { Skeleton } from "./kit";

// os marks: gilbarbara/logos, cc0 1.0
const LOGO: Record<Platform, string> = { macos: apple, windows, linux, android, ios: apple };
const NAME: Record<Platform, string> = { macos: "macos", windows: "windows", linux: "linux", android: "android", ios: "ios" };

function Mark({ platform }: { platform: Platform }) {
  const src = LOGO[platform];
  // apple's mark is one colour, so it takes the ink and stays visible in both themes
  if (src === apple) return <span aria-hidden className="block size-[22px] bg-ink" style={{ maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")`, maskSize: "contain", WebkitMaskSize: "contain", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center" }} />;
  return <img src={src} alt="" width={22} height={22} className="size-[22px] object-contain" draggable={false} />;
}

const FILE = "https://github.com/dzulhelmynazri/madani-bot-releases/releases/latest/download/";
// the file itself, so a press downloads right here instead of opening another page
const DIRECT: Partial<Record<Platform, { href: string; also?: { label: string; href: string } }>> = {
  macos: { href: `${FILE}MadaniBot.dmg`, also: { label: "intel mac", href: `${FILE}MadaniBot-intel.dmg` } },
  windows: { href: `${FILE}MadaniBot-setup.exe` },
  linux: { href: `${FILE}MadaniBot.AppImage`, also: { label: ".deb", href: `${FILE}MadaniBot-amd64.deb` } },
};
const NOTE_DIRECT: Partial<Record<Platform, string>> = { macos: "apple silicon", windows: "windows 10 and 11", linux: "appimage" };

/** the visitor's own computer, downloading in place, then the phone apps, dimmed until they're out */
export function Downloads() {
  const release = useReleaseState();
  const detected = detectOs();
  const desktops: Platform[] = detected === "macos" || detected === "windows" || detected === "linux" ? [detected] : ["macos", "windows", "linux"];
  return (
    <ul className="flex flex-col gap-1.5" aria-label="downloads">
      {desktops.map((p) => {
        const direct = DIRECT[p]!;
        const soon = release === "soon";
        return (
          <li key={p} className="flex min-h-14 items-center gap-3.5 rounded-[16px] bg-card px-4 py-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-pop"><Mark platform={p} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-15 font-medium text-ink">{NAME[p]}</span>
              <span className="block truncate text-13 text-ink-3">
                {NOTE_DIRECT[p]}
                {direct.also && !soon && <> · <a href={direct.also.href} download className="underline-offset-2 hover:text-ink hover:underline"
                  onClick={() => track({ name: "download_click", props: { platform: p, detected_os: detected } })}>{direct.also.label}</a></>}
              </span>
            </span>
            {release === null
              ? <Skeleton className="h-5 w-20" />
              : <a href={soon ? WAITLIST_URL : direct.href} {...(soon ? { target: "_blank", rel: "noreferrer" } : { download: "" })}
                  onClick={() => track({ name: "download_click", props: { platform: p, detected_os: detected } })}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink px-3.5 py-1.5 text-14 text-pop transition-opacity hover:opacity-90">
                  {soon ? "join waitlist" : <><Download size={15} strokeWidth={1.75} aria-hidden />download</>}
                </a>}
          </li>
        );
      })}
      {(["ios", "android"] as const).map((p) => (
        <li key={p} aria-disabled="true" className="flex min-h-14 items-center gap-3.5 rounded-[16px] bg-card px-4 py-2.5 opacity-50">
          <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-pop"><Mark platform={p} /></span>
          <span className="min-w-0 flex-1 text-15 font-medium text-ink">{NAME[p]}</span>
          <span className="shrink-0 text-14 text-ink-3">coming soon</span>
        </li>
      ))}
    </ul>
  );
}
