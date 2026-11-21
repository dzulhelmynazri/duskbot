import { botAccentScope } from "@/lib/bot-accent";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "../icons";
import { effortLabel, ModelPicker } from "@/components/ModelPicker";
import { effortLevelsFor } from "@/components/model-picker-reasoning";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import { haptic } from "./haptics";
import { Sheet } from "./Sheet";
import { SettingsSection } from "./sheets/SettingsRow";

const ROW = "mobile-row flex min-h-[52px] w-full items-center gap-3 rounded-[inherit] px-4 py-2 text-left text-ink";

const presentOver = (sheet: ReactNode) => createPortal(sheet, document.querySelector(".madani-mobile") ?? document.body);

/** The bot's model as a phone settings row: Model on the left, the model on the right, and the picker in its own sheet
 * over the bot's. Under it, Thinking, when the model takes a thinking level. */
export function PhoneModelRow({ bot }: { bot: Bot }) {
  return (
    <>
      <ModelPicker
        bot={bot}
        threadId={bot.threadId}
        contained
        className="p-0!"
        label={<span className="block truncate text-[16px] font-medium text-ink">{t("botPanel.page.model")}</span>}
        asRow={{
          className: ROW,
          present: ({ open, close, content }) => presentOver(
            <Sheet open={open} onClose={close} title={t("model.choose")} recede={false}><div {...botAccentScope(bot.color)} className="contents">{content}</div></Sheet>,
          ),
        }}
      />
      <PhoneThinkingRow bot={bot} />
    </>
  );
}

/** The level the bot's model thinks at, saved the way the desktop picker saves it: on this conversation, and as the bot's
 * own when the person may change the bot. */
export function PhoneThinkingRow({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const mayChangeBot = useOwnerOrAdmin() === true;
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  const levels = instance?.capabilities?.modelVariants ? [] : effortLevelsFor(instance, selection.model) ?? [];
  if (!levels.length) return null;
  const current = selection.effort && levels.includes(selection.effort) ? selection.effort : undefined;

  const choose = (level: EffortLevel | undefined) => {
    if (level === current) return;
    haptic("pick");
    const { effort: _effort, ...model } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId: bot.threadId, ...(mayChangeBot ? { updateBotDefault: true } : {}),
      selection: level ? { ...model, effort: level } : model, ...(bot.busy ? { nextTurn: true } : {}) });
  };

  return (
    <>
      <button type="button" data-phone-thinking-row="" onClick={() => setOpen(true)} className={ROW}>
        <span className="min-w-0 flex-1 truncate text-[16px] font-medium">{t("botSettings.simple.thinking")}</span>
        <span className="min-w-0 max-w-[55%] shrink-0 truncate text-[15px] text-ink-secondary">{current ? effortLabel(current) : t("model.effort.default")}</span>
        <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-ink-tertiary" />
      </button>
      {presentOver(
        <Sheet open={open} onClose={() => setOpen(false)} title={t("botSettings.simple.thinking")} recede={false}>
          <div {...botAccentScope(bot.color)} className="contents">
          <SettingsSection card hint={current ? t("model.simple.thinkingLevel", { level: effortLabel(current) }) : t("model.simple.thinkingDefault")}>
            {[undefined, ...levels].map((level) => (
              <button key={level ?? "default"} type="button" aria-pressed={level === current} data-phone-thinking-option={level ?? "default"}
                onClick={() => choose(level)} className="mobile-row flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left text-[16px] font-medium text-ink">
                <span className="min-w-0 flex-1">{level ? effortLabel(level) : t("model.effort.default")}</span>
                {level === current && <Check aria-hidden size={20} />}
              </button>
            ))}
          </SettingsSection>
          </div>
        </Sheet>,
      )}
    </>
  );
}
