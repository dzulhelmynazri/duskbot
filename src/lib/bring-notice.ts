// The once-only corner card for someone who has other AI tools on this computer and never brought them in: the first
// run's bring step can be skipped, or never shown (madani cloud, an older version), and Settings' import page is quiet.
import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import type { SetupDetection } from "../../shared/setup-import";
import { localFinds, memorySource, type LocalFind } from "./first-run-import";
import { welcomeFinishedThisLaunch } from "./onboarding";
import { usePlaceSwitchQuiet } from "./place-switch";
import { BRING_NOTICE, noticeSeen } from "./notices";
import { detectSetupWithin, localSetupImport, setupImportApi, type SetupImportClient } from "./setup-import";

const LOOK_MS = 4_000;

/** The one source worth a card: the app this person genuinely uses that knows them (memorySource); none otherwise. */
export function bringNoticeFind(detection: SetupDetection | null, now = Date.now()): LocalFind | null {
  return detection ? memorySource(localFinds(null, detection, { now })) : null;
}

/** `fact`: null while looking, then whether the card is due; `find`: the source it is about. */
export function useBringNotice(client: SetupImportClient = setupImportApi): { fact: boolean | null; find: LocalFind | null } {
  const { state } = useStore();
  const record = state.config?.onboarding;
  const switched = usePlaceSwitchQuiet();
  const due = !switched && Boolean(state.config && record?.completedAt) && localSetupImport(state.config?.cloudHome === true)
    && !noticeSeen(record, BRING_NOTICE) && !welcomeFinishedThisLaunch();
  const [find, setFind] = useState<LocalFind | null | undefined>(undefined);
  useEffect(() => {
    if (!due) return;
    const look = detectSetupWithin(client, LOOK_MS);
    void look.found.then((detection) => setFind(bringNoticeFind(detection)));
    return look.cancel;
  }, [due, client]);
  if (!due) return { fact: false, find: null };
  if (find === undefined) return { fact: null, find: null };
  return { fact: find !== null, find };
}
