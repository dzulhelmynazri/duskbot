import type { Message } from "@/state/store";
import { SimpleHelperIntro } from "./SimpleHelperIntro";

interface IntroProps {
  botId: string;
  threadId: string;
  message: Message;
  /** The person wrote after it, or dismissed it: its asks and setup go. */
  answered: boolean;
  /** Its follow-up after the look around (helperFollowup), drawn under it. */
  followup?: Message;
}

/** Madani's first message: a few short bubbles and its follow-up. */
export function HelperIntro(props: IntroProps) {
  return <SimpleHelperIntro {...props} />;
}
