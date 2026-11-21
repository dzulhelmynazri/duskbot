import type { NewBotDefaults } from "../../shared/new-bot-defaults";
import { api, type Action, type Bot } from "@/state/store";
import { teamChats } from "@/state/team-chats";
import { currentTeamPeople, departmentOwner, type TeamPeople } from "@/state/team-people";
import { openBot } from "@/state/thread-navigation";
import type { BotSource } from "./analytics-allowlist";
import { BotCreationDraft } from "./bot-creation-draft";
import { isBotLimitRefusal } from "./bot-limit";
import { createConfiguredBot } from "./create-configured-bot";
import { t } from "./i18n";
import { botCreated } from "./product-events";
import { readBotDefaults, type BotDefaultsAnswer } from "./bot-defaults-prefetch";

export type { BotDefaultsAnswer } from "./bot-defaults-prefetch";

/** The saved New bot defaults, with the workspace's default AI when they name none; `named` also gives the bot a name. */
export function startingTemplate(answer: BotDefaultsAnswer, named: boolean): NewBotDefaults {
  const template = structuredClone(answer.defaults);
  const selection = template.profile.modelSelection;
  if (!selection || (selection.instanceId === "" && selection.model === "")) template.profile.modelSelection = answer.modelSelection;
  if (named) template.profile.name = template.profile.name?.trim() || answer.suggestedName;
  return template;
}

/** `name`, or the first "name 2", "name 3"… that no bot here has. */
export function freeName(name: string, bots: ReadonlyArray<Pick<Bot, "name">>): string {
  const taken = new Set(bots.map((bot) => bot.name.trim().toLowerCase()));
  if (!taken.has(name.trim().toLowerCase())) return name;
  for (let next = 2; ; next++) if (!taken.has(`${name} ${next}`.toLowerCase())) return `${name} ${next}`;
}

/** Who a new team bot reports to: the person chosen, else whoever every bot of its department reports to, else this
 * person. */
export function reportsToFor(chosen: string | null, section: string | undefined, bots: readonly Bot[], team: TeamPeople): string | null {
  if (chosen) return chosen;
  const department = bots.filter((bot) => !bot.hidden && (bot.section?.trim() || "") === (section?.trim() || ""));
  return departmentOwner(department, team)?.email ?? team.me?.email ?? null;
}

/** The bot writes its own hello as its chat opens, from `template` too when it was made from a ready-made bot; the
 * server skips it once anyone has spoken there, and a bot with no AI to answer says a fixed hello. */
export function greetNewBot(bot: Pick<Bot, "id">, request: typeof api = api, template?: string): void {
  void request(`/api/bots/${bot.id}/intro`, { method: "POST", ...(template ? { body: JSON.stringify({ template }) } : {}) }).catch(() => {});
}

/** A bot just made joins the sidebar and, unless the caller keeps its own place, its chat opens (and the bot greets the
 * person there): on a team's Cloud the creator's own conversation, never the main chat every member reads. */
export function announceNewBot(dispatch: (action: Action) => void, bot: Bot, warnings: readonly string[],
  { preserveSelection = false, source, role, request = api }: { preserveSelection?: boolean; source: BotSource; role?: string; request?: typeof api }) {
  if (!preserveSelection) greetNewBot(bot, request, source === "template" ? role : undefined);
  botCreated(source, role);
  dispatch({ type: "botAdded", bot, preserveSelection });
  if (!preserveSelection && teamChats()) openBot(dispatch, bot);
  if (warnings.length) dispatch({ type: "error", message: warnings.join("\n") });
}

/** A paired device may not read the host's New bot defaults: the host applies them to an empty request. Auto on this
 * computer needs the person's own OK, so a bot whose defaults ask for it starts on Ask. */
async function createNewBot(section: string | undefined, bots: readonly Bot[], team: TeamPeople | null, request: typeof api,
  look?: Extract<Action, { type: "newBot" }>["look"]) {
  if (typeof window !== "undefined" && window.madaniDesktop?.remoteClient?.active) {
    // the look rides in the create itself: a second request that failed would leave a default-looking bot behind
    const named = look ? { name: look.name, settings: { color: look.color, mascotBody: look.mascotBody } } : {};
    const { bot } = await request<{ bot: Bot }>("/api/bots", { method: "POST", body: JSON.stringify({ greeting: false, ...(section === undefined ? {} : { section }), ...named }) });
    return { bot, warnings: [] as string[], startsOnAsk: false };
  }
  const template = startingTemplate(await readBotDefaults(request), true);
  if (look) Object.assign(template.profile, look);
  template.profile.name = freeName(template.profile.name!.trim(), bots);
  if (section !== undefined) template.profile.section = section;
  const draft = new BotCreationDraft(template, () => {}, request);
  const startsOnAsk = draft.bot.approvalMode === "auto" && draft.bot.computer === "local";
  if (startsOnAsk) draft.patch({ approvalMode: "ask" });
  const reportsTo = team ? reportsToFor(null, draft.bot.section, bots, team) ?? undefined : undefined;
  try {
    return { ...await createConfiguredBot(draft, request, undefined, undefined, undefined, reportsTo), startsOnAsk };
  } finally {
    draft.dispose();
  }
}

/** New bot: a bot made at once from the New bot defaults, with its chat open and ready for the first message. */
export async function makeNewBot(action: Extract<Action, { type: "newBot" }>, bots: readonly Bot[], dispatch: (action: Action) => void,
  request: typeof api = api): Promise<void> {
  if (currentTeamPeople()?.admin === false) return;
  let made: Awaited<ReturnType<typeof createNewBot>>;
  try {
    made = await createNewBot(action.section, bots, currentTeamPeople(), request, action.look);
  } catch (cause) {
    if (isBotLimitRefusal(cause)) return;
    const message = t("newBot.failed", { error: cause instanceof Error ? cause.message : String(cause) });
    if (action.onError) action.onError(message);
    else dispatch({ type: "error", message });
    return;
  }
  announceNewBot(dispatch, made.bot, made.warnings, { preserveSelection: action.preserveSelection, source: "blank", request });
  if (made.startsOnAsk) dispatch({ type: "notice", notice: { kind: "note", botName: null, text: t("newBot.startsOnAsk", { name: made.bot.name }) } });
  action.onCreated?.(made.bot);
}
