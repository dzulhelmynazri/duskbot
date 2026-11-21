import { useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isTableNumber } from "@/lib/table-data";

/** Rows drawn at once; a longer sheet says how many are left and is still saved whole. */
export const SHEET_ROWS_SHOWN = 1000;

const columnName = (index: number): string => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

const cellCls = "h-8 min-w-[96px] max-w-[280px] px-2.5 text-[13px] leading-8 shadow-[inset_-0.5px_-0.5px_0_color-mix(in_srgb,var(--color-ink)_9%,transparent)]";

/** A sheet as a grid: the first row is the header. Editing, every cell is a field; Enter moves down a row, as in a
 * spreadsheet, and the grid gains a row or a column from its own buttons. */
export function SheetGrid({ grid, editing, title, onChange }: {
  grid: string[][];
  editing: boolean;
  title: string;
  onChange?: (next: string[][]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const shown = grid.slice(0, SHEET_ROWS_SHOWN + 1);
  const width = grid[0]?.length ?? 0;
  const set = (row: number, column: number, value: string) => {
    onChange?.(grid.map((cells, at) => (at === row ? cells.map((cell, index) => (index === column ? value : cell)) : cells)));
  };
  const addRow = () => onChange?.([...grid, Array.from({ length: width }, () => "")]);
  const addColumn = () => onChange?.(grid.map((cells, at) => [...cells, at === 0 ? columnName(width) : ""]));
  const move = (event: KeyboardEvent<HTMLInputElement>, row: number, column: number) => {
    if (event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); return; }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const next = row + (event.shiftKey ? -1 : 1);
    root.current?.querySelector<HTMLInputElement>(`[data-cell="${next}:${column}"]`)?.focus();
  };

  return (
    <div ref={root} data-sheet-grid={editing ? "editing" : "view"} className="flex min-w-0 flex-col gap-2">
      <div className="max-h-[calc(100dvh-180px)] min-w-0 overflow-auto rounded-[12px] bg-(--chat-card) [scrollbar-width:thin]">
        <table aria-label={title} className="border-separate border-spacing-0 tabular-nums">
          <thead className="sticky top-0 z-[1]">
            <tr>
              <th scope="col" className={cn(cellCls, "sticky left-0 z-[2] w-10 min-w-10 bg-(--chat-card) px-0 text-center text-[11px] font-normal text-ink-tertiary")}><span className="sr-only">{t("documents.sheet.row")}</span></th>
              {(shown[0] ?? []).map((cell, column) => (
                <th key={column} scope="col" className={cn(cellCls, "bg-[color-mix(in_srgb,var(--chat-card),var(--color-ink)_4%)] text-start font-medium text-ink", editing && "p-0")}>
                  {editing
                    ? <input data-cell={`0:${column}`} aria-label={t("documents.sheet.header", { column: columnName(column) })} value={cell} onChange={(event) => set(0, column, event.target.value)} onKeyDown={(event) => move(event, 0, column)} className={INPUT} />
                    : <span className="block truncate" title={cell}>{cell}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.slice(1).map((cells, at) => {
              const row = at + 1;
              return (
                <tr key={row}>
                  <th scope="row" className={cn(cellCls, "sticky left-0 z-[1] w-10 min-w-10 bg-(--chat-card) px-0 text-center text-[11px] font-normal text-ink-tertiary")}>{row}</th>
                  {cells.map((cell, column) => (
                    <td key={column} className={cn(cellCls, "text-ink", editing && "p-0", !editing && isTableNumber(cell) && "text-end")}>
                      {editing
                        ? <input data-cell={`${row}:${column}`} aria-label={t("documents.sheet.cell", { cell: `${columnName(column)}${row}` })} value={cell} onChange={(event) => set(row, column, event.target.value)} onKeyDown={(event) => move(event, row, column)} className={INPUT} />
                        : <span className="block truncate" title={cell}>{cell}</span>}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {grid.length - 1 > SHEET_ROWS_SHOWN && (
        <p className="px-1 text-[12px] leading-[18px] text-ink-tertiary">{t("documents.sheet.more", { n: (grid.length - 1 - SHEET_ROWS_SHOWN).toLocaleString() })}</p>
      )}
      {editing && (
        <div className="flex gap-1.5">
          <button type="button" data-sheet-add="row" onClick={addRow} className={ADD}>{t("documents.sheet.addRow")}</button>
          <button type="button" data-sheet-add="column" onClick={addColumn} className={ADD}>{t("documents.sheet.addColumn")}</button>
        </div>
      )}
    </div>
  );
}

const INPUT = "block h-8 w-full min-w-[96px] bg-transparent px-2.5 text-[13px] text-inherit outline-none focus:bg-accent/[0.08] focus:shadow-[inset_0_0_0_1.5px_var(--color-focus)]";
const ADD = "madani-press inline-flex h-7 items-center rounded-full bg-ink/[0.06] px-3 text-[13px] leading-5 text-ink hover:bg-ink/[0.1] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";
