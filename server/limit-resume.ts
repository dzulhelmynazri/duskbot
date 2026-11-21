/** The opening of a held turn's resume note: the limit hold writes it, an engine that kept a cut-off turn's steps reads it. */
export const RESUME_OPENS = "[madani bot: your previous turn here was cut off because ";
export const RESUME_CAUSE = "'s usage limit was reached. The limit has reset.";
/** The same note when a backup AI carries the turn on while the limited one waits. */
export const TAKEOVER_CAUSE = "'s usage limit was reached. You are the backup AI taking it over.";

/** whether a turn's text is a held turn's resume, or a backup's takeover of it */
export function isLimitResume(text: string): boolean {
  const at = text.indexOf(RESUME_OPENS);
  return at >= 0 && (text.indexOf(RESUME_CAUSE, at) > at || text.indexOf(TAKEOVER_CAUSE, at) > at);
}
