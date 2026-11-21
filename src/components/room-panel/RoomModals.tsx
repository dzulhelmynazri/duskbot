import { useState } from "react";
import { AnimatePresence } from "motion/react";

import { effectiveDefaultResponder } from "@/lib/group-routing";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { normalizeState } from "@/lib/mascot";
import { chosenResponder, responderChoice, responderLeadId, type ResponderChoice } from "@/lib/room-responder";
import { shortPath } from "@/lib/short-path";
import { api, useStore, type Bot, type Group, type GroupDefaultResponder } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { FolderPathDialog } from "../bot-panel/modals/FolderModal";
import { InstructionsCard } from "../bot-panel/modals/InstructionsModal";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { Card, CheckRow, FormDialog, FormField, NavRow, NoteRow, SheetPane } from "../ListRows";
import { RadioRow, radioArrows } from "../bot-panel/rows";
import { JevSetup } from "./JevSetup";
import { textFieldCls } from "../ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";

export type RoomDialog = "responder" | "folder" | "instructions" | "about";

// unsaved instructions per room, kept until saved or the app reloads, as the bot's are
const drafts = new Map<string, string>();

/** The room's instructions in the bot Instructions card: a draft until Save, kept for the session when it closes. */
export function RoomInstructionsModal({ group }: { group: Group; onClose: () => void }) {
  const { dispatch } = useStore();
  const saved = group.bulletin;
  const [draft, setDraftState] = useState(() => drafts.get(group.id) ?? saved);
  const [justSaved, setJustSaved] = useState(false);
  const canSave = draft !== saved;

  const setDraft = (value: string) => {
    if (value === saved) drafts.delete(group.id);
    else drafts.set(group.id, value);
    setDraftState(value);
    setJustSaved(false);
  };
  const save = () => {
    if (!canSave) return;
    dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: draft } });
    drafts.delete(group.id);
    setJustSaved(true);
  };

  return (
    <SheetPane data-panel-modal="instructions" title={t("room.panel.instructions")}>
      <InstructionsCard
        label={t("room.panel.instructionsHint")}
        placeholder={t("botPanel.ui.roomBulletinPlaceholder")}
        dir="auto"
        value={draft}
        onChange={setDraft}
        onSave={save}
        canSave={canSave}
        saved={justSaved && !canSave}
      />
    </SheetPane>
  );
}

/** Where every bot in the room runs its shell and file tools, as the bot's Working folder page. The server checks the
 * path, so a folder is saved straight to it and only lands here once accepted. */
export function RoomFolderModal({ group }: { group: Group; onClose: () => void }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host?.homeDir;
  const canPick = typeof window !== "undefined" && Boolean(window.madaniDesktop?.pickFolder);
  const locked = group.pinnedCwd !== undefined;
  const cwd = locked ? group.pinnedCwd ?? undefined : group.cwd;
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (next: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ cwd: next }) });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const path = await window.madaniDesktop?.pickFolder?.(group.cwd);
    if (path) void save(path);
  };

  return (
    <SheetPane data-panel-modal="folder" title={t("room.folder.title")}>
      <Card data-sheet-group="folder" footnote={locked ? <span data-folder-locked>{t("room.folder.lockedChat")}</span> : undefined}>
        <div role="radiogroup" aria-label={t("room.folder.title")} className="contents">
          <CheckRow
            role="radio"
            data-panel-choice="own"
            title={t("room.folder.own")}
            hint={t("room.panel.folder.ownHint")}
            checked={!cwd}
            disabled={saving || locked}
            onClick={() => { if (group.cwd) void save(null); }}
          />
          <CheckRow
            role="radio"
            data-panel-choice="pick"
            title={t("room.panel.folder.pick")}
            hint={cwd ? <span title={cwd}>{shortPath(cwd, home)}</span> : t("botPanel.folder.pickHint")}
            checked={Boolean(cwd)}
            disabled={saving || locked}
            onClick={() => (canPick ? void pick() : setTyping(true))}
          />
        </div>
        {error && !typing && <NoteRow tone="warn">{error}</NoteRow>}
      </Card>
      <AnimatePresence>{typing && <FolderPathDialog key="folder-path-dialog" title={t("room.folder.title")} initial={group.cwd ?? ""} saving={saving} error={error} onSave={save} onClose={() => setTyping(false)} />}</AnimatePresence>
    </SheetPane>
  );
}

/** Who answers a message that @mentions nobody: a leader who hands out the work, everyone, Madani deciding or Jev
 * deciding (with Jev set up right under it). A leader picks who leads in the rows under it; arrow keys move between rows. */
export function RoomResponderModal({ group, members }: { group: Group; members: Bot[]; onClose: () => void }) {
  const { dispatch } = useStore();
  const responder = effectiveDefaultResponder(group, members);
  const current = responderChoice(responder);
  const leading = current.startsWith("leader:") || current.startsWith("member:");
  const leadId = responderLeadId(responder) ?? members[0]?.id;
  const lead = members.find((member) => member.id === leadId) ?? members[0];
  const set = (next: GroupDefaultResponder) => dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: next } });
  const choose = (choice: ResponderChoice | "leader") => {
    const next: ResponderChoice = choice === "leader" ? `leader:${leadId ?? ""}` : choice;
    // a room from before leaders becomes a led room when its one bot is picked again
    if (next === current) return;
    set(chosenResponder(next, responder));
  };
  const behaviours: { choice: "everyone" | "madani" | "auto" | "mentions"; title: LocaleKey; hint: LocaleKey }[] = [
    { choice: "everyone", title: "room.panel.responder.everyone", hint: "room.panel.responder.everyoneHint" },
    { choice: "madani", title: "room.panel.responder.madani", hint: "room.panel.responder.madaniHint" },
    { choice: "auto", title: "room.panel.responder.jev", hint: "room.panel.responder.autoHint" },
    // only who is @mentioned stays for rooms already set that way
    ...(current === "mentions" ? [{ choice: "mentions" as const, title: "room.panel.responder.mentions" as LocaleKey, hint: "room.panel.responder.mentionsHint" as LocaleKey }] : []),
  ];
  const row = (choice: ResponderChoice | "leader", checked: boolean, props: Omit<Parameters<typeof RadioRow>[0], "checked" | "onClick">) => (
    <RadioRow key={choice} {...props} data-panel-choice={choice} checked={checked} tabIndex={checked ? 0 : -1} onClick={() => choose(choice)} />
  );
  return (
    <SheetPane data-panel-modal="responder" title={t("room.panel.whoResponds")}>
      <div role="radiogroup" aria-label={t("room.panel.whoResponds")} onKeyDown={radioArrows} className="contents">
        <Card data-sheet-group="behaviours" footnote={t("room.panel.responder.mentionsWin")}>
          {lead && row("leader", leading, {
            title: t("room.panel.responder.leader"),
            hint: t("room.panel.responder.leaderHint", { name: lead.name }),
          })}
          {behaviours.map(({ choice, title, hint }) => row(choice, current === choice, { title: t(title), hint: t(hint) }))}
        </Card>
      </div>
      {leading && members.length > 1 && (
        <div role="radiogroup" aria-label={t("room.panel.responder.whoLeads")} onKeyDown={radioArrows} className="contents">
          <Card data-sheet-group="members" label={t("room.panel.responder.whoLeads")}>
            {members.map((member) => row(`leader:${member.id}`, member.id === leadId, {
              title: member.name,
              leading: <BotAvatar bot={member} state={normalizeState(member.mascotExpression) ?? "happy"} size={20} animated={false} />,
            }))}
          </Card>
        </div>
      )}
      {current === "auto" && <JevSetup />}
    </SheetPane>
  );
}

/** The room's name and short description as rows, edited together in one small form. */
export function RoomAboutModal({ group }: { group: Group; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <SheetPane data-panel-modal="about" title={t("room.panel.about")}>
      <Card data-sheet-group="about">
        <NavRow data-sheet-row="name" title={t("botPanel.ui.botSettingsSimpleName")} value={group.name} onClick={() => setEditing(true)} />
        <NavRow data-sheet-row="description" title={t("botPanel.ui.presetShareDescription")} value={group.description || t("room.panel.descriptionHint")} onClick={() => setEditing(true)} />
      </Card>
      <AnimatePresence>{editing && <RoomAboutDialog key="room-about-dialog" group={group} onClose={() => setEditing(false)} />}</AnimatePresence>
    </SheetPane>
  );
}

function RoomAboutDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const { dispatch } = useStore();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const trimmed = { name: name.trim(), description: description.trim() };
  const changed = trimmed.name !== group.name || trimmed.description !== (group.description ?? "");
  return (
    <FormDialog
      data-panel-modal="room-about-form"
      title={t("room.panel.about")}
      canSave={Boolean(trimmed.name) && changed}
      onSave={() => {
        dispatch({ type: "patchGroup", groupId: group.id, patch: trimmed });
        onClose();
      }}
      onClose={onClose}
    >
      <FormField label={t("botPanel.ui.botSettingsSimpleName")}>
        <input data-autofocus dir="auto" value={name} onChange={(event) => setName(event.target.value)} className={textFieldCls} />
      </FormField>
      <FormField label={t("botPanel.ui.presetShareDescription")}>
        <input dir="auto" value={description} placeholder={t("room.panel.descriptionHint")} onChange={(event) => setDescription(event.target.value)} className={textFieldCls} />
      </FormField>
    </FormDialog>
  );
}
