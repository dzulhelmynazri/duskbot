import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Minus } from "@/icons";
import { useCloud } from "../data/cloud";
import type { CloudDesktop } from "../data/contracts";
import { canDeleteData, DELETE_WINDOW_DAYS, deleteDataError, deleteToken, deletion, forgetDeleteToken, needsSignIn, signInAgain, stashDeleteToken, takeRetry } from "../data/delete-data";
import { useSession } from "../data/session";
import { api, ApiError } from "../lib/api";
import { longDate } from "../lib/format";
import { navigate } from "../lib/router";
import { Button, ButtonLink, Card, Skeleton } from "../ui/kit";
import { SkyEmpty } from "../ui/Sky";

const GOES = ["your bots and their chats", "files, and the sign-ins saved on it", "every backup of it"];

function Sheet({ title, children, actions, error }: { title: string; children: ReactNode; actions: ReactNode; error: string | null }) {
  return (
    <div className="mx-auto max-w-[480px] pt-10">
      <Card className="enter" aria-labelledby="delete-title">
        <div aria-live="polite">
          <h1 id="delete-title" className="text-20 font-medium text-ink">{title}</h1>
          {children}
        </div>
        {error && <p role="alert" className="mt-3 text-13 text-bad">{error}</p>}
        <div className="mt-6 flex flex-wrap gap-2">{actions}</div>
      </Card>
    </div>
  );
}

/** /clouds/:id/delete, opened from the emailed link: confirms deleting a managed cloud's data after the undo window */
export function DeleteDataPage({ id }: { id: string }) {
  const { clouds, refresh } = useCloud();
  const { account, setAccount, toast } = useSession();
  const [token] = useState(() => { stashDeleteToken(); return deleteToken(id); });
  const [signIn, setSignIn] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<"confirm" | "cancel" | "signin" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cloud = clouds?.find((c) => c.id === id) ?? null;
  const name = cloud?.name ?? "your cloud";
  const at = scheduledAt ?? cloud?.deleteScheduledAt ?? null;

  const confirm = useCallback(async () => {
    if (!token) return;
    setBusy("confirm"); setError(null);
    try {
      const answer = await api.confirmDeleteData(id, token);
      forgetDeleteToken(id);
      setScheduledAt(answer.deleteScheduledAt); setSignIn(false);
      refresh();
    } catch (e) {
      if (needsSignIn(e)) setSignIn(true);
      else {
        setError(deleteDataError(e));
        if (e instanceof ApiError && e.code === "confirmation_required") forgetDeleteToken(id);
      }
    } finally { setBusy(null); }
  }, [id, token, refresh]);

  // back from signing in again: go on with the confirmation the person already chose
  useEffect(() => { if (token && takeRetry("confirm", id)) void confirm(); }, [confirm, id, token]);

  const cancel = async () => {
    setBusy("cancel"); setError(null);
    try {
      await api.cancelDeleteData(id);
      toast(`deletion cancelled. ${cloud?.name ?? "your cloud"} keeps its data.`);
      refresh(); navigate("/cloud");
    } catch (e) { setError(deleteDataError(e)); } finally { setBusy(null); }
  };
  const keep = () => { forgetDeleteToken(id); navigate("/cloud"); };
  const again = async () => { setBusy("signin"); await signInAgain("confirm", id, setAccount); };
  const keepButton = <Button variant="ghost" onClick={keep} disabled={busy !== null}>keep my cloud</Button>;

  if (at !== null) {
    return (
      <Sheet
        title={`deleting on ${longDate(at)}`}
        error={error}
        actions={<><Button onClick={() => void cancel()} disabled={busy !== null}>{busy === "cancel" ? "cancelling" : "cancel deletion"}</Button><ButtonLink to="/cloud" variant="ghost">back to madani cloud</ButtonLink></>}
      >
        <p className="mt-1.5 text-14 leading-[1.55] text-ink-3">the bots, chats, files, sign-ins and backups on {name} go then, and it cannot be undone after that. until then you can cancel and keep everything.</p>
      </Sheet>
    );
  }
  if (clouds === null) return <div className="mx-auto max-w-[480px] pt-10" aria-busy="true" aria-label="loading"><Skeleton className="h-[300px] !rounded-card" /></div>;
  if (!cloud) {
    return (
      <SkyEmpty title="this cloud is not on your account" action={<ButtonLink to="/cloud" variant="primary">go to madani cloud</ButtonLink>}>
        you are signed in as {account?.email ?? "another account"}. sign in as the cloud's owner, then open the link from the email again.
      </SkyEmpty>
    );
  }
  if (!token) {
    return (
      <SkyEmpty title="this link has nothing to confirm" action={<ButtonLink to="/cloud" variant="primary">go to madani cloud</ButtonLink>}>
        open the newest link from the email in this browser. if it has expired, ask again from your madani cloud page.
      </SkyEmpty>
    );
  }
  if (signIn) {
    return (
      <Sheet title="sign in again to go on" error={error} actions={<><Button variant="primary" onClick={() => void again()} disabled={busy !== null}>{busy === "signin" ? "signing out" : "sign in again"}</Button>{keepButton}</>}>
        <p className="mt-1.5 text-14 leading-[1.55] text-ink-3">deleting data needs a sign-in from the last 10 minutes, so we know it is you. this tab keeps your link while you sign in, then deletes the data on {name} in {DELETE_WINDOW_DAYS} days.</p>
      </Sheet>
    );
  }
  return (
    <Sheet
      title={`delete the data on ${name}?`}
      error={error}
      actions={<><Button variant="danger" onClick={() => void confirm()} disabled={busy !== null}>{busy === "confirm" ? "scheduling" : `delete in ${DELETE_WINDOW_DAYS} days`}</Button>{keepButton}</>}
    >
      <p className="mt-1.5 text-14 leading-[1.55] text-ink-3">everything on it goes, along with its backups:</p>
      <ul className="mt-3 flex flex-col gap-2">
        {GOES.map((line) => <li key={line} className="flex gap-2.5 text-14 text-ink-2"><Minus size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-4" aria-hidden />{line}</li>)}
      </ul>
      <p className="mt-4 text-14 leading-[1.55] text-ink-3">nothing happens for {DELETE_WINDOW_DAYS} days, and you can cancel any time before then. after that it cannot be undone.</p>
    </Sheet>
  );
}

/** on the cloud page: an owner-confirmed deletion that is coming, with a way out */
export function DeletionBanner({ cloud }: { cloud: CloudDesktop }) {
  const { refresh } = useCloud();
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!cloud.deleteScheduledAt) return null;
  const cancel = async () => {
    setBusy(true); setError(null);
    try { await api.cancelDeleteData(cloud.id); toast(`deletion cancelled. ${cloud.name} keeps its data.`); refresh(); }
    catch (e) { setError(deleteDataError(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 !py-4" aria-labelledby="deleting-title">
      <div className="min-w-0 flex-1">
        <h2 id="deleting-title" className="text-15 font-medium text-bad">deleting on {longDate(cloud.deleteScheduledAt)}</h2>
        <p className="mt-0.5 text-14 text-ink-3">its bots, chats, files, sign-ins and backups go then. cancel to keep everything.</p>
        {error && <p role="alert" className="mt-1 text-13 text-bad">{error}</p>}
      </div>
      <Button onClick={() => void cancel()} disabled={busy}>{busy ? "cancelling" : "cancel deletion"}</Button>
    </Card>
  );
}

/** in the cloud's About card once its plan has ended: asks for the confirmation email */
export function DeleteDataAction({ cloud }: { cloud: CloudDesktop }) {
  const { billing, refresh } = useCloud();
  const { setAccount } = useSession();
  const [state, setState] = useState<"idle" | "busy" | "sent" | "signin">("idle");
  const [error, setError] = useState<string | null>(null);
  const asked = deletion(cloud) === "asked";
  const shown = state === "sent" || asked || canDeleteData(cloud, billing);

  const ask = useCallback(async () => {
    setState("busy"); setError(null);
    try { await api.askDeleteData(cloud.id); setState("sent"); refresh(); }
    catch (e) {
      if (needsSignIn(e)) setState("signin");
      else { setState("idle"); setError(deleteDataError(e)); }
    }
  }, [cloud.id, refresh]);

  useEffect(() => { if (shown && takeRetry("ask", cloud.id)) void ask(); }, [shown, ask, cloud.id]);

  if (!shown) return null;
  const quiet = "text-link mt-1 inline-flex h-8 items-center text-13 disabled:opacity-45 max-sm:h-11";
  return (
    <div className="mt-4" aria-live="polite">
      {state === "sent" ? <p className="text-13 text-ink-2">check your email to confirm. the link works for an hour.</p>
        : asked && state !== "signin" ? <p className="text-13 text-ink-2">waiting for you to confirm from the email. the link works for an hour after you asked.</p>
        : state === "signin" ? (
          <>
            <p className="text-13 text-ink-3">deleting data needs a sign-in from the last 10 minutes, so we know it is you.</p>
            <button type="button" className={quiet} onClick={() => void signInAgain("ask", cloud.id, setAccount)}>sign in again</button>
          </>
        ) : (
          <>
            <p className="text-13 text-ink-3">its plan has ended, so its data is kept for 30 days and then deleted. start a plan again before then and it comes back with everything. to delete it sooner, we email you a link to confirm.</p>
            <button type="button" className={quiet} disabled={state === "busy"} onClick={() => void ask()}>{state === "busy" ? "sending" : "delete data now"}</button>
          </>
        )}
      {error && <p role="alert" className="mt-1 text-13 text-bad">{error}</p>}
    </div>
  );
}
