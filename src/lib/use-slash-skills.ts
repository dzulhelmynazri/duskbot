import { useEffect, useState } from "react";
import { api } from "@/state/store";
import type { SlashSkill } from "./composer-commands";

interface SkillsResponse {
  skills?: Array<{ name?: unknown; description?: unknown; enabled?: unknown; origin?: unknown }>;
}

/** Skills that live in another AI tool's folder: the engine's own (`native`) and copies brought in from those tools
 * (`imported`). Everything else was made or added in madani bot. */
const FROM_TOOLS = new Set(["native", "imported"]);

export function enabledSlashSkills(body: SkillsResponse | null | undefined): SlashSkill[] {
  return (body?.skills ?? []).flatMap((skill) => {
    if (skill.enabled !== true || typeof skill.name !== "string") return [];
    // an older copy can still hold a block scalar's marker (">-") as its words: it reads as nothing rather than a symbol
    const description = typeof skill.description === "string" && !/^[>|][+-]?\d?[+-]?$/.test(skill.description.trim()) ? skill.description : "";
    return [{ name: skill.name, description, ...(typeof skill.origin === "string" && FROM_TOOLS.has(skill.origin) ? { fromTools: true as const } : {}) }];
  });
}

export function useSlashSkills(botId: string | undefined, threadId: string, active: boolean): SlashSkill[] {
  const [skills, setSkills] = useState<{ botId: string; list: SlashSkill[] } | null>(null);
  useEffect(() => {
    if (!botId || !active) return;
    let cancelled = false;
    api(`/api/bots/${botId}/skills?threadId=${encodeURIComponent(threadId)}`)
      .then((body) => { if (!cancelled) setSkills({ botId, list: enabledSlashSkills(body as SkillsResponse) }); })
      .catch(() => { if (!cancelled) setSkills({ botId, list: [] }); });
    return () => {
      cancelled = true;
      setSkills(null);
    };
  }, [botId, threadId, active]);
  return active && skills && skills.botId === botId ? skills.list : [];
}
