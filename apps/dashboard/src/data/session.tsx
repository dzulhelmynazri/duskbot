import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommandKind, CommandView, WorkspaceDetail, WorkspaceSummary } from "../../../../shared/dashboard-protocol";
import { api, ApiError, type Account } from "../lib/api";
import { toast } from "../lib/toast";

const DETAIL_MS = 3_000;
const LIST_MS = 10_000;
const PICK = "madani-dash-workspace";

interface Session {
  account: Account | null | undefined;
  setAccount(account: Account | null): void;
  accountError: string | null;
  retryAccount(): void;
  workspacesError: string | null;
  workspaces: WorkspaceSummary[] | null;
  workspace: WorkspaceSummary | null;
  pick(id: string): void;
  detail: WorkspaceDetail | null;
  detailError: string | null;
  refresh(): void;
  command(kind: CommandKind, target: string, label: string): Promise<void>;
  pendingFor(kind: CommandKind | CommandKind[], target: string): CommandView | null;
  toast(text: string, tone?: "plain" | "bad"): void;
}

const Ctx = createContext<Session | null>(null);

const same = (a: unknown, b: unknown) => a !== null && JSON.stringify(a) === JSON.stringify(b);
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountTick, setAccountTick] = useState(0);
  const retryAccount = useCallback(() => setAccountTick((t) => t + 1), []);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [picked, setPicked] = useState<string | null>(() => new URLSearchParams(location.search).get("workspace") ?? localStorage.getItem(PICK));
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const local = useRef(new Map<string, CommandView>());

  useEffect(() => {
    let alive = true;
    setAccountError(null);
    api.me().then((r) => { if (alive) setAccount(r.account); }, (e) => {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 401) setAccount(null);
      else setAccountError((e as Error).message);
    });
    return () => { alive = false; };
  }, [accountTick]);

  // the workspace list, and with it the "someone is watching" signal the service passes on to workspaces
  useEffect(() => {
    if (!account) return;
    let alive = true;
    const ctl = new AbortController();
    const load = () => {
      if (!visible()) return;
      api.workspaces(ctl.signal).then((r) => { if (alive) { setWorkspaces((old) => same(old, r.workspaces) ? old : r.workspaces); setWorkspacesError(null); } }, (e) => {
        if (!alive || (e as Error).name === "AbortError") return;
        if (e instanceof ApiError && e.status === 401) setAccount(null);
        else setWorkspacesError((e as Error).message);
      });
    };
    load();
    const id = setInterval(load, LIST_MS);
    document.addEventListener("visibilitychange", load);
    return () => { alive = false; ctl.abort(); clearInterval(id); document.removeEventListener("visibilitychange", load); };
  }, [account, tick]);

  const workspace = useMemo(() => {
    if (!workspaces?.length) return null;
    return workspaces.find((w) => w.id === picked) ?? workspaces[0]!;
  }, [workspaces, picked]);

  useEffect(() => {
    if (!workspace) { setDetail(null); return; }
    let alive = true;
    const ctl = new AbortController();
    setDetail((d) => (d?.workspace.id === workspace.id ? d : null));
    const load = () => {
      if (!visible()) return;
      api.workspace(workspace.id, ctl.signal).then((d) => { if (alive) { setDetail((old) => same(old, d) ? old : d); setDetailError(null); } }, (e) => {
        if (!alive || (e as Error).name === "AbortError") return;
        if (e instanceof ApiError && e.status === 401) setAccount(null);
        else setDetailError((e as Error).message);
      });
    };
    load();
    const id = setInterval(load, DETAIL_MS);
    document.addEventListener("visibilitychange", load);
    return () => { alive = false; ctl.abort(); clearInterval(id); document.removeEventListener("visibilitychange", load); };
  }, [workspace?.id, tick]);

  const pick = useCallback((id: string) => {
    setPicked(id);
    localStorage.setItem(PICK, id);
    const url = new URL(location.href);
    url.searchParams.delete("workspace");
    history.replaceState(null, "", url.pathname + url.search);
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const command = useCallback(async (kind: CommandKind, target: string, label: string) => {
    if (!workspace) return;
    try {
      const { command } = await api.command(workspace.id, kind, target);
      local.current.set(command.id, command);
      toast(`${label}: sent to ${workspace.name}`);
      refresh();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  }, [workspace, refresh]);

  // a command's newest state: the service's answer wins over the copy kept when it was sent
  const pendingFor = useCallback((kinds: CommandKind | CommandKind[], target: string) => {
    const list = Array.isArray(kinds) ? kinds : [kinds];
    const seen = new Map<string, CommandView>();
    for (const c of local.current.values()) seen.set(c.id, c);
    for (const c of detail?.commands ?? []) seen.set(c.id, c);
    let newest: CommandView | null = null;
    for (const c of seen.values()) if (list.includes(c.kind) && c.target === target && (!newest || c.issuedAt > newest.issuedAt)) newest = c;
    return newest;
  }, [detail]);

  // tell the person when a command they sent here lands
  const announced = useRef(new Set<string>());
  useEffect(() => {
    for (const c of detail?.commands ?? []) {
      if (!local.current.has(c.id) || announced.current.has(c.id)) continue;
      if (c.status === "done") { announced.current.add(c.id); toast(c.message || "done"); }
      if (c.status === "failed" || c.status === "expired") {
        announced.current.add(c.id);
        toast(c.status === "expired" ? `${workspace?.name ?? "the workspace"} did not pick that up in time. is it online?` : c.message || "that did not work.", "bad");
      }
    }
  }, [detail, workspace?.name]);

  const value = useMemo<Session>(() => ({
    account, setAccount, accountError, retryAccount, workspacesError, workspaces, workspace, pick, detail: detail?.workspace.id === workspace?.id ? detail : null, detailError, refresh, command, pendingFor, toast,
  }), [account, accountError, retryAccount, workspacesError, workspaces, workspace, pick, detail, detailError, refresh, command, pendingFor]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
