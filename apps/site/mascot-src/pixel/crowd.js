// the twenty pixel bots (the same drawings as explore/pixel/crowd.js) and how the site names them. build-pages.mjs draws
// their rest frames into the pages, site.js brings them to life
import MadaniPixel from './engine.js';

// the electric palette: one solid colour per bot
export const COLOURS = {
  blue: '#286ef9', sky: '#04a2ed', cyan: '#1cb7d8', violet: '#894ef0', pink: '#f12b93', coral: '#f75e51',
  tangerine: '#fb7c01', sun: '#e5a915', lime: '#7ac70f', mint: '#26cb96', emerald: '#10a760', indigo: '#4744e2',
};
// the site's older colour names, each on its nearest electric colour
export const COLOUR_ALIAS = { orange: 'tangerine', purple: 'violet', green: 'emerald', yellow: 'sun', teal: 'mint' };
export const colourName = (name) => (COLOURS[name] || name === 'white' ? name : COLOUR_ALIAS[name]) || 'blue';

const mo = (x) => Object.assign({ mir: 1 }, x);
// name, colour, drawing. floor at N, centre at N/2
export const CROWD = [
  ['pip', 'blue', { eyes: { w: 2, h: 4, gap: 4, y: 7 }, parts: [['e', 8, 10, 6.6, 6]] }],
  ['kit', 'violet', { eyes: { w: 2, h: 3, gap: 4, y: 9 }, parts: [
    ['s', 8, 10.8, 6.8, 5.3, 3],
    ['p', 1.8, 8, 2.6, 1.4, 6.8, 6, mo({ piv: [4.4, 7], q: 'twitch', amp: 10 })],
  ] }],
  ['hop', 'sky', { N: 20, eyes: { w: 2, h: 4, gap: 4, y: 12.4 }, parts: [
    ['e', 10, 14.6, 7.6, 5.4],
    ['l', 7.2, 10, 6.4, 2, 3, mo({ piv: [7.2, 10], q: 'sway', amp: 4, sp: 0.7 })],
  ], quirks: ['look', 'twitch', 'hop'] }],
  ['bruin', 'emerald', { eyes: { w: 2, h: 3, gap: 4, y: 8.6 }, parts: [
    ['c', 8, 10, 6.3], ['c', 3, 4.8, 2.4, mo({ piv: [3.4, 6.4], q: 'twitch', amp: 8 })],
  ] }],
  ['boo', 'indigo', { float: 1, eyes: { w: 2, h: 4, gap: 3, y: 5.4 }, parts: [
    ['c', 8, 7.5, 6], ['r', 2, 7.5, 14, 15, 0],
    ['c', 4.7, 15.6, 1.6, { cut: 1 }], ['c', 8, 15.6, 1.6, { cut: 1 }], ['c', 11.3, 15.6, 1.6, { cut: 1 }],
  ] }],
  ['mochi', 'pink', { eyes: { w: 2, h: 3, gap: 6, y: 10 }, parts: [['s', 8, 12.2, 7.6, 4.3, 2.4]], p: { zeta: 0.32 } }],
  ['loaf', 'tangerine', { eyes: { w: 2, h: 3, gap: 5, y: 9 }, parts: [['r', 1.5, 6, 14.5, 16, 4.5]], p: { hop: 0.8 } }],
  ['cheep', 'sun', { eyes: { w: 2, h: 3, gap: 3, y: 8 }, parts: [
    ['c', 8, 10, 6],
    ['l', 8, 4.6, 6, 1.2, 1.2, { piv: [8, 4.6], g: 'tuft', q: 'sway', amp: 8 }],
    ['l', 8, 4.6, 10.4, 1.6, 1.2, { piv: [8, 4.6], g: 'tuft' }],
  ], p: { blink: 3 } }],
  ['ribbit', 'lime', { eyes: { w: 2, h: 3, gap: 5, y: 6.6 }, parts: [['s', 8, 12, 7.6, 4, 2.4], ['c', 4.4, 7.6, 3.4, { mir: 1 }]], p: { hop: 1.2 } }],
  ['goo', 'mint', { eyes: { w: 2, h: 3, gap: 3, y: 8.8 }, parts: [['e', 8, 13, 7.6, 3.2], ['e', 8, 10, 5, 5.6]], p: { zeta: 0.3, bamp: 0.04 } }],
  ['puff', 'cyan', { float: 1, eyes: { w: 2, h: 3, gap: 3, y: 9 }, parts: [
    ['c', 4.8, 11.2, 3.5], ['c', 8.6, 8.6, 4.6], ['c', 12, 11.6, 3.2], ['r', 1.4, 11, 14.9, 15, 2.4],
  ] }],
  ['sprout', 'emerald', { eyes: { w: 2, h: 3, gap: 3, y: 9.4 }, parts: [
    ['e', 8, 11, 6.6, 5],
    ['l', 8, 6.4, 8, 3.8, 1.2, { g: 'leaf', piv: [8, 6.2], q: 'sway', amp: 7 }],
    ['e', 10.6, 3.2, 2.5, 1.4, { g: 'leaf', piv: [8, 6.2] }],
  ] }],
  ['drip', 'blue', { eyes: { w: 2, h: 3, gap: 2, y: 9.6 }, parts: [['c', 8, 11.2, 4.9], ['p', 8, 1.4, 3.6, 9.4, 12.4, 9.4]] }],
  ['hearty', 'pink', { eyes: { w: 1, h: 3, gap: 3, y: 6.4 }, parts: [['c', 5.2, 7, 3.8], ['c', 10.8, 7, 3.8], ['p', 1.5, 8.2, 14.5, 8.2, 8, 15.6]] }],
  ['starry', 'sun', { N: 20, eyes: { w: 1, h: 3, gap: 2, y: 9.2 }, parts: [
    ['p', 10, 1, 12.6, 7.3, 19.4, 7.6, 14.1, 12, 15.9, 19, 10, 15.2, 4.1, 19, 5.9, 12, 0.6, 7.6, 7.4, 7.3], ['c', 10, 11, 4.6],
  ] }],
  ['hoot', 'violet', { eyes: { w: 2, h: 4, gap: 3, y: 6.4 }, parts: [
    ['s', 8, 9.6, 6.2, 6.4, 2.6],
    ['p', 2.4, 5, 3.2, 1, 6.2, 3.8, mo({ piv: [4.2, 4.5], q: 'twitch', amp: 6 })],
  ], p: { blink: 6 } }],
  ['boxo', 'cyan', { eyes: { w: 2, h: 3, gap: 4, y: 7.6 }, parts: [
    ['r', 2, 4.4, 14, 16, 1.2],
    ['l', 8, 4.5, 8, 2.4, 1, { g: 'ant', piv: [8, 4.5], q: 'bob', amp: 10 }],
    ['c', 8, 2, 2, { g: 'ant', piv: [8, 4.5] }],
  ], p: { zeta: 0.5 } }],
  ['egg', 'mint', { eyes: { w: 2, h: 3, gap: 2, y: 8.4 }, parts: [['e', 8, 9.6, 5.2, 6.4]] }],
  ['wisp', 'coral', { float: 1, eyes: { w: 1, h: 3, gap: 2, y: 9.4 }, parts: [
    ['c', 8, 11, 4.8], ['p', 8.6, 1, 3.4, 9.4, 12.6, 9.4, { piv: [8, 10], q: 'sway', amp: 6, sp: 1.2 }],
  ] }],
  ['tofu', 'violet', { eyes: { w: 2, h: 3, gap: 4, y: 9 }, parts: [['r', 2, 4, 14, 16, 2.2]], p: { zeta: 0.5, hop: 0.8 } }],
];

for (const [name, , def] of CROWD) MadaniPixel.define(name, def);
export const NAMES = CROWD.map(([name]) => name);
export const HOME_COLOUR = Object.fromEntries(CROWD.map(([name, colour]) => [name, colour]));

// the smooth bots' shapes, each on the pixel bot that reads closest
export const SHAPES = {
  circle: 'pip', squircle: 'loaf', pill: 'mochi', hex: 'boxo', star: 'starry', heart: 'hearty', drop: 'drip', moon: 'wisp',
  cloud: 'puff', clover: 'kit', pixel: 'tofu', capsule: 'mochi', gem: 'boxo', blob: 'pip', teardrop: 'drip', square: 'loaf', crescent: 'wisp',
};
export const bodyName = (name) => (HOME_COLOUR[name] ? name : SHAPES[name]) || 'pip';
export { MadaniPixel };
