/** a computer's code: 12 letters and digits, shown XXXX-XXXX-XXXX */
export const CODE_LENGTH = 12;

const clean = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** XXXX-XXXX-XXXX: letters and digits only, uppercase, a dash between groups. */
export function formatCode(input: string): string {
  return clean(input).slice(0, CODE_LENGTH).replace(/(.{4})(?=.)/g, "$1-");
}

/** a computer's 12-character code, or a madani cloud's 8 letters */
export function typedCodeComplete(value: string): boolean {
  const raw = clean(value);
  return raw.length === CODE_LENGTH || (raw.length === 8 && /^[A-Z]+$/.test(raw));
}

/** the place in `value` just after its `count`th letter or digit */
function caretAfter(value: string, count: number): number {
  let at = 0;
  for (let seen = 0; seen < count && at < value.length; at++) if (/[A-Z0-9]/.test(value[at]!)) seen++;
  return at;
}

/**
 * One edit to the code field: what it holds after it and where the caret goes. The dash comes with the first character of
 * the next group; a paste in any form (dashes, spaces, lower case) lands formatted; deleting a dash deletes the character
 * before it, so backspace never stalls on a dash the field would put back.
 */
export function editCode(before: string, typed: string, caret = typed.length): { value: string; caret: number } {
  let raw = clean(typed);
  let kept = Math.min(clean(typed.slice(0, caret)).length, CODE_LENGTH);
  if (raw === clean(before) && typed.length < before.length && kept > 0) {
    raw = raw.slice(0, kept - 1) + raw.slice(kept);
    kept -= 1;
  }
  raw = raw.slice(0, CODE_LENGTH);
  const value = formatCode(raw);
  return { value, caret: kept === raw.length ? value.length : caretAfter(value, kept) };
}

/** the code once all of it is in, else null */
export function fullCode(value: string): string | null {
  const raw = clean(value);
  return raw.length === CODE_LENGTH ? raw : null;
}
