import type { ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Check, ChevronDown, ChevronRight, ChevronUp, History, Link2Off, Loader2, LogIn, Plus, RefreshCw, Search, Star, X } from "../icons";
import type { Bot, InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import type { MenuGroup, MenuModelRow, NotConnectedRow, SimpleMenu } from "@/lib/simple-model-menu";
import { modelBlurb } from "@/lib/model-friendly";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";
import { InstanceProviderMark } from "./ProviderIcons";
import { MENU_GUTTER, MENU_ICON, MENU_LABEL, MENU_LINE, MENU_NOTE, MENU_ROW, MENU_SEPARATOR, MENU_STROKE, MENU_TRAILING, SIMPLE_MENU_META, SIMPLE_MENU_ROW } from "./menu-recipe";
import { effortLabel } from "./ModelPicker";
import { EffortMenu } from "./EffortMenu";
import { SlidingPills } from "./ui/SlidingPills";
import { MotionDiv } from "./ui/SheetMotion";
import { EASE_OUT, SPRING } from "@/lib/motion-presets";

export type SimpleThinking =
  | { levels: readonly EffortLevel[]; current?: EffortLevel; onPick: (level: EffortLevel) => void; onReset: () => void }
  | { variants: ReactNode };

export interface SimpleMenuActions {
  onQuery: (query: string) => void;
  onPick: (instance: InstanceInfo, model: string, variant?: string) => void;
  onPickCurrent: () => void;
  /** Stars or unstars a model, by its starKey. */
  onToggleStar?: (key: string) => void;
  onFollowBot: () => void;
  onToggle: (instance: InstanceInfo) => void;
  /** Connects a provider that needs its sign-in again. */
  onSetUp: (instance: InstanceInfo) => void;
  onCheckAgain: (instance: InstanceInfo) => void;
  /** Opens the model directory (more providers, API keys, local models); left out where they live on another computer. */
  onMore?: () => void;
  onResetVariant?: () => void;
  /** Disconnects a provider from its heading; left out where the person can't. */
  onDisconnect?: (instance: InstanceInfo, provider: string) => void;
}

/** This bot's model, or every bot's and the default for new ones. */
export type PickerScope = "bot" | "all";

export interface SimpleModelMenuProps extends SimpleMenuActions {
  menu: SimpleMenu;
  query: string;
  bot: Pick<Bot, "name" | "color" | "avatarUrl" | "avatarCrop" | "avatarZoom" | "avatarFocusX" | "avatarFocusY" | "mascotBody">;
  botModel: { label: string; title: string };
  thinking?: SimpleThinking | null;
  idPrefix: string;
  /** The providers not connected here, under the connected ones; a press hands the row to Connect an AI. */
  notConnected?: { rows: readonly NotConnectedRow[]; onConnect: (row: NotConnectedRow) => void };
  /** Whether a pick is for this bot or every bot; left out where there is no choice. */
  scope?: { value: PickerScope; onChange: (value: PickerScope) => void };
  /** Where these models run, when that is not the person's own computer (a madani cloud lists only its own AIs). */
  where?: string;
}

const Gutter = ({ children }: { children?: ReactNode }) => <span className={MENU_GUTTER}>{children}</span>;
const Forward = () => <ChevronRight size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />;

/** A model's name and its secondary label, each on its own line so a long name never eats the label beside it. */
function RowLines({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <span data-simple-model-text className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{label}</span>
      {children}
    </span>
  );
}

/** `provider` names the row's provider by its mark, where rows of several providers share a list. */
function MenuModel({ instance, row, provider, onPick, onToggleStar }: { instance: InstanceInfo; row: MenuModelRow; provider?: string; onPick: SimpleMenuActions["onPick"]; onToggleStar?: SimpleMenuActions["onToggleStar"] }) {
  const { option } = row;
  const reason = row.blocked ? t("model.orgBlocked") : undefined;
  const name = row.label;
  return (
    <div data-model-row className="group/star relative">
      <button
        type="button"
        data-menu-row
        data-org-blocked={row.blocked || undefined}
        disabled={row.blocked}
        aria-pressed={row.current}
        aria-label={[option.label, option.provider, provider, reason].filter(Boolean).join(" · ")}
        title={[option.label, option.provider, provider, reason ?? modelBlurb(option)].filter(Boolean).join(" · ")}
        tabIndex={-1}
        onClick={() => onPick(instance, row.model ?? option.id, row.variant)}
        className={cn(SIMPLE_MENU_ROW, !row.blocked && !row.auto && onToggleStar && "pr-8")}
      >
        <Gutter>{provider && <InstanceProviderMark instance={instance} size={14} subtle />}</Gutter>
        <RowLines label={row.label}>
          {row.route && <span data-simple-route className={SIMPLE_MENU_META}>{row.route}</span>}
          {reason && <span data-simple-org-blocked className={SIMPLE_MENU_META}>{reason}</span>}
        </RowLines>
        {row.current && <Check size={14} className="shrink-0 text-accent" aria-hidden="true" />}
      </button>
      {!row.blocked && !row.auto && onToggleStar && (
        <button
          type="button"
          data-star-toggle
          tabIndex={-1}
          aria-pressed={row.starred}
          aria-label={t(row.starred ? "model.picker.unstar" : "model.picker.star", { name })}
          onClick={() => onToggleStar(row.star)}
          className={cn("absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[6px] text-ink-tertiary transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none touch:size-8",
            row.starred ? "text-accent hover:text-accent" : "opacity-0 group-hover/star:opacity-100 group-focus-within/star:opacity-100 touch:opacity-100")}
        >
          <Star size={14} fill={row.starred ? "currentColor" : "none"} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function GroupBody({ group, props }: { group: MenuGroup; props: SimpleModelMenuProps }) {
  const { instance, body } = group;
  switch (body.kind) {
    case "policy":
      return (
        <div data-simple-policy className="flex flex-col gap-0.5 py-1 pl-8 pr-2">
          <p className="text-[13px] leading-[18px] text-ink-secondary">{t("policy.managedBy", { organization: body.organization })}</p>
          <p className="text-[12px] leading-4 text-ink-tertiary">{t(body.team ? "policy.teamModelBlocked" : "policy.modelBlocked", { organization: body.organization })}</p>
        </div>
      );
    case "setUp":
    case "signIn":
      // listed under Not connected instead (SimpleMenu.connect)
      return null;
    case "empty":
      return body.loading ? (
        <div role="status" className={cn(MENU_LINE, "text-ink-tertiary")}>
          <Gutter><Loader2 size={14} className="animate-spin" aria-hidden="true" /></Gutter>
          <span className="min-w-0 flex-1 truncate">{t("model.loadingModels", { name: group.provider })}</span>
        </div>
      ) : (
        <>
          <p className={cn(MENU_NOTE, "pl-8")}>{t("model.simple.noModels")}</p>
          <button type="button" data-menu-row data-simple-refresh tabIndex={-1} disabled={props.menu.busy} onClick={() => props.onCheckAgain(instance)} className={MENU_ROW}>
            <Gutter>
              {props.menu.busy
                ? <Loader2 size={14} className="animate-spin text-ink-secondary" aria-hidden="true" />
                : <RefreshCw size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" />}
            </Gutter>
            <span className="min-w-0 flex-1 truncate">{t("common.checkAgain")}</span>
          </button>
        </>
      );
    case "models":
      return (
        <>
          {body.rows.map((row, index) => (
            <div key={row.option.id} className="contents">
              {index === body.localFrom && <div className={cn(MENU_LABEL, "pl-8 font-normal")}>{t("model.localModels")}</div>}
              <MenuModel instance={instance} row={row} onPick={props.onPick} onToggleStar={props.onToggleStar} />
            </div>
          ))}
          {body.probing && (
            <div role="status" className={cn(MENU_LINE, "text-ink-tertiary")}>
              <Gutter><Loader2 size={14} className="animate-spin" aria-hidden="true" /></Gutter>
              <span className="min-w-0 flex-1 truncate">{t("model.lookingLocal")}</span>
            </div>
          )}
          {body.signInForOwn && (
            <button type="button" data-menu-row data-simple-sign-in tabIndex={-1} onClick={() => props.onSetUp(instance)} className={MENU_ROW}>
              <Gutter><LogIn size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" /></Gutter>
              <span className="min-w-0 flex-1 truncate">{t("model.simple.signInForOwn", { name: group.provider })}</span>
              <Forward />
            </button>
          )}
          {body.toggle && (
            <div className={cn(body.toggle === "less" && "sticky bottom-0 z-[1] -mx-1.5 bg-linear-to-b from-transparent to-menu to-[12px] px-1.5 pt-3")}>
              <button type="button" data-menu-row data-simple-show-all tabIndex={-1} aria-expanded={body.toggle === "less"}
                onClick={() => props.onToggle(instance)} className={cn(MENU_ROW, "text-ink-secondary hover:text-ink focus:text-ink")}>
                <Gutter />
                <span className="min-w-0 flex-1 truncate">{body.toggle === "less" ? t("model.showSuggested") : t(body.freeToggle ? "model.showAllFree" : "model.showAll", { count: body.total })}</span>
                {body.toggle === "less"
                  ? <ChevronUp size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />
                  : <ChevronDown size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />}
              </button>
            </div>
          )}
        </>
      );
  }
}

function Thinking({ thinking, labelId }: { thinking: SimpleThinking; labelId: string }) {
  if ("variants" in thinking) return <div data-simple-thinking>{thinking.variants}</div>;
  const levels = thinking;
  return (
    <div data-simple-thinking className="flex flex-col">
      <div className="flex h-6 items-end justify-between gap-2 px-2 pb-0.5">
        <span id={labelId} className="text-[12px] font-medium leading-4 text-ink-tertiary">{t("botSettings.simple.thinking")}</span>
        {(levels.current === undefined
          ? <span title={t("model.simple.thinkingDefault")} className="text-[12px] leading-4 text-ink-tertiary">{t("model.effort.default")}</span>
          : (
            <button type="button" data-simple-effort-default onClick={levels.onReset} title={t("model.simple.thinkingDefault")}
              className="-mr-1 rounded-[5px] px-1 text-[12px] leading-4 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink">
              {t("model.simple.useDefault")}
            </button>
          ))}
      </div>
      <SlidingPills aria-labelledby={labelId} data-simple-effort value={levels.current} onPick={levels.onPick} pillClassName="px-1"
        options={levels.levels.map((level) => ({ value: level, label: effortLabel(level), title: t("model.simple.thinkingLevel", { level: effortLabel(level) }),
          attrs: { "data-effort-pill": "" } }))} />
    </div>
  );
}

/** One quiet row per provider that isn't connected: its mark, its name, why (when it was set up before) and Connect. */
function NotConnected({ rows, onConnect, labelId }: { rows: readonly NotConnectedRow[]; onConnect: (row: NotConnectedRow) => void; labelId: string }) {
  return (
    <div role="group" aria-labelledby={labelId} data-picker-not-connected="" className="flex flex-col gap-0.5">
      <div role="separator" className={MENU_SEPARATOR} />
      <div id={labelId} className={MENU_LABEL}>{t("model.picker.notConnected")}</div>
      {rows.map((row) => {
        const note = row.state === "signIn" ? t("model.picker.needsSignIn") : row.state === "setUp" ? t("model.picker.needsSetup") : null;
        return (
          <button key={row.key} type="button" data-menu-row data-picker-connect={row.key} tabIndex={-1}
            aria-label={[t("model.picker.connectName", { name: row.name }), note].filter(Boolean).join(" · ")}
            onClick={() => onConnect(row)} className={SIMPLE_MENU_ROW}>
            <Gutter><InstanceProviderMark instance={row.instance} size={14} subtle /></Gutter>
            <RowLines label={<span className="text-ink-secondary group-hover:text-ink group-focus:text-ink">{row.name}</span>}>
              {note && <span className={SIMPLE_MENU_META}>{note}</span>}
            </RowLines>
            <span aria-hidden="true" className="flex h-6 shrink-0 items-center rounded-full bg-ink/[0.06] px-2.5 text-[12px] leading-4 text-ink-secondary transition-colors group-hover:bg-ink/[0.1] group-hover:text-ink group-focus:bg-ink/[0.1] group-focus:text-ink motion-reduce:transition-none">
              {t("model.picker.connect")}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** This bot, or every bot: two pills, the fill sliding to the chosen one, its meaning in the tooltip. */
function Scope({ scope, labelId }: { scope: NonNullable<SimpleModelMenuProps["scope"]>; labelId: string }) {
  const choices: Array<{ value: PickerScope; label: string; hint: string }> = [
    { value: "bot", label: t("model.picker.thisBot"), hint: t("model.picker.thisBotHint") },
    { value: "all", label: t("model.picker.allBots"), hint: t("model.picker.allBotsHint") },
  ];
  return (
    <div className="flex flex-col">
      <span id={labelId} className="flex h-6 items-end px-2 pb-0.5 text-[12px] font-medium leading-4 text-ink-tertiary">{t("model.picker.scope")}</span>
      <SlidingPills aria-labelledby={labelId} data-picker-scope value={scope.value} onPick={scope.onChange} pillClassName="h-8 px-3 text-[13px] leading-5"
        options={choices.map((choice) => ({ value: choice.value, label: choice.label, title: choice.hint, attrs: { "data-scope-pill": choice.value } }))} />
    </div>
  );
}

export function SimpleModelMenu(props: SimpleModelMenuProps) {
  const { menu, query, idPrefix } = props;
  // starring opens the row in Starred; filtering by typing changes it at once
  const still = Boolean(query) || reducedMotionNow();
  const current = menu.current;
  const top = Boolean(current || menu.follow);
  const onRow = current && props.thinking && !("variants" in props.thinking) ? props.thinking : null;
  return (
    <div data-simple-model-menu className="flex min-h-0 flex-1 flex-col">
      {menu.search && (
        <div data-simple-model-search className="group/search flex h-9 shrink-0 items-center gap-2 border-b-[0.5px] border-transparent pl-3.5 pr-2">
          <Search size={16} strokeWidth={MENU_STROKE} className="shrink-0 text-ink-tertiary group-focus-within/search:text-ink-secondary" aria-hidden="true" />
          <input
            data-menu-search
            value={query}
            onChange={(event) => props.onQuery(event.target.value)}
            placeholder={t("model.search")}
            aria-label={menu.groups.every((group) => group.instance.access === "custom") ? t("model.searchLocal") : t("model.search")}
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-ink outline-none placeholder:text-ink-tertiary"
          />
          {query && (
            <button type="button" aria-label={t("model.simple.clearSearch")} onClick={() => props.onQuery("")}
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink">
              <X size={14} strokeWidth={MENU_STROKE} aria-hidden="true" />
            </button>
          )}
          {menu.results !== null && <span role="status" className="sr-only">{t("model.results", { count: menu.results })}</span>}
        </div>
      )}

      <div data-simple-models className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain",
        menu.groups.some((group) => group.body.kind === "models" && group.body.toggle === "less") && "scroll-pt-8 scroll-pb-12")}>
        <div className="flex flex-col gap-0.5 p-1.5">
          {props.where && !query && <p data-picker-where className="px-2 pb-0.5 pt-1 text-[12px] leading-4 text-ink-tertiary">{props.where}</p>}
          {current && (
            <div className="relative">
            <button
              type="button"
              data-menu-row
              data-current-model
              aria-pressed="true"
              title={current.title}
              onClick={() => {
                const setUp = current.warning && current.instance && !current.instance.policy && !current.blocked ? current.instance : undefined;
                if (setUp) props.onSetUp(setUp);
                else props.onPickCurrent();
              }}
              className={cn(SIMPLE_MENU_ROW, onRow && "pr-[104px]")}
            >
              <Gutter>
                {current.instance
                  ? <InstanceProviderMark instance={current.instance} size={14} subtle />
                  : <span className="size-3.5 rounded-full bg-ink/[0.08]" aria-hidden="true" />}
              </Gutter>
              <RowLines label={current.label}>
                {current.meta && <span className={cn(SIMPLE_MENU_META, current.warning && "text-warning")}>{current.meta}</span>}
              </RowLines>
              {current.pending && <Loader2 size={14} className="shrink-0 animate-spin text-ink-tertiary" aria-hidden="true" />}
              {!onRow && <Check size={14} className="shrink-0 text-accent" aria-hidden="true" />}
            </button>
            {onRow && <EffortMenu {...onRow} />}
            </div>
          )}
          {menu.follow && (
            <button type="button" data-menu-row data-follow-bot-model aria-pressed="false" tabIndex={-1} title={props.botModel.title}
              onClick={props.onFollowBot} className={SIMPLE_MENU_ROW}>
              <Gutter><BotAvatar bot={props.bot} size={16} state="happy" animated={false} label="" /></Gutter>
              <RowLines label={t("model.useBotModel", { name: props.bot.name })}>
                <span className={SIMPLE_MENU_META}>{props.botModel.label}</span>
              </RowLines>
            </button>
          )}
          {top && (menu.starred.length > 0 || menu.recent.length > 0 || menu.groups.length > 0) && <div role="separator" className={MENU_SEPARATOR} />}

          <AnimatePresence initial={false}>
            {menu.starred.length > 0 && (
              <Unfold key="starred" still={still}>
                <div role="group" aria-labelledby={`${idPrefix}-starred`} data-picker-starred="" className={cn("flex flex-col gap-0.5", menu.groups.length > 0 && "mb-1")}>
                  <div id={`${idPrefix}-starred`} className={MENU_LABEL}>
                    <Gutter><Star size={14} fill="currentColor" aria-hidden="true" className="text-ink-tertiary" /></Gutter>
                    <span className="min-w-0 truncate">{t("model.picker.starred")}</span>
                  </div>
                  <AnimatePresence initial={false}>
                    {menu.starred.map(({ instance, provider, row }) => (
                      <Unfold key={row.star} still={still}>
                        <MenuModel instance={instance} row={row} provider={menu.groups.length > 1 ? provider : undefined} onPick={props.onPick} onToggleStar={props.onToggleStar} />
                      </Unfold>
                    ))}
                  </AnimatePresence>
                </div>
              </Unfold>
            )}
          </AnimatePresence>

          {menu.recent.length > 0 && (
            <div role="group" aria-labelledby={`${idPrefix}-recent`} data-picker-recent="" className={cn("flex flex-col gap-0.5", menu.groups.length > 0 && "mb-1")}>
              <div id={`${idPrefix}-recent`} className={MENU_LABEL}>
                <Gutter><History size={14} strokeWidth={MENU_STROKE} aria-hidden="true" className="text-ink-tertiary" /></Gutter>
                <span className="min-w-0 truncate">{t("model.picker.recent")}</span>
              </div>
              {menu.recent.map(({ instance, provider, row }) => (
                <MenuModel key={row.star} instance={instance} row={row} provider={menu.groups.length > 1 ? provider : undefined} onPick={props.onPick} onToggleStar={props.onToggleStar} />
              ))}
            </div>
          )}

          {menu.groups.map((group, index) => {
            const labelId = `${idPrefix}-group-${index}`;
            const expanded = group.body.kind === "models" && group.body.toggle === "less";
            return (
              <div key={group.instance.instanceId} role="group" aria-labelledby={labelId} data-simple-provider={group.instance.instanceId}
                className={cn("flex flex-col gap-0.5", index > 0 && "mt-1")}>
                <div className={cn("group/heading flex items-end", expanded && "sticky top-0 z-[1] -mx-1.5 bg-menu px-1.5")}>
                  <div id={labelId} className={cn(MENU_LABEL, "min-w-0 flex-1")}>
                    <Gutter><InstanceProviderMark instance={group.instance} size={14} subtle /></Gutter>
                    <span className="min-w-0 truncate">{group.label}</span>
                  </div>
                  {props.onDisconnect && !group.instance.policy && !group.instance.readOnly && (
                    <button type="button" data-picker-disconnect={group.instance.instanceId}
                      aria-label={t("model.picker.disconnect", { name: group.provider })} title={t("model.picker.disconnect", { name: group.provider })}
                      onClick={() => props.onDisconnect!(group.instance, group.provider)}
                      className="me-1 flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-tertiary opacity-0 transition-opacity hover:bg-ink/[0.08] hover:text-ink focus:bg-ink/[0.08] focus:text-ink focus-visible:opacity-100 group-hover/heading:opacity-100 motion-reduce:transition-none touch:size-8 touch:opacity-100">
                      <Link2Off size={14} strokeWidth={MENU_STROKE} aria-hidden="true" />
                    </button>
                  )}
                </div>
                {group.note && <p className={cn(MENU_NOTE, "pl-8 pt-0")}>{group.note}</p>}
                <GroupBody group={group} props={props} />
              </div>
            );
          })}

          {menu.empty === "loading" && (
            <div role="status" className={cn(MENU_LINE, "text-ink-tertiary")}>
              <Gutter><Loader2 size={14} className="animate-spin" aria-hidden="true" /></Gutter>
              <span className="min-w-0 flex-1 truncate">{t("model.simple.lookingModels")}</span>
            </div>
          )}
          {menu.empty === "none" && <p className={cn(MENU_NOTE, !top && "pt-2")}>{t("model.noProviders")}</p>}
          {menu.results === 0 && <p className={cn(MENU_NOTE, "py-2")}>{t("model.noMatch", { query: menu.query })}</p>}
          {props.notConnected && props.notConnected.rows.length > 0 && (
            <NotConnected rows={props.notConnected.rows} onConnect={props.notConnected.onConnect} labelId={`${idPrefix}-not-connected`} />
          )}
          {/* the way to more providers is the list's last row, so it scrolls with the rest instead of pinning the foot */}
          {props.onMore && (
            <button type="button" data-menu-row data-picker-more onClick={props.onMore} className={cn(MENU_ROW, "mt-1")}>
              <Gutter><Plus size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" /></Gutter>
              <span className="min-w-0 flex-1 truncate">{t("connectAi.more")}</span>
              <Forward />
            </button>
          )}
        </div>
      </div>

      {((props.thinking && !onRow) || props.onResetVariant || props.scope) && (
        <div data-simple-effort-band className="flex shrink-0 flex-col gap-0.5 border-t-[0.5px] border-transparent p-1.5">
          {props.thinking && !onRow && <Thinking thinking={props.thinking} labelId={`${idPrefix}-thinking`} />}
          {props.scope && <Scope scope={props.scope} labelId={`${idPrefix}-scope`} />}
          {props.onResetVariant && (
            <button type="button" data-menu-row data-simple-variant-default onClick={props.onResetVariant} className={MENU_ROW}>
              <Gutter />
              <span className="min-w-0 flex-1 truncate">{t("model.variant.session")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A starred row (or the Starred group) opening by height on the layout spring, its contents fading in 60ms behind;
 * leaving, it folds away in 150ms. */
function Unfold({ still, children }: { still: boolean; children: ReactNode }) {
  return (
    <MotionDiv
      className="overflow-hidden"
      initial={still ? false : { height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1, transition: { height: SPRING.layout, opacity: { duration: 0.2, delay: 0.06, ease: EASE_OUT } } }}
      exit={still ? { height: 0, opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0, transition: { duration: 0.15, ease: EASE_OUT } }}
    >
      {children}
    </MotionDiv>
  );
}

/** the app's reduced-motion switch or the system's, read without a hook (the menu body is also drawn as a plain call) */
function reducedMotionNow(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
