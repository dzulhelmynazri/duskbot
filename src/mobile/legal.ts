/** The pages the phone app links to from its sign-in screen and Settings. None of them sells anything. */
export const LEGAL_LINKS = {
  privacy: "https://madani.bot/privacy",
  terms: "https://madani.bot/terms",
  help: "https://madani.bot/support",
} as const;

/** where a person reaches a human, and where a reported reply goes (App Store guideline 1.2: published contact) */
export const SUPPORT_EMAIL = "hello@madani.bot";

export function supportMail(subject: string, body?: string): string {
  const query = new URLSearchParams({ subject, ...(body ? { body } : {}) }).toString().replace(/\+/g, "%20");
  return `mailto:${SUPPORT_EMAIL}?${query}`;
}
