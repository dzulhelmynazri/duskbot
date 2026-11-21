import type { Bot, Group, GroupDefaultResponder } from "@/state/store";
import { defaultResponderName, effectiveDefaultResponder } from "./group-routing";
import { t } from "./i18n";

/** `leader:<id>` leads the group; `member:<id>` is a room from before leaders, where that bot only answers. `auto` is
 * Jev deciding, `madani` a quick model of the person's own AI. */
export type ResponderChoice = `leader:${string}` | `member:${string}` | "auto" | "madani" | "everyone" | "mentions";

export function responderChoice(responder: GroupDefaultResponder): ResponderChoice {
  if (responder.kind === "member") return responder.leader ? `leader:${responder.botId}` : `member:${responder.botId}`;
  if (responder.kind === "auto") return responder.by === "madani" ? "madani" : "auto";
  return responder.kind;
}

/** The bot a choice that needs one would pick: who leads or answers now, else the deciders' fallback. */
export function responderLeadId(responder: GroupDefaultResponder): string | undefined {
  return responder.kind === "member" ? responder.botId : responder.kind === "auto" ? responder.fallbackBotId : undefined;
}

export function chosenResponder(choice: string, current: GroupDefaultResponder): GroupDefaultResponder {
  if (choice === "everyone") return { kind: "everyone" };
  if (choice === "mentions") return { kind: "mentions" };
  const lead = responderLeadId(current);
  if (choice === "auto") return lead ? { kind: "auto", fallbackBotId: lead } : { kind: "auto" };
  if (choice === "madani") return lead ? { kind: "auto", fallbackBotId: lead, by: "madani" } : { kind: "auto", by: "madani" };
  if (choice.startsWith("leader:")) return { kind: "member", botId: choice.slice("leader:".length), leader: true };
  return { kind: "member", botId: choice.slice("member:".length) };
}

export function responderTitle(group: Group, members: Bot[], jevOn: boolean): string {
  const responder = effectiveDefaultResponder(group, members);
  const lead = responder.kind === "member" ? members.find((member) => member.id === responder.botId) : undefined;
  const name = lead?.name ?? t("room.responder.leadFallback");
  return responder.kind === "everyone"
    ? t("room.responder.everyone")
    : responder.kind === "mentions"
      ? t("room.responder.mentions")
      : responder.kind === "auto"
        ? jevOn || responder.by === "madani"
          ? t("room.responder.auto")
          : t("room.responder.autoOff", { name: defaultResponderName(group, members) ?? t("room.responder.leadFallback") })
        : responder.leader ? t("room.responder.leader", { name }) : t("room.responder.lead", { name });
}

export function responderShortLabel(group: Group, members: Bot[]): string {
  const responder = effectiveDefaultResponder(group, members);
  if (responder.kind === "everyone") return t("room.panel.responder.everyone");
  if (responder.kind === "mentions") return t("room.panel.responder.mentions");
  if (responder.kind === "auto") return responder.by === "madani" ? t("room.panel.responder.madani") : t("room.panel.responder.jev");
  const name = members.find((member) => member.id === responder.botId)?.name ?? t("room.responder.leadFallback");
  return responder.leader ? t("room.panel.responder.leads", { name }) : name;
}
