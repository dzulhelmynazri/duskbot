// the madani logo: kit, the white pixel cat, in front of a sunrise, one cell per pixel of a 33 by 33 grid

export const LOGO_SIZE = 33;
export const KIT = "#ffffff";
export const EYE = "#212121";

const PALETTE = ["#06bafd", "#212121", "#3cd0fd", "#43d1fd", "#87e2fc", "#90e4fc", "#c2ecfc", "#c6f43a", "#c9f63f", "#ccf746", "#d0cefb", "#ffffff"];
const ROWS = [
  "000000000000000000000000000000000",
  "000000000000000000000000000000000",
  "000000000000000000000000000000000",
  "000000000000000000000000000000000",
  "222222222222222222222222222222222",
  "222222222222222222222222222222222",
  "22222222b22222222222222b222222222",
  "22222222bb222222222222bb222222222",
  "2222222bbbb2222222222bbbb22222222",
  "2222222bbbbb22222222bbbbb22222222",
  "2222222bbbbbb222222bbbbbb22222222",
  "2222222bbbbbbbbbbbbbbbbbb22222222",
  "3333333bbbbbbbbbbbbbbbbbb33333333",
  "3333333bbbbbbbbbbbbbbbbbb33333333",
  "3333333bbbbbbbbbbbbbbbbbb33333333",
  "444444bbbbbbbbbbbbbbbbbbbb4444444",
  "444444bbbb111bbbbbb111bbbb4444444",
  "555555bbbb111bbbbbb111bbbb5555555",
  "666666bbbb111bbbbbb111bbbb6666666",
  "666666bbbb111bbbbbb111bbbb6666666",
  "666666bbbb111bbbbbb111bbbb6666666",
  "aaaaaabbbb111bbbbbb111bbbb6888888",
  "8aaa88bbbbbbbbbbbbbbbbbbbb8888888",
  "877788bbbbbbbbbbbbbbbbbbbb8888887",
  "8777888bbbbbbbbbbbbbbbbbb88888887",
  "88888887bbbbbbbbbbbbbbbb888887888",
  "7888778888bbbbbbbbbbbb77787887888",
  "788877888888888888888888888888888",
  "788877778888888888788888888888887",
  "888888888888888888788778877888778",
  "888888778888887888888887787888888",
  "888888778888887888888888787888888",
  "788788888888888888899888887887888",
];

/** the logo as rows of hex colours */
export const LOGO = ROWS.map((row) => [...row].map((c) => PALETTE[parseInt(c, 16)]));

const isKit = (c) => c === KIT || c === EYE;

/** the sunrise alone: each kit cell takes the scene colour beside it on its row */
export const SCENE = LOGO.map((row) => row.map((c, x) => {
  if (!isKit(c)) return c;
  for (let d = 1; d < row.length; d++) {
    if (x - d >= 0 && !isKit(row[x - d])) return row[x - d];
    if (x + d < row.length && !isKit(row[x + d])) return row[x + d];
  }
  return c;
}));

/** kit alone, the scene left empty */
export const KIT_ONLY = LOGO.map((row) => row.map((c) => (isKit(c) ? c : null)));

/** svg rects for a grid of colours (null is empty), each run of one colour on a row merged into one rect */
export function cells(grid, { x = 0, y = 0, cell = 1 } = {}) {
  let out = "";
  grid.forEach((row, j) => {
    for (let i = 0; i < row.length; ) {
      const c = row[i];
      let k = i + 1;
      while (k < row.length && row[k] === c) k++;
      if (c) out += `<rect x="${+(x + i * cell).toFixed(3)}" y="${+(y + j * cell).toFixed(3)}" width="${+((k - i) * cell).toFixed(3)}" height="${+cell.toFixed(3)}" fill="${c}"/>`;
      i = k;
    }
  });
  return `<g shape-rendering="crispEdges">${out}</g>`;
}

/** the whole logo filling a box of `size` at (x, y), its corners rounded by `radius` */
export function logoTile({ size = 1024, x = 0, y = 0, radius = 0, grid = LOGO, id = "logo-tile" } = {}) {
  const cell = size / LOGO_SIZE;
  if (!radius) return cells(grid, { x, y, cell });
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}"/></clipPath><g clip-path="url(#${id})">${cells(grid, { x, y, cell })}</g>`;
}

export const svg = (w, h, inner, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${extra}>${inner}</svg>`;

/** kit simplified to read in a 16 px menu bar: # is body, . is empty (the eyes are holes) */
export const KIT_GLYPH = [
  "................",
  "................",
  "..#..........#..",
  "..##........##..",
  "..###......###..",
  "..############..",
  ".##############.",
  ".###..####..###.",
  ".###..####..###.",
  ".###..####..###.",
  ".###..####..###.",
  ".##############.",
  ".##############.",
  "..############..",
  "...##########...",
  "................",
];
