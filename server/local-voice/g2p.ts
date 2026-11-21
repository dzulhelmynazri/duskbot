// English text to Kokoro's phoneme alphabet. Ported in part from misaki (https://github.com/hexgrad/misaki,
// Apache-2.0, Copyright hexgrad): the lexicon lookup, -s/-ed/-ing endings and stress handling. No eSpeak NG: words no
// dictionary knows are split into known parts or sounded out by spelling rules.
import { wordsForNumbers } from "./numbers.ts";

export type LexiconEntry = string | Record<string, string | null>;
export type LexiconTable = Record<string, LexiconEntry>;

/** Dictionaries in the order they are trusted. */
export interface Lexicons {
  gold: LexiconTable;
  silver: LexiconTable;
  extra?: LexiconTable;
}

const PRIMARY = "ˈ";
const SECONDARY = "ˌ";
const VOWELS = new Set("AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ");
const TAUS = new Set("AIOWYiuæɑəɛɪɹʊʌ");
const PUNCTUATION = new Set([".", ",", "!", "?", ";", ":", "—", "…", "(", ")", "\""]);

const OWN_WORDS: Record<string, string> = {
  madani: "dˈʌsk",
  github: "ɡˈɪthˌʌb",
  gmail: "ʤˈimˌAl",
  iphone: "ˈIfˌOn",
  ios: "ˌIˌOˈɛs",
  macos: "mˈækˌOˈɛs",
  ok: "ˌOkˈA",
  todo: "tˈuˌdu",
  todos: "tˈuˌduz",
  wifi: "wˈIfˌI",
  app: "ˈæp",
  apps: "ˈæps",
  bot: "bˈɑt",
  bots: "bˈɑts",
  inbox: "ˈɪnbˌɑks",
  login: "lˈɔɡˌɪn",
  online: "ˈɔnlˌIn",
  email: "ˈimˌAl",
  emails: "ˈimˌAlz",
  kubernetes: "kˌubəɹnˈɛɾiz",
  slack: "slˈæk",
  notion: "nˈOʃən",
  figma: "fˈɪɡmə",
  vercel: "vˈɜɹsəl",
};

function applyStress(ps: string, stress: number | null): string {
  if (stress === null) return ps;
  const hasVowel = [...ps].some((c) => VOWELS.has(c));
  if (stress < -1) return ps.replaceAll(PRIMARY, "").replaceAll(SECONDARY, "");
  if (stress === -1 || ((stress === 0 || stress === -0.5) && ps.includes(PRIMARY))) {
    return ps.replaceAll(SECONDARY, "").replaceAll(PRIMARY, SECONDARY);
  }
  if ((stress === 0 || stress === 0.5 || stress === 1) && !ps.includes(PRIMARY) && !ps.includes(SECONDARY)) {
    return hasVowel ? restress(SECONDARY + ps) : ps;
  }
  if (stress >= 1 && !ps.includes(PRIMARY) && ps.includes(SECONDARY)) return ps.replaceAll(SECONDARY, PRIMARY);
  if (stress > 1 && !ps.includes(PRIMARY) && !ps.includes(SECONDARY)) return hasVowel ? restress(PRIMARY + ps) : ps;
  return ps;
}

/** A stress mark belongs right before the vowel it stresses. */
function restress(ps: string): string {
  const chars = [...ps];
  const out: string[] = [];
  let pending: string | null = null;
  for (const c of chars) {
    if (c === PRIMARY || c === SECONDARY) {
      pending = c;
      continue;
    }
    if (pending && VOWELS.has(c)) {
      out.push(pending);
      pending = null;
    }
    out.push(c);
  }
  return out.join("");
}

const LETTERS: Record<string, string> = {
  a: "ˈA", b: "bˈi", c: "sˈi", d: "dˈi", e: "ˈi", f: "ˈɛf", g: "ʤˈi", h: "ˈAʧ", i: "ˈI", j: "ʤˈA", k: "kˈA", l: "ˈɛl", m: "ˈɛm",
  n: "ˈɛn", o: "ˈO", p: "pˈi", q: "kjˈu", r: "ˈɑɹ", s: "ˈɛs", t: "tˈi", u: "jˈu", v: "vˈi", w: "dˈʌbᵊlju", x: "ˈɛks", y: "wˈI", z: "zˈi",
};

export function spelled(word: string): string {
  const parts = [...word.toLowerCase()].filter((c) => LETTERS[c]).map((c) => applyStress(LETTERS[c]!, -1));
  if (!parts.length) return "";
  parts[parts.length - 1] = parts[parts.length - 1]!.replace(SECONDARY, PRIMARY);
  return parts.join("");
}

/** Ordered: longer spellings first. */
const SOUNDS: Array<[RegExp, string]> = [
  [/^tion/, "ʃən"], [/^sion/, "ʒən"], [/^ture/, "ʧəɹ"], [/^eigh/, "A"], [/^ough/, "O"], [/^augh/, "ɔ"], [/^igh/, "I"],
  [/^tch/, "ʧ"], [/^dge/, "ʤ"], [/^sch/, "sk"], [/^ph/, "f"], [/^th/, "θ"], [/^sh/, "ʃ"], [/^ch/, "ʧ"], [/^ck/, "k"],
  [/^ng/, "ŋ"], [/^qu/, "kw"], [/^wh/, "w"], [/^gh/, ""], [/^ee/, "i"], [/^ea/, "i"], [/^oo/, "u"], [/^ou/, "W"],
  [/^ow/, "O"], [/^oi/, "Y"], [/^oy/, "Y"], [/^ai/, "A"], [/^ay/, "A"], [/^au/, "ɔ"], [/^aw/, "ɔ"], [/^ie/, "i"],
  [/^ei/, "A"], [/^ey/, "i"], [/^ue/, "u"], [/^ew/, "u"], [/^oa/, "O"], [/^ar/, "ɑɹ"], [/^or/, "ɔɹ"], [/^er/, "ɜɹ"],
  [/^ir/, "ɜɹ"], [/^ur/, "ɜɹ"], [/^x/, "ks"], [/^c(?=[eiy])/, "s"], [/^c/, "k"], [/^g(?=[ei])/, "ʤ"], [/^g/, "ɡ"],
  [/^j/, "ʤ"], [/^r/, "ɹ"], [/^y(?=[aeiou])/, "j"], [/^y$/, "i"], [/^y/, "ɪ"], [/^q/, "k"],
  [/^a(?=[^aeiouy]e$)/, "A"], [/^i(?=[^aeiouy]e$)/, "I"], [/^o(?=[^aeiouy]e$)/, "O"], [/^u(?=[^aeiouy]e$)/, "u"],
  [/^e(?=[^aeiouy]e$)/, "i"], [/^e$/, ""], [/^a/, "æ"], [/^e/, "ɛ"], [/^i/, "ɪ"], [/^o/, "ɑ"], [/^u/, "ʌ"],
  [/^([bdfhklmnpstvwz])\1/, "$1"], [/^([bdfhklmnpstvwz])/, "$1"],
];

/** Spelling rules for a word no dictionary has: rough, but it says the word instead of its letters. */
export function soundedOut(word: string): string {
  let rest = word.toLowerCase().replace(/[^a-z]/g, "");
  let out = "";
  if (rest.startsWith("kn")) rest = rest.slice(1);
  else if (rest.startsWith("wr")) rest = rest.slice(1);
  while (rest) {
    const rule = SOUNDS.find(([pattern]) => pattern.test(rest));
    if (!rule) {
      rest = rest.slice(1);
      continue;
    }
    const match = rule[0].exec(rest)!;
    out += rule[1].replace("$1", match[1] ?? "");
    rest = rest.slice(match[0].length);
  }
  return restress(PRIMARY + out);
}

export function createG2p(lexicons: Lexicons): (text: string) => string {
  const tables = [lexicons.gold, lexicons.silver, ...(lexicons.extra ? [lexicons.extra] : [])];

  const entryFor = (word: string): string | null => {
    for (const table of tables) {
      const candidates = word === word.toLowerCase()
        ? [word, word[0]!.toUpperCase() + word.slice(1)]
        : word === word[0] + word.slice(1).toLowerCase() ? [word, word.toLowerCase()] : [word];
      for (const candidate of candidates) {
        const entry = table[candidate];
        if (entry === undefined) continue;
        if (typeof entry === "string") return entry;
        const choice = entry.DEFAULT ?? Object.values(entry).find((value): value is string => typeof value === "string");
        if (choice) return choice;
      }
    }
    return null;
  };

  const known = (word: string): boolean => word.length > 1 && entryFor(word) !== null;

  const plural = (stem: string): string => {
    const last = stem.at(-1) ?? "";
    if ("ptkfθ".includes(last)) return `${stem}s`;
    if ("szʃʒʧʤ".includes(last)) return `${stem}ᵻz`;
    return `${stem}z`;
  };
  const past = (stem: string): string => {
    const last = stem.at(-1) ?? "";
    if ("pkfθʃsʧ".includes(last)) return `${stem}t`;
    if (last === "d") return `${stem}ᵻd`;
    if (last !== "t") return `${stem}d`;
    if (stem.length > 1 && TAUS.has(stem.at(-2)!)) return `${stem.slice(0, -1)}ɾᵻd`;
    return `${stem}ᵻd`;
  };
  const continuous = (stem: string): string => {
    if (stem.length > 1 && stem.at(-1) === "t" && TAUS.has(stem.at(-2)!)) return `${stem.slice(0, -1)}ɾɪŋ`;
    return `${stem}ɪŋ`;
  };

  const withEnding = (word: string): string | null => {
    const lower = word.toLowerCase();
    if (lower.length >= 3 && lower.endsWith("s")) {
      if (!lower.endsWith("ss") && known(lower.slice(0, -1))) return plural(entryFor(lower.slice(0, -1))!);
      if ((lower.endsWith("'s") || (lower.length > 4 && lower.endsWith("es") && !lower.endsWith("ies"))) && known(lower.slice(0, -2))) {
        return plural(entryFor(lower.slice(0, -2))!);
      }
      if (lower.length > 4 && lower.endsWith("ies") && known(`${lower.slice(0, -3)}y`)) return plural(entryFor(`${lower.slice(0, -3)}y`)!);
    }
    if (lower.length >= 4 && lower.endsWith("d")) {
      if (!lower.endsWith("dd") && known(lower.slice(0, -1))) return past(entryFor(lower.slice(0, -1))!);
      if (lower.length > 4 && lower.endsWith("ed") && !lower.endsWith("eed") && known(lower.slice(0, -2))) return past(entryFor(lower.slice(0, -2))!);
    }
    if (lower.length >= 5 && lower.endsWith("ing")) {
      const stem = lower.slice(0, -3);
      if (stem.length > 2 && known(stem)) return continuous(entryFor(stem)!);
      if (known(`${stem}e`)) return continuous(entryFor(`${stem}e`)!);
      if (/([bcdgklmnprstvxz])\1ing$|cking$/.test(lower) && known(lower.slice(0, -4))) return continuous(entryFor(lower.slice(0, -4))!);
    }
    return null;
  };

  const compound = (word: string, depth = 0): string | null => {
    const lower = word.toLowerCase();
    if (depth > 2 || lower.length < 6) return null;
    for (let cut = lower.length - 3; cut >= 3; cut -= 1) {
      const head = lower.slice(0, cut);
      const tail = lower.slice(cut);
      if (!known(head)) continue;
      const rest = entryFor(tail) ?? withEnding(tail) ?? compound(tail, depth + 1);
      if (rest) return entryFor(head)! + applyStress(rest, -1);
    }
    return null;
  };

  const phonemes = (word: string, nextVowel: boolean | null): string => {
    const lower = word.toLowerCase().replace(/’/g, "'");
    if (lower === "the") return nextVowel ? "ði" : "ðə";
    if (lower === "a") return nextVowel === null ? "ˈA" : "ɐ";
    if (lower === "an") return "ɐn";
    if (lower === "to") return nextVowel === null ? "tˈu" : nextVowel ? "tʊ" : "tə";
    if (word === "I") return `${SECONDARY}I`;
    if (OWN_WORDS[lower]) return OWN_WORDS[lower]!;
    const acronym = /^[A-Z]+$/.test(word) && word !== "I";
    if (acronym && (word.length <= 4 || !entryFor(lower))) {
      const gold = lexicons.gold[word];
      return typeof gold === "string" && gold.includes(PRIMARY) && word.length > 3 ? gold : spelled(word);
    }
    const found = entryFor(word.replace(/’/g, "'")) ?? entryFor(lower);
    if (found) return found;
    if (lower.includes("-")) return lower.split("-").filter(Boolean).map((part) => phonemes(part, null)).join(" ");
    return withEnding(word) ?? compound(word) ?? soundedOut(word);
  };

  return (text: string): string => {
    const normalized = wordsForNumbers(
      text
        .replace(/[“”«»]/g, "\"")
        .replace(/[‘’`]/g, "'")
        .replace(/\.\.\./g, "…")
        .replace(/\s+-\s+|--/g, " — ")
        .replace(/\*|_|#|~|\[|\]|\{|\}|<|>|\|/g, " ")
        .replace(/([A-Za-z])(\d)/g, "$1 $2")
        .replace(/(\d)([A-Za-z]{2,})/g, (whole, digit: string, letters: string) => /^(?:st|nd|rd|th|s)$/i.test(letters) ? whole : `${digit} ${letters}`),
    );
    const tokens = normalized.match(/[A-Za-z]+(?:['-][A-Za-z]+)*|[.,!?;:—…()"]|\S/g) ?? [];
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (PUNCTUATION.has(token)) {
        out.push(token);
        continue;
      }
      if (!/[A-Za-z]/.test(token)) continue;
      const next = tokens.slice(i + 1).find((candidate) => /[A-Za-z]/.test(candidate) || PUNCTUATION.has(candidate));
      const nextVowel = !next || PUNCTUATION.has(next) ? null : /^[aeiou]/i.test(next) && !/^(?:u[nst]i|eu|one)/i.test(next);
      const ps = phonemes(token, nextVowel);
      if (ps) out.push(ps);
    }
    let joined = "";
    for (const piece of out) {
      if (PUNCTUATION.has(piece) && piece !== "(" && piece !== "\"") joined = joined.trimEnd() + piece + " ";
      else joined += `${piece} `;
    }
    return joined.replace(/\s+/g, " ").trim();
  };
}
