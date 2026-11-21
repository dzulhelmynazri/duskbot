import { cn } from "@/lib/cn";

/* pixel marks for adding a place, drawn like PixelIcon's: 11 by 11 cells in the brand pastels, each object outlined in a
   deeper shade of its own colour. A row is a string; "." is empty, a letter a fill, a digit an outline. */
const COLORS: Record<string, string> = {
  w: "#fdfbf7", b: "#7cc6f2", B: "#c4e9fb", g: "#a6dd6c", y: "#f6dc62", p: "#f4a0c4", v: "#b99af2", V: "#e2d6fb",
  G: "#dfe3ea", K: "#a9b3c2", R: "#ef8282", n: "#f3cf98", N: "#e3ad6c", k: "#1b1b1f",
  1: "#3f8fc9", 2: "#8a6fd0", 3: "#d0679a", 4: "#d19a1c", 5: "#b07a3f", 6: "#5f9e34", 7: "#c94f4f", 8: "#7a8495",
};

const ART = {
  // madani cloud: a cloud at madani, the moon coming up behind it
  cloud: [
    ".......444.",
    "......4yyy4",
    "......4yyy4",
    "......4yyy4",
    "....222444.",
    "...2VVV2...",
    ".22VVVVV22.",
    "2VVVVVVVVV2",
    "2VVVVVVVVV2",
    "2vvVVVVVvv2",
    ".222222222.",
  ],
  // a server of the person's own: the box under its own roof
  server: [
    ".....3.....",
    "....3p3....",
    "...3ppp3...",
    "..3ppppp3..",
    ".333333333.",
    ".2VVVVVgV2.",
    ".222222222.",
    ".2VVVVVgV2.",
    ".222222222.",
    ".2VVVVVgV2.",
    ".222222222.",
  ],
  // the madani relay: the mascot carrying a parcel across
  relay: [
    "..1.....1..",
    "..11...11..",
    "..1b111b1..",
    "..1bbbbb1..",
    "..1bkbkb1..",
    "..1bkbkb1..",
    ".555555555.",
    "15NNN5NNN51",
    ".5nnn5nnn5.",
    ".5nnn5nnn5.",
    ".555555555.",
  ],
  // direct: this computer and the server, one straight pipe between
  direct: [
    "...........",
    "...........",
    "...........",
    "1111...2222",
    "1BB16662VV2",
    "1BBbgggvVV2",
    "1BB16662VV2",
    "1111...2222",
    "...........",
    "...........",
    "...........",
  ],
  // your own domain: the world, with a name tag
  domain: [
    "......33333",
    ".....3pppp3",
    "....3wpppp3",
    ".....3pppp3",
    "..111.33333",
    ".1bgb1.....",
    "1bggbb1....",
    "1bbgbg1....",
    "1bbbgg1....",
    ".1bbb1.....",
    "..111......",
  ],
  // a private network: four of your machines, joined only to each other
  mesh: [
    "....222....",
    "....2v2....",
    "....222....",
    "...8...8...",
    "111.....333",
    "1b1.....3p3",
    "111.....333",
    "...8...8...",
    "....666....",
    "....6g6....",
    "....666....",
  ],
  // a tunnel: an arch with the light at the far end
  tunnel: [
    "...........",
    "..4444444..",
    ".4yyyyyyy4.",
    "4yy44444yy4",
    "4y4kkkkk4y4",
    "4y4kkkkk4y4",
    "4y4kkwkk4y4",
    "4y4kkKkk4y4",
    "4y4kKKKk4y4",
    "44444444444",
    "...........",
  ],
  // an SSH tunnel: a terminal and its key
  ssh: [
    "88888888888",
    "8GGGGGGGGG8",
    "88888888888",
    "8kgkkkkkkk8",
    "8kkgkkkkkk8",
    "8kgkggkkkk8",
    "88888888888",
    "...........",
    "...444.....",
    "...4y444444",
    "...444.4.4.",
  ],
  // an address the server already has: a pin on the map
  address: [
    "...33333...",
    "..3ppppp3..",
    ".3pp333pp3.",
    ".3pp3w3pp3.",
    ".3pp333pp3.",
    "..3ppppp3..",
    "...3ppp3...",
    "....3p3....",
    ".....3.....",
    "...88888...",
    "...........",
  ],
  waiting: [
    "55555555555",
    ".8wwwwwww8.",
    ".8wyyyyyw8.",
    "..8yyyyy8..",
    "...8yyy8...",
    "....8y8....",
    "...8wyw8...",
    "..8wwywww8.",
    ".8wwwywww8.",
    ".8wyyyyyw8.",
    "55555555555",
  ],
  expired: [
    "55555555555",
    ".8wwwwwww8.",
    ".8wwwwwww8.",
    "..8wwwww8..",
    "...8www8...",
    "....8w8....",
    "...8www8...",
    "..8wwwww8..",
    ".8wpppppw8.",
    ".8ppppppp8.",
    "55555555555",
  ],
  found: [
    "..1111.....",
    ".1BBBB1....",
    "1BwBBBB1...",
    "1BBggBB1...",
    "1BBggBB1...",
    ".1BBBB15...",
    "..11115n5..",
    "......5nn5.",
    ".......5nn5",
    "........555",
    "...........",
  ],
  setup: [
    "....222....",
    ".22.2v2.22.",
    ".2v2vvv2v2.",
    "..2vvvvv2..",
    "222vv2vv222",
    "2vvv2w2vvv2",
    "222vv2vv222",
    "..2vvvvv2..",
    ".2v2vvv2v2.",
    ".22.2v2.22.",
    "....222....",
  ],
  connected: [
    "...........",
    "...........",
    ".......2222",
    "66666..2VV2",
    "6ggg6662VV2",
    "6ggggg.2VV2",
    "6ggg6662VV2",
    "66666..2VV2",
    ".......2222",
    "...........",
    "...........",
  ],
  error: [
    "...77777...",
    "..7RRRRR7..",
    ".7RRRwRRR7.",
    "7RRRRwRRRR7",
    "7RRRRwRRRR7",
    "7RRRRwRRRR7",
    "7RRRRRRRRR7",
    "7RRRRwRRRR7",
    ".7RRRRRRR7.",
    "..7RRRRR7..",
    "...77777...",
  ],
  // this Mac: an open laptop, its screen catching the light, on a lilac base
  mac: [
    "...........",
    ".222222222.",
    ".2BBBBBBB2.",
    ".2BbBBBBB2.",
    ".2BBbBBBB2.",
    ".2BBBbBBB2.",
    ".2BBBBBBB2.",
    ".222222222.",
    "2VVVVVVVVV2",
    "22222222222",
    "...........",
  ],
  // a phone: lilac case, sky screen catching the light, a pink home dot
  phone: [
    "..2222222..",
    "..2VVVVV2..",
    "..2BBBBB2..",
    "..2BbBBB2..",
    "..2BBbBB2..",
    "..2BBBbB2..",
    "..2BBBBB2..",
    "..2BBBBB2..",
    "..2VVpVV2..",
    "..2222222..",
    "...........",
  ],
} as const;

export type PlaceArtName = keyof typeof ART;

/** one rect per run of a colour along a row */
function runs(rows: readonly string[]) {
  const out: { x: number; y: number; w: number; c: string }[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === c) end += 1;
      if (c !== ".") out.push({ x, y, w: end - x, c });
      x = end;
    }
  });
  return out;
}

const DRAWN = Object.fromEntries(Object.entries(ART).map(([name, rows]) => [name, runs(rows)])) as Record<PlaceArtName, ReturnType<typeof runs>>;

export const PLACE_ART_ROWS: Readonly<Record<PlaceArtName, readonly string[]>> = ART;
export const PLACE_ART_COLORS: Readonly<Record<string, string>> = COLORS;

export function PlaceArt({ name, size = 22, className }: { name: PlaceArtName; size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" data-place-art={name} width={size} height={size} viewBox="0 0 11 11" shapeRendering="crispEdges" className={cn("shrink-0", className)}>
      {DRAWN[name].map((run) => <rect key={`${run.x}-${run.y}`} x={run.x} y={run.y} width={run.w} height={1} fill={COLORS[run.c]} />)}
    </svg>
  );
}
