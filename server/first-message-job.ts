// Whether a person's first line asks for something, or only says hello. Deterministic and cheap: a line is a job unless,
// once greetings, pleasantries, emoji and punctuation are taken off, nothing much is left. Used to skip Madani's
// follow-up when the person already gave it work (helper-followup.ts).

/** greetings and pleasantries, in the languages the app speaks most; a line made only of these is not a job */
const SMALL_TALK = [
  "hi", "hii", "hiya", "hello", "hey", "heya", "yo", "sup", "howdy", "greetings", "hallo", "ciao", "salut", "bonjour",
  "hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "oi", "ola", "olá", "bom dia", "boa tarde", "boa noite",
  "good morning", "good afternoon", "good evening", "morning", "evening", "gm",
  "there", "madani", "bot", "buddy", "friend", "everyone", "all",
  "thanks", "thank you", "so much", "very much", "a lot", "tudo bem", "thx", "ty", "cheers", "gracias", "obrigado", "obrigada", "merci", "danke",
  "ok", "okay", "k", "kk", "cool", "nice", "great", "awesome", "sure", "yes", "yeah", "yep", "no", "nope", "lol", "haha",
  "how are you", "how are you doing", "how is it going", "how's it going", "hows it going", "what's up", "whats up", "wassup",
  "nice to meet you", "pleased to meet you", "test", "testing", "hmm", "um",
  "안녕", "안녕하세요", "감사합니다", "고마워", "네", "좋아요",
].map(phrase => phrase.split(" ")).sort((a, b) => b.length - a.length);

/** orientation, not work: Madani's follow-up answers these better than a turn would */
const ORIENTATION = /^(?:help|what can you do|what do you do|who are you|what are you|how does this work|what is this|what now|where do i start)$/;

function words(text: string): string[] {
  return text.toLowerCase().normalize("NFKC")
    // oxlint-disable-next-line no-misleading-character-class -- strips zwj and vs16 one code point at a time
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, " ")
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .split(/\s+/).filter(Boolean);
}

/** what is left once leading and trailing small talk is taken off */
function substance(list: string[]): string[] {
  let rest = list;
  for (let changed = true; changed && rest.length;) {
    changed = false;
    for (const phrase of SMALL_TALK) {
      if (phrase.length <= rest.length && phrase.every((word, i) => rest[i] === word)) { rest = rest.slice(phrase.length); changed = true; break; }
      if (phrase.length <= rest.length && phrase.every((word, i) => rest[rest.length - phrase.length + i] === word)) { rest = rest.slice(0, rest.length - phrase.length); changed = true; break; }
    }
  }
  return rest;
}

/** true when the line asks for something actionable: not empty, not emoji, not a greeting or pleasantry, not "help" */
export function isJob(text: string | undefined | null): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  // a command with words after it ("/setup sort my inbox") is work; a bare one ("/help") is not
  if (raw.startsWith("/")) return /^\/[\w-]+\s+\S/.test(raw);
  const rest = substance(words(raw));
  if (!rest.length || ORIENTATION.test(rest.join(" "))) return false;
  // scripts without spaces between words (Korean, Japanese, Chinese) count by characters
  const letters = rest.join("").length;
  return rest.length >= 2 || letters >= 6;
}
