import { Pencil, Pin, PinOff, RefreshCw, ShieldAlert, Square, Volume2 } from "../icons";
import { aiReportHandler } from "@/lib/ai-report";
import { t } from "@/lib/i18n";
import type { ConfigStatus, Group, Message, useStore } from "@/state/store";
import { ACTION_ICON, type MessageMenuItem } from "@/components/MessageActions";
import { useSpeakAction } from "@/components/SpeakButton";

export type PinAction = { pinned: boolean; onToggle: () => void; hint?: string };

export function roomPin(group: Group, message: Message, dispatch: ReturnType<typeof useStore>["dispatch"]): PinAction | undefined {
  if (window.madaniDesktop?.remoteClient?.active) return undefined;
  const pinned = group.pinnedMessageId === message.id;
  return {
    pinned,
    hint: t("room.pinHintChat"),
    onToggle: () => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: pinned ? "" : message.id } }),
  };
}

function pinItem(pin: PinAction | undefined): MessageMenuItem[] {
  if (!pin) return [];
  return [{
    key: "pin",
    icon: pin.pinned ? <PinOff {...ACTION_ICON} /> : <Pin {...ACTION_ICON} />,
    label: pin.pinned ? t("chat.unpinMessage") : t("chat.pinMessage"),
    title: pin.pinned ? t("chat.unpinHint") : pin.hint ?? t("chat.pinHintChat"),
    onSelect: pin.onToggle,
  }];
}

export function useBotMessageMenu({
  text,
  botId,
  messageId,
  voiceId,
  tts,
  localVoice,
  canSpeak,
  onRegenerate,
  pin,
}: {
  text: string;
  botId?: string;
  messageId: string;
  voiceId?: string;
  tts: ConfigStatus["tts"];
  localVoice: boolean;
  canSpeak: boolean;
  onRegenerate?: () => void;
  pin?: PinAction;
}): MessageMenuItem[] {
  const speak = useSpeakAction({ text, botId, messageId, voiceId, tts, localVoice });
  const items: MessageMenuItem[] = [];
  if (canSpeak && text) {
    items.push({
      key: "speak",
      icon: speak.mine ? <Square {...ACTION_ICON} /> : <Volume2 {...ACTION_ICON} />,
      label: speak.mine ? t("chat.speak.stop") : t("chat.speak.read"),
      title: speak.label,
      disabled: !speak.ready,
      onSelect: speak.toggle,
    });
  }
  if (onRegenerate) items.push({ key: "regenerate", icon: <RefreshCw {...ACTION_ICON} />, label: t("chat.regenerate"), onSelect: onRegenerate });
  items.push(...pinItem(pin));
  const report = aiReportHandler();
  if (report && text) items.push({ key: "report", icon: <ShieldAlert {...ACTION_ICON} />, label: t("chat.reportReply"), onSelect: () => report({ messageId, text }) });
  return items;
}

export function userMessageMenu({ onEdit, pin }: { onEdit?: () => void; pin?: PinAction }): MessageMenuItem[] {
  return [
    ...(onEdit ? [{ key: "edit", icon: <Pencil {...ACTION_ICON} />, label: t("chat.editMessage"), onSelect: onEdit, idleOnly: true }] : []),
    ...pinItem(pin),
  ];
}
