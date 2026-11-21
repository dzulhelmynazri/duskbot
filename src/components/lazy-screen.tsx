import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";

// Not React.lazy: it suspends on every first render even with the chunk loaded (React holds a commit after a fallback
// up to 300 ms) and rethrows a failed import on every render. Chromium keeps a failed import() in its module map and
// rejects every later import of it without refetching.

export type LazyScreen<P> = ((props: P) => ReactNode) & {
  preload: () => Promise<ComponentType<P>>;
};

export function lazyScreen<Props>(
  name: string,
  load: () => Promise<(props: Props) => ReactNode>,
): LazyScreen<NonNullable<Props>> {
  type P = NonNullable<Props>;
  let ready: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const preload = () => (loading ??= load().then(
    (component) => (ready = component as ComponentType<P>),
    (error: unknown) => {
      loading = undefined;
      console.warn(`[lazy-screens] ${name} could not be loaded; reloading the window fetches it again.`, error);
      reloadOnce(name);
      throw error;
    },
  ));
  function Screen(props: P) {
    const [Loaded, setLoaded] = useState(() => ready);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (Loaded) return;
      let live = true;
      void preload().then(
        (component) => { if (live) setLoaded(() => component); },
        () => { if (live) setFailed(true); },
      );
      return () => {
        live = false;
      };
    }, [Loaded]);
    if (Loaded) return <Loaded {...props} />;
    return failed ? <ScreenUnavailable /> : null;
  }
  return Object.assign(Screen, { preload });
}

const RELOADED_KEY = "madanibot.screenReload";

// a failed chunk is usually a stale build or a file caught mid-edit; one quiet reload fetches it fresh, and only a
// second failure within a minute shows the notice
function reloadOnce(name: string) {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_KEY) ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    return;
  }
  console.warn(`[lazy-screens] reloading once for ${name}`);
  window.location.reload();
}

function ScreenUnavailable() {
  return createPortal(
    <div
      role="alert"
      data-screen-unavailable
      className="fixed bottom-4 left-1/2 z-[100] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-[14px] bg-menu py-2 pe-2 ps-3.5 text-[13px] leading-[18px] text-ink shadow-[0_8px_24px_rgb(0_0_0/0.12)] outline-[0.5px] outline-offset-[-0.5px] outline-transparent [outline-style:solid]"
    >
      <span>{t("screenLoad.failedShort")}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="h-7 shrink-0 rounded-full bg-ink/[0.06] px-3 text-[13px] font-medium text-ink hover:bg-ink/[0.1]"
      >
        {t("screenLoad.reload")}
      </button>
    </div>,
    document.body,
  );
}

