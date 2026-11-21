// sign in to Claude and ChatGPT here, one click each, and the sign-in goes to the server privately
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle } from "../../icons";
import { ClaudeMark, CodexMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { VpsEngine, VpsLinkBridge, VpsServer, VpsSignIn } from "@/lib/vps-link";
import { smallButtonCls, textFieldCls } from "../ui/GrokDialog";
import { centered, deviceWord, ErrorNote, Footer, Heading, Lead, message, PILL, SOFT_PILL } from "./parts";

const POLL_MS = 2000;
const CARD = "flex w-[236px] max-w-full flex-col items-center justify-center gap-1.5 self-stretch rounded-[16px] border border-transparent px-4 py-3.5 text-center";

function EngineCard({ engine, bridge, onSignedIn }: { engine: VpsEngine; bridge: VpsLinkBridge; onSignedIn: () => void }) {
  const [flow, setFlow] = useState<VpsSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const openedUrl = useRef<string | null>(null);
  const signedInCallback = useRef(onSignedIn);
  signedInCallback.current = onSignedIn;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const flowId = flow?.flowId;
  const phase = flow?.phase;
  useEffect(() => {
    if (phase !== "waiting" || !flowId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let waiting = true;
      try {
        const next = await bridge.signInStatus(engine.instanceId, flowId);
        if (!active) return;
        setFlow(next);
        setError("");
        waiting = next.phase === "waiting";
        if (next.phase === "succeeded") signedInCallback.current();
        else if (next.phase !== "waiting") setError(next.message ?? t("vpsLink.signIn.didNotWork"));
        if (waiting && next.authorizationUrl && next.authorizationUrl !== openedUrl.current) {
          await bridge.openUrl(next.authorizationUrl);
          if (active) openedUrl.current = next.authorizationUrl;
        }
      } catch (cause) { if (active) setError(message(cause)); }
      finally { if (active && waiting) timer = setTimeout(() => void poll(), POLL_MS); }
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [flowId, phase, bridge, engine.instanceId]);

  const start = async () => {
    setBusy(true); setError(""); setCode("");
    try {
      const next = await bridge.signIn(engine.instanceId);
      if (!alive.current) return;
      setFlow(next);
      if (next.phase === "succeeded") onSignedIn();
      else if (next.authorizationUrl) {
        await bridge.openUrl(next.authorizationUrl);
        if (alive.current) openedUrl.current = next.authorizationUrl;
      }
    } catch (cause) { if (alive.current) setError(message(cause)); }
    finally { if (alive.current) setBusy(false); }
  };
  const sendCode = async () => {
    if (!flow?.flowId || !code.trim()) return;
    setBusy(true); setError("");
    try {
      await bridge.signInCode(engine.instanceId, flow.flowId, code.trim());
      if (alive.current) setFlow((current) => current?.flowId === flow.flowId && current.phase === "waiting" ? { ...current, needsCode: false } : current);
    } catch (cause) { if (alive.current) setError(message(cause)); }
    finally { if (alive.current) setBusy(false); }
  };
  const signedIn = engine.signedIn || flow?.phase === "succeeded";
  const waiting = flow?.phase === "waiting" && !signedIn;
  const name = engine.kind === "claude" ? t("vpsLink.signIn.claude") : t("vpsLink.signIn.chatgpt");
  const logo = engine.kind === "claude" ? <ClaudeMark size={28} /> : <CodexMark size={28} />;
  const codeId = `vps-code-${engine.instanceId}`;
  const face = (
    <>
      <span aria-hidden="true" className="flex size-9 items-center justify-center">{logo}</span>
      <span className="text-[15px] font-medium leading-5 text-ink">{name}</span>
    </>
  );

  if (!signedIn && !waiting) {
    return (
      <li data-vps-engine={engine.kind} className="flex w-[236px] max-w-full shrink flex-col items-center gap-2 self-stretch">
        <button type="button" disabled={busy} onClick={() => void start()}
          className={cn(CARD, "madani-press cursor-pointer outline-none enabled:hover:bg-ink/[0.035] enabled:active:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default")}>
          {face}
          <span className={cn("mt-1 inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[13px] leading-[18px]", busy ? "text-ink/56" : "bg-ink text-app")}>
            {busy && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {t("vpsLink.signIn.action")}
          </span>
        </button>
        {error && <ErrorNote>{error}</ErrorNote>}
      </li>
    );
  }
  return (
    <li data-vps-engine={engine.kind} data-signed-in={signedIn ? "" : undefined} className={CARD}>
      {face}
      {signedIn
        ? <span role="status" className="vps-land mt-1 inline-flex h-7 items-center gap-1.5 text-[13px] leading-[18px] text-success">
            <Check size={14} strokeWidth={2.5} aria-hidden="true" />{t("vpsLink.signIn.ready")}
          </span>
        : <>
            <span role="status" className="inline-flex items-center gap-1.5 text-[13px] leading-[18px] text-ink/68">
              <LoaderCircle size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span className="min-w-0">{flow?.message ?? t("vpsLink.signIn.finishInBrowser")}</span>
            </span>
            {flow?.userCode && <span className="text-[12px] leading-4 text-ink/56">{t("vpsLink.signIn.enterCode")}</span>}
            <span className="flex items-center gap-1.5">
              {flow?.userCode && <code className="select-all whitespace-nowrap rounded-[8px] border border-transparent px-2 py-0.5 font-mono text-[14px] leading-5 tracking-[0.08em] text-ink">{flow.userCode}</code>}
              {flow?.authorizationUrl && <button type="button" className={smallButtonCls} onClick={() => void bridge.openUrl(flow.authorizationUrl!)}>{t("vpsLink.signIn.again")}</button>}
            </span>
            {flow?.needsCode && <form className="flex w-full flex-col gap-1 text-start" onSubmit={(event) => { event.preventDefault(); void sendCode(); }}>
              <label htmlFor={codeId} className="text-[12px] leading-4 text-ink/68">{t("vpsLink.signIn.pasteCode")}</label>
              <span className="flex gap-1.5">
                <input id={codeId} value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} className={textFieldCls} />
                <button type="submit" disabled={busy || !code.trim()} className="ui-button ui-button-pill ui-button-primary shrink-0 px-3 text-[13px]">{t("vpsLink.continue")}</button>
              </span>
            </form>}
            {error && <ErrorNote>{error}</ErrorNote>}
          </>}
    </li>
  );
}

export function SignInScreen({ bridge, server, autoSkip, onDone }: { bridge: VpsLinkBridge; server: VpsServer | null; autoSkip: boolean; onDone: () => void }) {
  const [engines, setEngines] = useState<VpsEngine[] | null>(null);
  const [error, setError] = useState("");
  const [signed, setSigned] = useState<Set<string>>(new Set());
  const alive = useRef(true);
  const loadSequence = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;
  const serverId = server?.id;
  const load = useCallback(() => {
    const sequence = ++loadSequence.current;
    setError("");
    void bridge.engines().then((list) => {
      if (!alive.current || sequence !== loadSequence.current) return;
      setEngines(list);
      if (autoSkip && list.length > 0 && list.every((engine) => engine.signedIn)) done.current();
    }, (cause) => { if (alive.current && sequence === loadSequence.current) setError(message(cause)); });
  }, [bridge, autoSkip]);
  useEffect(() => {
    alive.current = true;
    setEngines(null);
    setSigned(new Set());
    load();
    return () => { alive.current = false; loadSequence.current++; };
  }, [load, serverId]);
  const name = server?.name ?? t("vpsLink.yourServer");
  const anyReady = Boolean(engines?.some((engine) => engine.signedIn || signed.has(engine.instanceId)));
  return (
    <>
      <Heading>{t("vpsLink.signIn.title")}</Heading>
      <Lead className="top-[calc(50%-58px)]">{t("vpsLink.signIn.hint", { name, device: deviceWord() })}</Lead>
      <div className={cn(centered, "top-[calc(50%-6px)] flex justify-center")}>
        {error
          ? <div className="flex flex-col items-center gap-3"><ErrorNote>{error}</ErrorNote><button type="button" className={SOFT_PILL} onClick={load}>{t("vpsLink.tryAgain")}</button></div>
          : engines === null
            ? <ul aria-busy="true" aria-label={t("vpsLink.signIn.listAria")} className="m-0 flex list-none gap-3 p-0">
                {[0, 1].map((slot) => <li key={slot} className={cn(CARD, "h-[124px]")}><span className="size-10 rounded-full bg-ink/6" /><span className="h-3 w-20 rounded-full bg-ink/6" /></li>)}
                <li className="sr-only">{t("vpsLink.signIn.loading")}</li>
              </ul>
            : engines.length === 0
              ? <p className="m-0 text-[13px] leading-[18px] text-ink/56">{t("vpsLink.signIn.none")}</p>
              : <ul aria-label={t("vpsLink.signIn.listAria")} className="m-0 flex list-none items-stretch justify-center gap-3 p-0">
                  {engines.map((engine) => <EngineCard key={`${serverId}:${engine.instanceId}`} engine={engine} bridge={bridge}
                    onSignedIn={() => setSigned((current) => new Set(current).add(engine.instanceId))} />)}
                </ul>}
      </div>
      <Footer>
        <button type="button" data-primary="" className={PILL} disabled={!anyReady} onClick={onDone}>{t("vpsLink.continue")}</button>
        <button type="button" className={SOFT_PILL} onClick={onDone}>{t("vpsLink.signIn.skip")}</button>
      </Footer>
    </>
  );
}
