import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { api, useStore, type Action } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { connectorDescription } from "@/lib/app-catalog";
import { closeExternalPage } from "@/lib/app-links";
import { listLogins } from "@/lib/logins";
import { connectorStatusMemory, preloadConnectedApps } from "@/lib/connected-apps";
import { useMcpServers } from "@/lib/mcp-servers";
import { HOSTED_MCP_APPS, type HostedConnections, type HostedMcpAppId } from "@/lib/hosted-mcp-apps";
import { managedConnectorUnavailableReason } from "../../../shared/connector-availability";
import { hasActiveConnection } from "@/lib/connector-status";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import type { SkillsLibrarySkillWire } from "../../../shared/wire";
import { Icon } from "../Icon";
import { MadaniMark } from "../mascot-view";
import { AppsSection } from "../AppsSection";
import { McpServersPanel } from "../McpServersPanel";
import { XCard } from "../XCard";
import { EmailCard } from "../EmailCard";
import { openKeySettings } from "../keys/key-focus";
import { botsUsingService } from "./connector-helpers";
import { AppRow, AppTile, GlyphTile, type RowAction } from "./AppRow";
import { AppFacts, AppPage, appFacts, type AppPageModel, type Way } from "./AppPage";
import { OnePasswordBody } from "./OnePasswordBody";
import { GmailPasswordNote, TokenCard } from "./TokenCard";
import { useTokenApps } from "./use-token-apps";
import { TOKEN_APPS, tokenApp, type TokenAppId } from "../../../shared/app-tokens";
import { NATIVE_CONNECTORS } from "../../../shared/native-connectors";
import type { OnePasswordStatus } from "../../../shared/logins";
import { CategoryMenu } from "./CategoryMenu";
import {
  CATEGORY_LABEL, INLINE_CHIPS, SECTION_SIZE, fromCatalog, grokCategories, inCategory, matchRank, popularity, presentCategories, recommended, searchApps,
  type AppEntry, type Category, type Connection,
} from "./catalog";
import { MCP_SERVERS_ID as MCP_PAGE, type ConnectAppsPage } from "./open";
import { cachedConnectorCatalog, loadConnectorCatalog, useConnectors, type ConnectorPhase } from "./use-connectors";
import { appLogo } from "./logos";
import { composioLogo, loadComposioSnapshot, snapshotToolkit } from "./composio-snapshot";
import { prefetchRemoteApps, useRemoteApps } from "./use-remote-apps";
import { idsOf, mergeEntries } from "./merge";
import { WindowedRows } from "./WindowedRows";
import type { DirectoryApp } from "../../../shared/connector-directory";
import type { ToolkitCard } from "../ServiceIcon";
import "./connect-apps.css";

type NativeId = "x" | "email";
const NATIVE_IDS: readonly NativeId[] = ["email", "x"];
const RECOMMENDED = "recommended";
const ALL_APPS = "apps";
const CONNECTED = "connected";
/** Any MCP server by its URL, kept with the MCP servers Settings has. */
const CUSTOM_MCP = "custom-mcp";
// a section this long draws only the rows in view
const WINDOW_FROM = 40;
const SETTINGS = (section: "logins" | "skills"): Action => ({ type: "toggleAppSettings", open: true, section });
// the longest the window waits for what it has not read yet before it draws its rows anyway
const READY_WAIT_MS = 1_200;
const OWN_KINDS: ReadonlySet<AppEntry["kind"]> = new Set(["native", "hosted", "logins", "token"]);
const GMAIL = "gmail";
const GMAIL_ADDRESS = /@(gmail|googlemail)\.com$/i;

// what the last open learned, so the next one draws its first frame with it instead of filling in
const memory: {
  natives: Record<NativeId, boolean | null>;
  hosted: HostedConnections | null;
  onePassword: OnePasswordStatus | null;
  skills: SkillsLibrarySkillWire[] | null;
} = { natives: { x: null, email: null }, hosted: null, onePassword: null, skills: null };
// a row keeps the place it was first drawn in for the whole session, whichever source answers later
const rowOrder = new Map<string, number>();

/** The merged list in the order its rows were first drawn, new rows after. */
export function stableOrder(entries: readonly AppEntry[], order: Map<string, number> = rowOrder): AppEntry[] {
  for (const entry of entries) if (!order.has(entry.id)) order.set(entry.id, order.size);
  return [...entries].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

interface Section { key: string; title: string; note?: string; ids: string[]; viewAll?: ConnectAppsPage }
/** One view's chips and sections, fixed when it is first drawn: later answers change a row's button, never its place. */
interface Layout { view: number; categories: Category[]; sections: Section[] }

function logoIcon(...names: string[]): AppEntry["icon"] {
  const logo = appLogo(...names);
  return logo ? { image: logo.src, padded: logo.padded, background: logo.background, scale: logo.scale } : {};
}

/** Grok's logo when it has one, then the catalog's own mark, then Composio's mark for the slug: never a favicon. */
function cardIcon(card: ToolkitCard): AppEntry["icon"] {
  const known = logoIcon(card.slug, card.label);
  if (known.image) return known;
  return { logo: card.logo ?? composioLogo(card.slug), padded: true };
}

/** Our bundled logo when we have one, else the vendor site's own icon through /api/site-icon. */
function remoteIcon(app: DirectoryApp): AppEntry["icon"] {
  const known = logoIcon(app.id, app.label);
  return known.image ? known : { domain: app.domain };
}


const TOKEN_CATEGORY: Record<TokenAppId, string> = {
  github: "developer code", notion: "documents notes", linear: "project management", airtable: "database", todoist: "task",
  trello: "project management", clickup: "project management", hubspot: "crm", jira: "project management", shopify: "commerce",
  stripe: "payments", cloudflare: "developer cloud", googledrive: "file storage", dropbox: "file storage",
};

function nativeEntries(): AppEntry[] {
  return [
    { id: "1password", kind: "logins", label: "1Password", description: t("connectApps.onePassword.description"), categories: ["credentials"], icon: logoIcon("1password"), website: "1password.com", keywords: "password vault logins" },
    { id: "email", kind: "native", label: t("email.title"), description: t("email.description"), categories: ["communication"], icon: { glyph: "envelope", glyphPaint: "rgb(229 47 139)" }, keywords: "email mail imap smtp mailbox" },
    { id: "x", kind: "native", label: t("apps.x.title"), description: t("apps.x.description"), categories: ["marketing"], icon: logoIcon("x"), website: "x.com", keywords: "x twitter posts", oneClick: true },
    { id: GMAIL, kind: "native", label: "Gmail", description: t("tokenApps.gmail.description"), categories: ["communication"], icon: logoIcon("gmail"), website: "mail.google.com", keywords: "gmail google mail app password imap" },
    ...TOKEN_APPS.map((app): AppEntry => ({
      id: app.id, kind: "token", label: app.label, description: t(`tokenApps.description.${app.id}` as LocaleKey), categories: grokCategories([TOKEN_CATEGORY[app.id]]),
      icon: logoIcon(app.id, app.label).image ? logoIcon(app.id, app.label) : { domain: app.domain }, website: app.domain, keywords: `${app.id} token api key`,
      // a sign-in that comes back by itself is one click; a device code to type, or a token to paste, is not
      ...(NATIVE_CONNECTORS.some((one) => one.id === app.id && one.flow !== "device") ? { oneClick: true } : {}),
    })),
    { id: CUSTOM_MCP, kind: "native", label: t("connectApps.customMcp"), description: t("connectApps.customMcp.description"), categories: ["code"], icon: { glyph: "plug" }, keywords: "custom mcp server url remote http headers oauth" },
    ...HOSTED_MCP_APPS.map((app): AppEntry => ({
      id: app.id, kind: "hosted", label: app.label, description: t(app.description), categories: ["finance"],
      icon: "image" in app.icon ? { image: app.icon.image } : { glyph: "credit-card", glyphPaint: "rgb(48 49 54)" }, website: new URL(app.url).hostname.replace(/^mcp\./, ""), keywords: app.keywords, oneClick: true,
    })),
  ];
}

function decodeImage(src: string): Promise<void> {
  const image = new Image();
  image.src = src;
  return image.decode().catch(() => {});
}

/** What the window's first frame shows, read ahead: the catalog, what is connected and every bundled logo, so it opens
 * complete instead of filling in. */
export function prepareConnectApps(): Promise<void> {
  const logos = (cards: readonly ToolkitCard[]) => Promise.all([...nativeEntries().map((entry) => entry.icon), ...cards.map(cardIcon)]
    .flatMap((icon) => (icon.image ? [decodeImage(icon.image)] : [])));
  const catalog = cachedConnectorCatalog();
  return Promise.allSettled([
    catalog ? logos(catalog.cards ?? []) : loadConnectorCatalog().then((answer) => logos(answer.cards ?? [])),
    connectorStatusMemory() ? null : preloadConnectedApps(),
    loadComposioSnapshot(),
    prefetchRemoteApps(),
    memory.onePassword ? null : listLogins().then((answer) => { memory.onePassword ??= answer.onePassword ?? { connected: false }; }),
  ]).then(() => {});
}

interface Toast { kind: "success" | "error"; text: string }

export function ConnectAppsWindow({ page: requested, nonce, onClose, onTemplates }: {
  page: ConnectAppsPage;
  nonce: number;
  onClose: () => void;
  onTemplates: () => void;
}) {
  const { state, dispatch } = useStore();
  const connectors = useConnectors();
  const tokens = useTokenApps();
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const remote = useRemoteApps({
    needsPanel: () => window.madaniDesktop?.remoteClient?.active === true,
    openPanel: () => go({ kind: "detail", id: MCP_PAGE }),
  });
  const [page, setPage] = useState<ConnectAppsPage>(requested);
  const [trail, setTrail] = useState<ConnectAppsPage[]>([]);
  const mcpServers = useMcpServers().servers;
  const [query, setQuery] = useState("");
  const [resultsOpen, setResultsOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  // a token app's refused account the app page opens on, ready to sign in again in its place
  const [replacing, setReplacing] = useState<{ app: string; id: string } | null>(null);
  // the token app whose page leads with its token over its ready sign-in
  const [tokenFirst, setTokenFirst] = useState<string | null>(null);
  // the app whose own card was picked from under the other ways, when Composio leads its page
  const [ownPicked, setOwnPicked] = useState<string | null>(null);
  const [natives, setNatives] = useState<Record<NativeId, boolean | null>>(() => memory.natives);
  const [hosted, setHosted] = useState<HostedConnections | null>(() => memory.hosted);
  const [onePassword, setOnePassword] = useState<OnePasswordStatus | null>(() => memory.onePassword);
  const [skills, setSkills] = useState<SkillsLibrarySkillWire[] | null>(() => memory.skills);
  const [view, setView] = useState(0);
  // how the last page change went, so the new page slides in from the side it came from, as settings' panes do
  const [nav, setNav] = useState<"push" | "pop" | "swap" | null>(null);
  const [waited, setWaited] = useState(false);
  const layout = useRef<Layout | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // home and the categories share one pane, so the title, search and chips stay mounted while the list under them changes
  const browsing = page.kind === "home" || page.kind === "category";
  const pageKey = browsing ? "browse" : `${page.kind}:${"id" in page ? page.id : ""}`;

  const opened = useRef({ requested, nonce });
  useEffect(() => {
    setPage(requested);
    setTrail([]);
    setNav(null);
    // a new open of a mounted window is a new view; the mount itself keeps the layout its first frame drew
    if (opened.current.requested === requested && opened.current.nonce === nonce) return;
    opened.current = { requested, nonce };
    setView((count) => count + 1);
  }, [requested, nonce]);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), READY_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (natives.x !== null || natives.email !== null) memory.natives = natives;
    if (hosted) memory.hosted = hosted;
    if (onePassword) memory.onePassword = onePassword;
    if (skills) memory.skills = skills;
  }, [natives, hosted, onePassword, skills]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    setScrolled(false);
    if (dialog.current && !dialog.current.contains(document.activeElement)) dialog.current.focus({ preventScroll: true });
  }, [page]);

  useEffect(() => {
    let alive = true;
    api("/api/email").then((answer: { accounts?: Array<{ address: string }> }) => { if (alive) setGmailConnected((answer.accounts ?? []).some((one) => GMAIL_ADDRESS.test(one.address))); }).catch(() => {});
    return () => { alive = false; };
  }, [natives.email]);
  useEffect(() => {
    let alive = true;
    listLogins().then((answer) => { if (alive) setOnePassword(answer.onePassword ?? { connected: false }); }).catch(() => { if (alive) setOnePassword(null); });
    (skillsLibraryEnabled(state.config) ? fetch("/api/skills-library") : Promise.resolve(null))
      .then(async (response) => (response?.ok ? ((await response.json()) as { skills?: SkillsLibrarySkillWire[] }).skills ?? [] : []))
      .then((list) => { if (alive) setSkills(list); })
      .catch(() => { if (alive) setSkills([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);

  const policy = state.config?.managedPolicy;
  const blocked = useCallback((slug: string) => policy?.apps && !policy.apps.allowAll && !policy.apps.allowlist.includes(slug)
    ? t("policy.managedBy", { organization: policy.organizationName }) : null, [policy]);

  const cards = useMemo(() => new Map((connectors.cards ?? []).map((card) => [card.slug, card])), [connectors.cards]);
  const ready = (connectors.ready && remote.settled) || waited;
  const entries = useMemo<AppEntry[]>(() => {
    const own = nativeEntries();
    const catalog = (connectors.cards ?? [])
      .filter((card) => !managedConnectorUnavailableReason(connectors.mode, card.slug) || hasActiveConnection(connectors.status[card.slug]))
      .map((card): AppEntry => ({
        id: card.slug, kind: "composio", label: card.label, description: connectorDescription(card), categories: grokCategories(card.categories),
        icon: cardIcon(card), website: card.domain ?? undefined, keywords: card.slug,
      }));
    const vendors = remote.apps
      .map((app): AppEntry => ({
        id: app.id, kind: "remote", label: app.label, description: connectorDescription({ label: app.label, blurb: app.description }), categories: grokCategories(app.categories),
        icon: remoteIcon(app), website: app.domain ?? undefined, keywords: `${app.id} mcp`,
      }));
    // a custom MCP server lists like any app once added; its page is Custom MCP, where it is edited or removed
    const custom = (mcpServers ?? [])
      .filter((server) => !server.bot && !remote.ownsServer(server.name) && !HOSTED_MCP_APPS.some((app) => server.name === app.id || server.name.startsWith(`${app.id}-`)))
      .map((server): AppEntry => ({ id: `mcp:${server.name}`, kind: "custom", label: server.name, description: t("connectApps.mcpServer"), categories: [], icon: { glyph: "server" }, keywords: "mcp custom" }));
    // one row per app: our card, composio's listings and the vendor's own server fold together
    // a token is only the way in for an app nothing else connects: one Composio covers stays a normal Composio row,
    // unless this build signs in to it natively
    const first = mergeEntries([...own, ...catalog, ...vendors]);
    const covered = new Set(first.filter((entry) => (entry.kind === "token" || entry.id === GMAIL) && (entry.composio !== undefined || entry.aliases?.length) && tokens.status?.native[entry.id] !== true).map((entry) => entry.id));
    const merged = [...(covered.size ? mergeEntries([...own.filter((entry) => !covered.has(entry.id)), ...catalog, ...vendors]) : first), ...custom];
    return ready ? stableOrder(merged) : merged;
  }, [connectors.cards, connectors.mode, connectors.status, remote, mcpServers, ready, tokens.status]);
  const serverOn = useMemo(() => new Map((mcpServers ?? []).map((server) => [`mcp:${server.name}`, server.enabled])), [mcpServers]);
  const remoteApps = useMemo(() => new Map(remote.apps.map((app) => [app.id, app])), [remote.apps]);
  // a merged row answers to every id it folds in, its own winning
  const byId = useMemo(() => {
    const map = new Map<string, AppEntry>();
    for (const entry of entries) for (const id of idsOf(entry).slice(1)) if (!map.has(id)) map.set(id, entry);
    for (const entry of entries) map.set(entry.id, entry);
    return map;
  }, [entries]);

  /** How the row's own way in stands, before the other ways it folds in. */
  const ownConnection = useCallback((entry: AppEntry): Connection => {
    const id = entry.id;
    const known = (value: boolean | null | undefined): Connection => value == null ? "unknown" : value ? "connected" : "disconnected";
    if (entry.kind === "composio") return connectors.isConnected(id) ? "connected" : "disconnected";
    if (entry.kind === "remote") return remote.connection(id);
    if (entry.kind === "custom") return known(serverOn.get(id));
    if (entry.kind === "logins") return known(onePassword?.connected);
    if (entry.kind === "hosted") return known(hosted?.[id as HostedMcpAppId]);
    if (entry.kind === "token") return tokens.status ? (tokens.accounts(id).length ? "connected" : "disconnected") : "unknown";
    if (id === GMAIL) return known(gmailConnected);
    return known(natives[id as NativeId]);
  }, [connectors, hosted, natives, onePassword, remote, serverOn, tokens, gmailConnected]);
  const composioConnected = useCallback((entry: AppEntry) => [entry.kind === "composio" ? entry.id : entry.composio, ...(entry.aliases ?? [])]
    .some((slug) => slug !== undefined && connectors.isConnected(slug)), [connectors]);

  // connected through any of its ways
  const connection = useCallback((id: string): Connection => {
    const entry = byId.get(id);
    if (!entry) return "unknown";
    const own = ownConnection(entry);
    if (own === "connected") return own;
    return composioConnected(entry) || (entry.remote !== undefined && remote.connection(entry.remote) === "connected") ? "connected" : own;
  }, [byId, composioConnected, ownConnection, remote]);

  const connected = useMemo(() => entries.filter((entry) => connection(entry.id) === "connected"), [entries, connection]);
  const isConnected = useMemo(() => new Set(connected.map((entry) => entry.id)), [connected]);
  const known = useRef(new Map<string, Connection>());
  useEffect(() => {
    let added: AppEntry | undefined;
    for (const entry of entries) {
      if (entry.kind === "composio" && connectors.phase !== "ready") continue;
      const now = connection(entry.id);
      if (now === "connected" && known.current.get(entry.id) === "disconnected") added ??= entry;
      if (now !== "unknown") known.current.set(entry.id, now);
    }
    if (!added) return;
    closeExternalPage();
    setToast({ kind: "success", text: t("connectApps.added", { name: added.label }) });
  }, [entries, connection, connectors.phase]);
  useEffect(() => {
    if (!connectors.error) return;
    const text = typeof connectors.error === "string" ? connectors.error : t(connectors.error.key);
    if (connectors.aliasFor) return;
    setToast({ kind: "error", text });
  }, [connectors.error, connectors.aliasFor]);
  useEffect(() => {
    if (!remote.error) return;
    setToast({ kind: "error", text: remote.error });
    remote.clearError();
  }, [remote]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const go = (next: ConnectAppsPage) => {
    setResultsOpen(false);
    setActive(-1);
    setTrail((past) => next.kind === "detail" || next.kind === "yours" ? [...past, page] : []);
    const staysBrowsing = browsing && (next.kind === "home" || next.kind === "category");
    setNav(next.kind === "detail" || next.kind === "yours" ? "push" : staysBrowsing ? null : "swap");
    setPage(next);
    setView((count) => count + 1);
  };
  const back = () => {
    setPage(trail.at(-1) ?? { kind: "home" });
    setTrail((past) => past.slice(0, -1));
    setNav("pop");
    setView((count) => count + 1);
  };
  const leaveFor = (action: Action) => { onClose(); dispatch(action); };
  // a row's Connect that opened Composio lands on the app's page, which says what to do there
  const detailId = page.kind === "detail" ? byId.get(page.id)?.id ?? page.id : null;
  useEffect(() => {
    const slug = connectors.setupFor ?? connectors.keyFor;
    const target = slug ? byId.get(slug)?.id ?? slug : null;
    if (target && detailId !== target) go({ kind: "detail", id: target });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors.setupFor, connectors.keyFor]);

  const composioReady = connectors.configured || connectors.via?.signedIn === true;
  // an app page through Composio Connect asks Composio once, reading only, whether it is connected already
  const detailSlug = page.kind === "detail" ? (byId.get(page.id)?.kind === "composio" ? byId.get(page.id)!.id : byId.get(page.id)?.composio) : undefined;
  useEffect(() => {
    if (detailSlug && connectors.via?.signedIn && connectors.viaRoute(detailSlug)) connectors.checkVia(detailSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailSlug, connectors.via?.signedIn]);
  const composioSlug = (entry: AppEntry) => entry.kind === "composio" ? entry.id : entry.composio;
  const composioPhase = (slug: string | undefined): ConnectorPhase | null => {
    const card = slug ? cards.get(slug) : undefined;
    return card ? connectors.phaseOf(card, blocked(card.slug)) : null;
  };
  const phaseOf = (entry: AppEntry): ConnectorPhase | null => entry.kind === "composio" ? composioPhase(entry.id) : null;
  // composio not set up: the vendor's own server signs in with one click, so it is the row's way in
  const vendorOf = (entry: AppEntry) => entry.kind === "remote" ? remoteApps.get(entry.id) : entry.remote && !composioReady ? remoteApps.get(entry.remote) : undefined;
  const startConnect = (entry: AppEntry) => {
    const vendor = vendorOf(entry);
    if (vendor) return void remote.connect(vendor);
    const ready = composioReady;
    const remoteClient = window.madaniDesktop?.remoteClient?.active === true;
    // clicked before Composio Connect was read: read it now rather than take a signed-in person to the app's page
    if (entry.kind === "composio" && !ready && connectors.via === null && !remoteClient) {
      void connectors.connectIfSignedIn(entry.id).then((started) => {
        if (started) return;
        connectors.askKey(entry.id);
        go({ kind: "detail", id: entry.id });
      });
      return;
    }
    if (entry.kind === "composio" && !ready && !remoteClient) connectors.askKey(entry.id);
    if (entry.kind !== "composio" || !ready) return go({ kind: "detail", id: entry.id });
    void connectors.connect(entry.id);
  };
  /** An app whose sign-in was refused (expired or revoked) and has no other way in that works: one click signs in again in
   * its place, so every bot keeps its access. */
  const reconnectOf = (entry: AppEntry): Extract<RowAction, { kind: "button" }> | null => {
    if (entry.kind === "token") {
      const accounts = tokens.accounts(entry.id);
      const stale = accounts.find((account) => account.needsReconnect);
      if (!stale || accounts.some((account) => !account.needsReconnect) || composioConnected(entry)) return null;
      const signIn = tokenApp(entry.id)?.native === true && tokens.status?.native[entry.id] === true;
      return { kind: "button", label: t("connectors.action.reconnect"), title: t("connectors.reconnectAria", { account: stale.label, service: entry.label }), onClick: () => {
        setReplacing({ app: entry.id, id: stale.id });
        if (signIn) void tokens.startDevice(entry.id as TokenAppId, stale.id);
        go({ kind: "detail", id: entry.id });
      } };
    }
    const vendor = entry.kind === "remote" ? remoteApps.get(entry.id) : entry.remote ? remoteApps.get(entry.remote) : undefined;
    const stale = vendor && !composioConnected(entry) ? remote.toReconnect(vendor.id) : undefined;
    if (!vendor || !stale) return null;
    return { kind: "button", label: t("connectors.action.reconnect"), busy: remote.busy[vendor.id] === true, onCancel: () => remote.cancel(vendor.id),
      onClick: () => void remote.connect(vendor, { server: stale.name }) };
  };
  const rowAction = (entry: AppEntry): RowAction => {
    if (entry.id === CUSTOM_MCP) return { kind: "button", label: t("common.add"), onClick: () => go({ kind: "detail", id: CUSTOM_MCP }) };
    const reconnect = reconnectOf(entry);
    if (reconnect) return reconnect;
    if (entry.kind === "custom") return connection(entry.id) === "connected" ? { kind: "connected" } : { kind: "status", label: t("connectApps.off"), tone: "quiet" };
    if (connection(entry.id) === "connected" && (entry.kind !== "composio" || !connectors.isConnected(entry.id))) return { kind: "connected" };
    const phase = phaseOf(entry);
    // the next step said for what it is: Authorize when Composio must be authorized first, Connect when it signs in to the app
    const authorizeFirst = entry.kind === "composio" && !composioReady;
    const connect: RowAction = { kind: "button", label: t(authorizeFirst ? "connectApps.authorize" : "connectors.action.connect"), onClick: () => startConnect(entry) };
    const vendor = vendorOf(entry);
    if (vendor) return { ...connect, busy: remote.busy[vendor.id] === true, onCancel: () => remote.cancel(vendor.id),
      ...(remote.stalled[vendor.id] ? { label: t("connectors.action.retry") } : {}) };
    if (!phase) return connect;
    // anything that says Connecting… can be left: Cancel stops it and the row says Connect again
    const cancel = () => connectors.cancel(entry.id);
    switch (phase.kind) {
      case "connected": case "included": return { kind: "connected" };
      case "connecting": return { ...connect, busy: true, onCancel: cancel };
      case "continue": return { ...connect, label: t("connectApps.via.openAgain"), pending: true, title: t("connectors.finishSetup"), onClick: () => connectors.resume(entry.id), onCancel: cancel };
      case "failed": return phase.why === "signedOut"
        ? { ...connect, label: t("connectApps.authorize"), onClick: () => go({ kind: "detail", id: entry.id }) }
        : { ...connect, label: t("connectors.action.retry"), onClick: () => void connectors.connect(entry.id) };
      case "setup": return { ...connect, label: t("common.checkAgain"), onClick: () => void connectors.connect(entry.id) };
      case "reconnect": return { kind: "button", label: t("connectors.action.reconnect"), onClick: () => void connectors.connect(entry.id, phase.account.alias, phase.account) };
      case "unavailable": return { ...connect, disabled: true, title: phase.reason };
      default: return connect;
    }
  };
  // grok's rows always say what the app does, under its name
  /** Who a connected row is signed in as: its accounts' names, else what the app does. */
  const subtitleOf = (entry: AppEntry): string => {
    if (reconnectOf(entry)) return t("connectApps.account.needsReconnect");
    if (connection(entry.id) !== "connected") return entry.description;
    const slug = composioSlug(entry);
    const names = [
      ...(entry.kind === "token" ? tokens.accounts(entry.id).map((account) => account.label) : []),
      ...(slug ? (connectors.status[slug]?.accounts ?? []).filter((account) => /^active$/i.test(account.status)).map((account) => account.alias).filter((name): name is string => Boolean(name)) : []),
    ];
    return names.length ? names.join(", ") : entry.description;
  };
  const row = (entry: AppEntry) => (
    <AppRow key={entry.id} entry={entry} subtitle={subtitleOf(entry)} action={rowAction(entry)}
      onOpen={() => go({ kind: "detail", id: entry.kind === "custom" ? CUSTOM_MCP : entry.id })} />
  );

  const label = (category: Category) => t(CATEGORY_LABEL[category]);
  /** Every app in one list: the popular ones first, then the rest in the order they came. */
  const allApps = (list: readonly AppEntry[]) => list
    .filter((entry) => entry.kind !== "custom")
    .map((entry, index) => ({ entry, index, rank: popularity(entry) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => entry);
  const arrange = (): Omit<Layout, "view"> => {
    const categories = presentCategories(entries);
    const sections: Section[] = [];
    const ids = (list: AppEntry[]) => list.map((entry) => entry.id);
    // what is connected leads, as its own group, and the rest follow without it
    const rest = (list: AppEntry[]) => list.filter((entry) => !isConnected.has(entry.id));
    const picks = recommended(entries.filter(fromCatalog), connection, Infinity);
    if (page.kind === "category") {
      const special: Record<string, { list: AppEntry[]; title: string; note?: string }> = {
        [RECOMMENDED]: { list: picks, title: t("connectApps.recommended") },
      };
      const chosen = special[page.category];
      const members = chosen ? chosen.list : inCategory(entries, page.category);
      const mine = members.filter((entry) => isConnected.has(entry.id));
      if (mine.length) sections.push({ key: CONNECTED, title: t("apps.connected"), ids: ids(mine) });
      sections.push({ key: page.category, title: chosen ? chosen.title : label(page.category as Category), ...(chosen?.note ? { note: chosen.note } : {}), ids: ids(rest(members)) });
    } else if (page.kind === "home") {
      if (connected.length) sections.push({ key: CONNECTED, title: t("apps.connected"), ids: ids(connected.slice(0, SECTION_SIZE)), viewAll: connected.length > SECTION_SIZE ? { kind: "yours" } : undefined });
      // one list: every app, whichever way it connects, each row with its own connect
      const apps = rest(allApps(entries));
      if (apps.length) sections.push({ key: ALL_APPS, title: t("connectApps.section.apps"), ids: ids(apps) });
    }
    return { categories, sections };
  };
  // the first frame of a view is its final layout: drawn once everything in memory is merged, then kept
  if (ready && layout.current?.view !== view) layout.current = { view, ...arrange() };
  const categories = layout.current?.categories ?? [];
  const inline = categories.slice(0, INLINE_CHIPS);
  const more = categories.slice(INLINE_CHIPS);
  const selected = page.kind === "category" ? page.category : null;

  const trimmed = query.trim();
  const appHits = useMemo(() => trimmed ? searchApps(entries, trimmed) : [], [entries, trimmed]);
  const nearMatch = (text: string) => (matchRank(text, trimmed) ?? 3) < 3;
  const skillHits = trimmed ? (skills ?? []).filter((skill) => nearMatch(skill.name) || nearMatch(skill.description)).slice(0, 4) : [];
  const categoryHits = trimmed ? categories.filter((category) => nearMatch(label(category))) : [];
  const options: Array<{ key: string; pick: () => void }> = [
    ...appHits.map((entry) => ({ key: `app:${entry.id}`, pick: () => { setQuery(""); go({ kind: "detail", id: entry.id }); } })),
    ...skillHits.map((skill) => ({ key: `skill:${skill.name}`, pick: () => leaveFor(SETTINGS("skills")) })),
    ...categoryHits.map((category) => ({ key: `category:${category}`, pick: () => { setQuery(""); go({ kind: "category", category }); } })),
  ];
  const showResults = resultsOpen && trimmed.length > 0;

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && showResults) {
      event.preventDefault();
      event.stopPropagation();
      setResultsOpen(false);
      setActive(-1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!options.length) return;
      event.preventDefault();
      setResultsOpen(true);
      setActive((index) => event.key === "ArrowDown" ? (index + 1) % options.length : index <= 0 ? options.length - 1 : index - 1);
    } else if (event.key === "Enter" && showResults && options.length) {
      event.preventDefault();
      options[Math.max(0, active)]!.pick();
    }
  };

  // focus can drop to the page (the button pressed turned busy, or the sign-in page took the window away and gave it
  // back): Escape still closes the window then; inside it, onDialogKey answers
  const escape = useRef({ onClose, menuOpen });
  escape.current = { onClose, menuOpen };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || escape.current.menuOpen) return;
      const at = document.activeElement;
      if (at && at !== document.body && at !== document.documentElement) return;
      event.preventDefault();
      escape.current.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onDialogKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || menuOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const at = document.activeElement;
    if (event.shiftKey && (at === first || at === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && at === last) { event.preventDefault(); first.focus(); }
  };

  const nativeCardsShown = detailId && (NATIVE_IDS as readonly string[]).includes(detailId) ? detailId : null;
  const hostedShown = detailId && HOSTED_MCP_APPS.some((app) => app.id === detailId) ? detailId : null;
  const onePasswordShown = detailId === "1password";

  const setNative = useCallback((id: NativeId) => (value: boolean | null) => setNatives((current) => current[id] === value ? current : { ...current, [id]: value }), []);
  const nativeSetters = useMemo(() => Object.fromEntries(NATIVE_IDS.map((id) => [id, setNative(id)])) as Record<NativeId, (value: boolean | null) => void>, [setNative]);

  const detailEntry = detailId ? byId.get(detailId) : undefined;
  // a page asked for by an id this catalog does not have (a link from the website) searches for it instead
  const missingId = page.kind === "detail" && ready && !detailEntry && page.id !== MCP_PAGE && page.id !== CUSTOM_MCP ? page.id : null;
  useEffect(() => {
    if (!missingId) return;
    setQuery(missingId);
    go({ kind: "home" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingId]);
  // our own card leads only when it is one click; otherwise Composio's sign-in does, and ours waits under the other ways
  // gmail's app password card stays on its page even when Composio's listing is the row
  const hasOwnCard = (entry: AppEntry) => OWN_KINDS.has(entry.kind) || entry.id === GMAIL;
  const ownConnected = (entry: AppEntry) => entry.id === GMAIL ? gmailConnected === true : ownConnection(entry) === "connected";
  const composioLeads = (entry: AppEntry): boolean => {
    if (!hasOwnCard(entry)) return false;
    const phase = composioPhase(composioSlug(entry));
    if (!phase || phase.kind === "unavailable") return false;
    return !(entry.oneClick === true && (entry.kind !== "token" || tokens.status?.native[entry.id] !== false));
  };
  const detailComposioLeads = detailEntry ? composioLeads(detailEntry) : false;
  // the own card under the other ways shows once picked there, or while it holds an account
  const ownShown = !detailComposioLeads || (detailEntry !== undefined && (ownPicked === detailEntry.id || ownConnected(detailEntry)));
  const tokenShown = detailEntry?.kind === "token" && ownShown ? detailEntry.id as TokenAppId : null;
  // gmail's app password leads its page only when Composio cannot; Composio connected, it is not shown unless picked
  const gmailShown = detailEntry?.id === GMAIL && ownShown
    && (detailComposioLeads || !(composioConnected(detailEntry) && gmailConnected !== true));
  const sub = page.kind === "detail" || page.kind === "yours";

  const body = (() => {
    if (page.kind === "detail" && (page.id === MCP_PAGE || page.id === CUSTOM_MCP)) {
      const custom = page.id === CUSTOM_MCP;
      return (
        <div className="ca-detail">
          <div className="ca-detail-header">
            <GlyphTile name={custom ? "plug" : "server"} size={56} />
            <h3 className="ca-detail-name" data-detail-hero-title="">{custom ? t("connectApps.customMcp") : t("connectApps.mcp")}</h3>
          </div>
          {custom && <p className="ca-detail-desc mb-4">{t("connectApps.customMcp.description")}</p>}
          <McpServersPanel embedded hideHosted />
        </div>
      );
    }
    if (page.kind === "detail") {
      if (!detailEntry) return ready ? null : <p className="ca-loading">{t("connectors.loadingCatalog")}</p>;
      const slug = composioSlug(detailEntry);
      const card = slug ? cards.get(slug) : undefined;
      const phase = composioPhase(slug);
      const vendor = detailEntry.kind === "remote" ? remoteApps.get(detailEntry.id) : detailEntry.remote ? remoteApps.get(detailEntry.remote) : undefined;
      const ways: Way[] = [];
      // a token app with a ready sign-in has two ways of its own: the one its card shows, the other a row beside the rest
      const spec = detailEntry.kind === "token" ? tokenApp(detailEntry.id) : undefined;
      const bothOwn = spec !== undefined && spec.fields.length > 0 && spec.native === true && tokens.status?.native[spec.id] === true;
      const byToken = spec !== undefined && spec.fields.length > 0 && (!bothOwn || tokenFirst === spec.id);
      if (OWN_KINDS.has(detailEntry.kind) || (detailComposioLeads && hasOwnCard(detailEntry))) {
        const own: LocaleKey = detailEntry.kind === "logins" ? "connectApps.way.vault"
          : spec ? (byToken ? "connectApps.way.token" : "connectApps.way.device")
            : detailEntry.id === GMAIL ? "connectApps.way.appPassword" : "connectApps.way.builtIn";
        ways.push({ key: "own", label: bothOwn && !byToken ? t("tokenApps.signIn", { name: spec.label }) : t(own), connected: ownConnected(detailEntry),
          ...(detailComposioLeads && !ownShown ? { action: { kind: "button" as const, label: t("connectors.action.connect"), onClick: () => setOwnPicked(detailEntry.id) } } : {}) });
      }
      if (bothOwn) {
        ways.push({ key: "token", label: byToken ? t("tokenApps.signIn", { name: spec.label }) : t("connectApps.way.token"), connected: false,
          action: { kind: "button", label: t("connectors.action.connect"), disabled: tokens.device?.app === spec.id,
            onClick: () => setTokenFirst(byToken ? null : spec.id) } });
      }
      if (vendor) {
        ways.push({ key: "remote", label: t("connectApps.way.server", { name: detailEntry.label }), connected: remote.connection(vendor.id) === "connected",
          action: ((stale) => ({ kind: "button" as const, label: t(remote.stalled[vendor.id] ? "connectors.action.retry" : stale ? "connectors.action.reconnect" : "connectors.action.connect"), busy: remote.busy[vendor.id] === true, disabled: remote.connection(vendor.id) === "unknown",
            onClick: () => void remote.connect(vendor, stale ? { server: stale.name } : {}), onCancel: () => remote.cancel(vendor.id) }))(remote.toReconnect(vendor.id)) });
      }
      if (slug && card) {
        const connect = { kind: "button" as const, label: t(composioReady ? "connectors.action.connect" : "connectApps.authorize"), onClick: () => composioReady ? void connectors.connect(slug) : connectors.askKey(slug) };
        ways.push({ key: "composio", label: t("connectApps.way.composio"), connected: composioConnected(detailEntry),
          action: phase?.kind === "connecting" ? { ...connect, busy: true, onCancel: () => connectors.cancel(slug) }
            : phase?.kind === "continue" ? { ...connect, label: t("connectApps.via.openAgain"), pending: true, title: t("connectors.finishSetup"), onClick: () => connectors.resume(slug), onCancel: () => connectors.cancel(slug) }
              : phase?.kind === "unavailable" ? { ...connect, disabled: true, title: phase.reason }
                : { ...connect, disabled: !composioReady && window.madaniDesktop?.remoteClient?.active === true } });
      }
      const model: AppPageModel = {
        entry: detailEntry,
        connection: connection(detailEntry.id),
        phase,
        card,
        ...(slug ? { composioSlug: slug } : {}),
        ways,
        connectors,
        ownFirst: !detailComposioLeads && (gmailShown || (OWN_KINDS.has(detailEntry.kind) && ways.length > 1)),
        usedBy: card && connection(detailEntry.id) === "connected" ? botsUsingService(state.bots, state.instances, card.slug).map((bot) => bot.name) : [],
        appBots: card ? botsUsingService(state.bots, state.instances, card.slug).map((bot) => ({ id: bot.id, name: bot.name })) : [],
        ...(detailEntry.kind === "composio" ? { toolkit: snapshotToolkit(detailEntry.id) } : {}),
        remoteClient: window.madaniDesktop?.remoteClient?.active === true,
        onOpenLogins: () => leaveFor(SETTINGS("logins")),
        onOpenKeys: () => leaveFor(openKeySettings("composio")),
        ...(vendor ? { remote: {
          open: vendor.auth === "none",
          busy: remote.busy[vendor.id] === true,
          stalled: remote.stalled[vendor.id] === true,
          appId: vendor.id,
          accounts: remote.accounts(vendor.id),
          bots: state.bots.map((bot) => ({ id: bot.id, name: bot.name })),
          onReconnect: (server: string) => void remote.connect(vendor, { server }),
          onAddAccount: (account: string) => void remote.connect(vendor, { account }),
          onConnect: () => void remote.connect(vendor),
          onCancel: () => remote.cancel(vendor.id),
          onManage: () => go({ kind: "detail", id: MCP_PAGE }),
        } } : {}),
      };
      return <AppPage model={model} />;
    }
    if (page.kind === "yours") {
      const servers = (mcpServers ?? []).filter((server) => !byId.has(`mcp:${server.name}`) && !remote.ownsServer(server.name) && !HOSTED_MCP_APPS.some((app) => server.name === app.id || server.name.startsWith(`${app.id}-`)));
      const serverEntry = (name: string): AppEntry => ({ id: `mcp:${name}`, kind: "native", label: name, description: t("connectApps.mcpServer"), categories: [], icon: { glyph: "server" } });
      return (
        <div className="ca-yours @container">
          <h1 className="ca-title ps-2" data-detail-hero-title="">{t("connectApps.manage")}</h1>
            <Group title={t("connectApps.installed")}>
              {connected.length || servers.length
                ? <div className="grid grid-cols-1 gap-x-2 gap-y-0.5 @xl:grid-cols-2">
                  {connected.map((entry) => (
                    <AppRow key={entry.id} entry={entry} subtitle={entry.description} action={{ kind: "status", label: t("apps.connected"), tone: "connected" }} onOpen={() => go({ kind: "detail", id: entry.id })} />
                  ))}
                  {servers.map((server) => (
                    <AppRow key={server.name} entry={serverEntry(server.name)} subtitle={t("connectApps.mcpServer")}
                      action={server.enabled ? { kind: "status", label: t("apps.connected"), tone: "connected" } : { kind: "status", label: t("connectApps.off"), tone: "quiet" }}
                      onOpen={() => go({ kind: "detail", id: MCP_PAGE })} />
                  ))}
                </div>
                : <p className="ca-note">{t("connectApps.nothingInstalled")}</p>}
            </Group>
            <Group title={t("connectApps.mcp")}>
              <div className="grid grid-cols-1 gap-x-2 gap-y-0.5 @xl:grid-cols-2">
                <AppRow entry={{ id: CUSTOM_MCP, kind: "native", label: t("connectApps.customMcp"), description: t("connectApps.customMcp.description"), categories: [], icon: { glyph: "plug" } }}
                  subtitle={t("connectApps.customMcp.description")} action={{ kind: "none" }} onOpen={() => go({ kind: "detail", id: CUSTOM_MCP })} />
              </div>
            </Group>
            <Group title={t("connectApps.skills")}>
              {skills?.length
                ? <div className="grid grid-cols-1 gap-x-2 gap-y-0.5 @xl:grid-cols-2">{skills.map((skill) => (
                  <AppRow key={skill.name} entry={{ id: `skill:${skill.name}`, kind: "native", label: skill.name, description: skill.description, categories: [], icon: { glyph: "file-list" } }}
                    subtitle={skill.description || t("connectApps.skill.subtitle")} action={{ kind: "none" }} onOpen={() => leaveFor(SETTINGS("skills"))} />
                ))}</div>
                : <p className="ca-note">{t("connectApps.noSkills")}</p>}
            </Group>
        </div>
      );
    }
    if (!layout.current) return <div className="ca-sections @container"><p className="ca-loading">{t("connectors.loadingCatalog")}</p></div>;
    return (
      <div key={page.kind === "category" ? page.category : "home"} className="ca-sections @container" data-browse-list="">
        {layout.current.sections.map((section) => {
          const members = section.ids.flatMap((id) => byId.get(id) ?? []);
          const viewAll = section.viewAll;
          return (
            <AppsSection key={section.key} id={`ca-section-${section.key}`} title={section.title} note={section.note}
              viewAll={viewAll ? { label: t("apps.viewAll"), onClick: () => go(viewAll) } : undefined}>
              {members.length > WINDOW_FROM
                ? <WindowedRows items={members} scroller={scroller} render={row} />
                : members.map((entry) => row(entry))}
            </AppsSection>
          );
        })}
      </div>
    );
  })();

  return (
    <div className="ca-scrim" data-connect-apps="" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialog} data-tour="apps-panel" role="dialog" aria-modal="true" aria-label={t("connectApps.title")} tabIndex={-1} className="ca-dialog" onKeyDown={onDialogKey}>
        <div className="ca-layout" data-fit={page.kind === "detail" ? "" : undefined}>
          <button type="button" data-tour="apps-close" className="ca-icon-button ca-close" aria-label={t("connectApps.close")} onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
          <div className="ca-bar" data-sub={sub ? "" : undefined}>
            {page.kind === "detail" && (
              <button type="button" className="ca-icon-button" aria-label={t("connectApps.back")} onClick={back}>
                <Icon name="chevron-left" size={16} />
              </button>
            )}
            {page.kind === "yours" && (
              <button type="button" className="ca-back-text" onClick={back}>
                <span aria-hidden="true"><Icon name="chevron-left" size={16} /></span>
                <span>{t("connectApps.title")}</span>
              </button>
            )}
            {sub && (
              <h3 aria-hidden="true" className="ca-bar-title" data-shown={scrolled ? "" : undefined}>
                {page.kind === "yours" ? t("connectApps.manage") : page.id === MCP_PAGE ? t("connectApps.mcp") : page.id === CUSTOM_MCP ? t("connectApps.customMcp") : detailEntry?.label}
              </h3>
            )}
          </div>
          <div className="ca-body">
            <div ref={scroller} className="ca-scroll" onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 40)}>
              <div key={pageKey} className="ca-pane" data-nav={nav ?? undefined}>
                {!sub && (
                  <div className="ca-home">
                    <div className="ca-head">
                      <h2 className="ca-title" id="ca-title">{t("connectApps.title")}</h2>
                      <button type="button" className="ca-installed" aria-label={t("connectApps.yours")} onClick={() => go({ kind: "yours" })}>
                        {connected.length > 0 && (
                          <span className="ca-stack" aria-hidden="true">
                            {connected.slice(0, 4).map((entry) => <span key={entry.id}><AppTile entry={entry} size={18} /></span>)}
                          </span>
                        )}
                        <span>{t("apps.connectedCount", { count: connected.length })}</span>
                        <span data-chevron="" aria-hidden="true" className="inline-flex"><Icon name="chevron-right" size={12} /></span>
                      </button>
                    </div>
                    <div className="ca-controls">
                      <div className="ca-search-row">
                        <div className="ca-search">
                          <div className="ca-field" data-filled={query ? "" : undefined}>
                            <Icon name="search" size={14} />
                            <input
                              ref={input}
                              type="text"
                              role="combobox"
                              aria-label={t("connectApps.search")}
                              aria-autocomplete="list"
                              aria-expanded={showResults}
                              aria-controls="ca-results"
                              aria-activedescendant={showResults && active >= 0 ? `ca-option-${active}` : undefined}
                              placeholder={t("connectApps.search")}
                              spellCheck={false}
                              value={query}
                              onChange={(event) => { setQuery(event.target.value); setResultsOpen(true); setActive(-1); }}
                              onFocus={() => setResultsOpen(true)}
                              onBlur={(event) => { if (!event.currentTarget.parentElement?.parentElement?.contains(event.relatedTarget as Node)) setResultsOpen(false); }}
                              onKeyDown={onSearchKey}
                            />
                            {query && (
                              <button type="button" className="ca-clear" onClick={() => { setQuery(""); setActive(-1); input.current?.focus(); }}>
                                {t("connectApps.clear")}
                              </button>
                            )}
                          </div>
                          {showResults && (
                            <div className="ca-results" onMouseDown={(event) => event.preventDefault()}>
                              <div id="ca-results" role="listbox" aria-label={t("connectApps.search")}>
                                {options.length === 0 && <p className="ca-empty">{t("connectApps.noResults", { query: trimmed })}</p>}
                                <ResultGroup label={t("connectApps.results.apps")} show={appHits.length > 0}>
                                  {appHits.map((entry, index) => (
                                    <Option key={entry.id} index={index} active={active} onHover={setActive} onPick={options[index]!.pick} icon={<AppTile entry={entry} size={24} />} label={entry.label} />
                                  ))}
                                </ResultGroup>
                                <ResultGroup label={t("connectApps.results.skills")} show={skillHits.length > 0}>
                                  {skillHits.map((skill, offset) => {
                                    const index = appHits.length + offset;
                                    return <Option key={skill.name} index={index} active={active} onHover={setActive} onPick={options[index]!.pick} icon={<span className="ca-option-glyph"><Icon name="file-list" size={12} /></span>} label={skill.name} />;
                                  })}
                                </ResultGroup>
                                <ResultGroup label={t("connectApps.results.categories")} show={categoryHits.length > 0}>
                                  {categoryHits.map((category, offset) => {
                                    const index = appHits.length + skillHits.length + offset;
                                    return <Option key={category} index={index} active={active} onHover={setActive} onPick={options[index]!.pick} label={label(category)} />;
                                  })}
                                </ResultGroup>
                              </div>
                            </div>
                          )}
                        </div>
                        <button type="button" className="ca-templates" data-bot-templates-link="" onClick={onTemplates}>
                          <MadaniMark body="kit" colour="var(--ca-mark)" size={18} animated={false} />
                          {t("connectApps.templates")}
                          <span data-arrow="" aria-hidden="true"><Icon name="arrow-right-up" size={12} /></span>
                        </button>
                      </div>
                      {layout.current && <div className="ca-chips" role="group" aria-label={t("connectApps.categoriesAria")} data-marketplace-chips="">
                        <button type="button" className="ca-chip" aria-pressed={selected === null} onClick={() => go({ kind: "home" })}>{t("apps.filter.all")}</button>
                        {inline.map((category) => (
                          <button key={category} type="button" className="ca-chip" aria-pressed={selected === category}
                            onClick={() => go(selected === category ? { kind: "home" } : { kind: "category", category })}>
                            {label(category)}
                          </button>
                        ))}
                        {more.length > 0 && (
                          <CategoryMenu
                            label={selected && (more as string[]).includes(selected) ? label(selected as Category) : t("apps.more")}
                            ariaLabel={t("apps.moreCategories")}
                            choices={more.map((category) => ({ key: category, label: label(category) }))}
                            selected={selected}
                            onPick={(category) => go({ kind: "category", category })}
                            onOpenChange={setMenuOpen}
                          />
                        )}
                      </div>}
                    </div>
                  </div>
                )}
                {body}
                <div className={(nativeCardsShown || hostedShown || onePasswordShown || tokenShown || gmailShown) && ownShown ? "ca-native-host" : "hidden"} data-native-host=""
                  data-after-ways={detailComposioLeads ? "" : undefined}>
                  {tokenShown && <TokenCard key={`${tokenShown}:${replacing?.app === tokenShown ? replacing.id : ""}`} app={tokenShown} tokens={tokens}
                    {...(replacing?.app === tokenShown ? { replacing: replacing.id } : {})} preferToken={tokenFirst === tokenShown} />}
                  {gmailShown && <GmailPasswordNote connected={gmailConnected === true} />}
                  <div className={hostedShown ? "contents" : "hidden"}>
                    <McpServersPanel hostedCards={{ shown: (id) => id === hostedShown, onConnections: setHosted }} />
                  </div>
                  <div className={nativeCardsShown === "x" ? "contents" : "hidden"}><XCard onConnection={nativeSetters.x} /></div>
                  <div className={nativeCardsShown === "email" || gmailShown ? "contents" : "hidden"}><EmailCard onConnection={nativeSetters.email} guided={gmailShown} /></div>
                  {gmailShown && gmailConnected !== true && <p className="ca-fine">{t("tokenApps.gmail.work")}</p>}
                  {onePasswordShown && <OnePasswordBody status={onePassword} onChange={setOnePassword} onManage={() => leaveFor(SETTINGS("logins"))} />}
                </div>
                {detailEntry && detailEntry.kind !== "composio" && detailEntry.id !== CUSTOM_MCP && (
                  <div className="ca-native-facts">
                    <AppFacts facts={appFacts({ entry: detailEntry, usedBy: [] })} />
                  </div>
                )}
              </div>
            </div>
            <ScrollThumb scroller={scroller} page={pageKey} />
          </div>
          {toast && (
            <div className="ca-toast" role="status" aria-live="polite" data-kind={toast.kind}>
              <Icon name={toast.kind === "success" ? "check" : "exclamation-circle"} size={13} />
              <span>{toast.text}</span>
              <button type="button" aria-label={t("connectApps.dismiss")} onClick={() => setToast(null)}><Icon name="close" size={12} /></button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="ca-group-title">{title}</h3>
      {children}
    </section>
  );
}

function ResultGroup({ label, show, children }: { label: string; show: boolean; children: ReactNode }) {
  if (!show) return null;
  return (
    <div role="group" aria-label={label}>
      <div className="ca-results-label" aria-hidden="true">{label}</div>
      {children}
    </div>
  );
}

function Option({ index, active, onHover, onPick, icon, label }: {
  index: number;
  active: number;
  onHover: (index: number) => void;
  onPick: () => void;
  icon?: ReactNode;
  label: string;
}) {
  return (
    <button type="button" role="option" id={`ca-option-${index}`} tabIndex={-1} aria-selected={index === active} className="ca-option"
      onMouseMove={() => { if (index !== active) onHover(index); }} onClick={onPick}>
      {icon}
      <span>{label}</span>
      <Icon name="chevron-right" size={12} />
    </button>
  );
}

/** The thin thumb, in a component of its own: it moves on every scroll frame and the window around it never renders for it. */
function ScrollThumb({ scroller, page }: { scroller: React.RefObject<HTMLDivElement | null>; page: string }) {
  const thumb = useScrollThumb(scroller, page);
  if (!thumb) return null;
  return (
    <div role="presentation" className="ca-scrollbar" data-scrolling={thumb.scrolling ? "" : undefined}>
      <div style={{ top: thumb.top, height: thumb.height }} />
    </div>
  );
}

function useScrollThumb(scroller: React.RefObject<HTMLDivElement | null>, key: string) {
  const [thumb, setThumb] = useState<{ top: number; height: number; scrolling: boolean } | null>(null);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = (scrolling: boolean) => {
      const { scrollHeight, clientHeight, scrollTop } = element;
      if (scrollHeight <= clientHeight + 1) { setThumb(null); return; }
      const track = clientHeight - 6;
      const height = Math.max(20, (clientHeight / scrollHeight) * track);
      setThumb({ top: (scrollTop / (scrollHeight - clientHeight)) * (track - height), height, scrolling });
    };
    const onScroll = () => {
      measure(true);
      clearTimeout(timer);
      timer = setTimeout(() => measure(false), 800);
    };
    measure(false);
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure(false));
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      clearTimeout(timer);
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [scroller, key]);
  return thumb;
}

