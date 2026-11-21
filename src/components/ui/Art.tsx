import { cn } from "@/lib/cn";
import "../../styles/docs-look.css";
import bag from "../../assets/art/bag.webp";
import binoculars from "../../assets/art/binoculars.webp";
import books from "../../assets/art/books.webp";
import briefcase from "../../assets/art/briefcase.webp";
import bubbles from "../../assets/art/bubbles.webp";
import button from "../../assets/art/button.webp";
import cap from "../../assets/art/cap.webp";
import chart from "../../assets/art/chart.webp";
import click from "../../assets/art/click.webp";
import clock from "../../assets/art/clock.webp";
import coins from "../../assets/art/coins.webp";
import computer from "../../assets/art/computer.webp";
import folder from "../../assets/art/folder.webp";
import house from "../../assets/art/house.webp";
import key from "../../assets/art/key.webp";
import laptop from "../../assets/art/laptop.webp";
import magnifier from "../../assets/art/magnifier.webp";
import macKey from "../../assets/art/mac-key.webp";
import mailbox from "../../assets/art/mailbox.webp";
import map from "../../assets/art/map.webp";
import megaphone from "../../assets/art/megaphone.webp";
import mobile from "../../assets/art/mobile.webp";
import mug from "../../assets/art/mug.webp";
import notebook from "../../assets/art/notebook.webp";
import palette from "../../assets/art/palette.webp";
import parcel from "../../assets/art/parcel.webp";
import phone from "../../assets/art/phone.webp";
import plug from "../../assets/art/plug.webp";
import receipt from "../../assets/art/receipt.webp";
import server from "../../assets/art/server.webp";
import shield from "../../assets/art/shield.webp";
import signpost from "../../assets/art/signpost.webp";

const ART = {
  bag, binoculars, books, briefcase, bubbles, button, cap, chart, click, clock, coins, computer, folder, house, key, laptop,
  "mac-key": macKey, magnifier, mailbox, map, megaphone, mobile, mug, notebook, palette, parcel, phone, plug, receipt, server, shield, signpost,
} as const;

export type ArtName = keyof typeof ART;

const SIZES = { sm: "h-8", md: "h-10", lg: "h-14", xl: "h-20" } as const;

/** A group heading's prop: a fixed square beside the heading and its line, whatever the drawing's own proportions. */
export function HeadArt({ name }: { name: ArtName }) {
  return <Art name={name} className="size-8 object-contain" />;
}

export function Art({ name, size = "md", className }: { name: ArtName; size?: keyof typeof SIZES; className?: string }) {
  return (
    <img
      src={ART[name]}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-art={name}
      className={cn("madani-art pointer-events-none w-auto shrink-0 select-none object-contain", SIZES[size], className)}
    />
  );
}

export function ArtState({ art, title, children, action, className, ...rest }: {
  art: ArtName;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  role?: "alert" | "status";
  "data-art-state"?: string;
}) {
  return (
    <div {...rest} data-art-state={rest["data-art-state"] ?? ""} className={cn("group/art flex flex-col items-center gap-1 px-6 py-8 text-center", className)}>
      <Art name={art} size="lg" className="mb-3" />
      <p className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-ink text-balance">{title}</p>
      {children && <p className="max-w-[340px] text-[13px] font-medium leading-[18px] text-ink-secondary text-pretty">{children}</p>}
      {action && <div className="mt-3 flex items-center gap-2">{action}</div>}
    </div>
  );
}
