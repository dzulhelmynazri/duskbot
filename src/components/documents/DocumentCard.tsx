import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Message } from "@/state/store";
import { openBotSettingsPage } from "../bot-panel/panel-link";
import { FileKindIcon } from "../bot-panel/FileKindIcon";
import { documentShapeLine, glyphName, setOpenDocument, type ChatDocumentCard } from "./document-data";

/** The card's peek at the file: the top of the page, fading out where the card ends. Spans only, inside the button. */
function Peek({ card }: { card: ChatDocumentCard }) {
  if (card.kind === "markdown" && card.lines?.length) {
    return (
      <span aria-hidden="true" data-document-peek="markdown" className={cn(PEEK, "block px-3 py-2")}>
        {card.lines.map((line, index) => (
          <span key={index} dir="auto" className={cn("block truncate", index === 0 ? "text-ink" : "text-ink-secondary")}>{line}</span>
        ))}
      </span>
    );
  }
  if (card.kind === "sheet" && card.grid?.length) {
    const columns = Math.max(1, card.grid[0]?.length ?? 1);
    return (
      <span aria-hidden="true" data-document-peek="sheet" className={cn(PEEK, "grid text-[12px] leading-[26px] tabular-nums")} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {card.grid.map((row, at) => row.map((cell, index) => (
          <span key={`${at}:${index}`} className={cn("truncate px-3", at === 0 ? "font-medium text-ink-secondary" : "text-ink shadow-[inset_0_0.5px_0_color-mix(in_srgb,var(--color-ink)_8%,transparent)]")}>{cell}</span>
        )))}
      </span>
    );
  }
  return null;
}

const PEEK =
  "pointer-events-none mx-1 mb-1 max-h-[108px] overflow-hidden rounded-[12px] bg-ink/[0.035] text-[13px] leading-5 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]";

/** A document the bot made, in the chat: its name, what it is, a peek at the top, and Open, which shows it in the bot's
 * panel to read, edit and download. The card is one button; it never starts a turn. */
export function DocumentCard({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const card = message.document;
  if (!card) return null;
  const open = () => {
    setOpenDocument({ botId: card.botId, id: card.id });
    openBotSettingsPage(dispatch, card.botId, "document");
  };
  const shape = documentShapeLine(card);
  return (
    <button
      type="button"
      data-document-card={card.id}
      onClick={open}
      aria-label={t("documents.openNamed", { title: card.title })}
      className="madani-press-soft group block w-full max-w-md cursor-pointer rounded-[18px] bg-(--chat-card) p-1 text-start transition-[background-color] duration-150 ease-out hover:bg-[color-mix(in_srgb,var(--chat-card),var(--color-ink)_3%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="flex min-w-0 items-center gap-2.5 px-2.5 py-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-ink/[0.05]"><FileKindIcon name={glyphName(card.kind)} /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span dir="auto" className="truncate text-[14px] font-medium leading-5 text-ink">{card.title}</span>
          <span className="truncate text-[12px] leading-[18px] text-ink-tertiary">
            {card.change === "updated" ? `${t("documents.updated")} · ${shape}` : shape}
          </span>
        </span>
        <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-ink/[0.07] px-3 text-[13px] font-medium leading-5 text-ink transition-[background-color] duration-150 ease-out group-hover:bg-ink/[0.11]">
          {t("documents.open")}
        </span>
      </span>
      <Peek card={card} />
    </button>
  );
}
