import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { teamImportPreview } from "@/lib/team-import";
import { presetShareBody, SharePresetContents, type PresetShareResponse } from "./SharePresetDialog";
import { TeamImportDetails } from "./TeamLibraryPanel";
import { packageSummary, parsePackageDocument } from "../../shared/package-format";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", name), "utf8"));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("share as preset", () => {
  it("asks for a preset file of the New bot defaults, named once, with notes and picture as chosen", () => {
    expect(presetShareBody({ name: " Support agent ", description: "", release: "", notes: "", includeNotes: true, dryRun: true })).toEqual({
      format: "package", version: 2, kind: "library", name: "Support agent", presetName: "Support agent",
      presetDescription: undefined, release: undefined, notes: undefined, includeMemory: true, dryRun: true,
    });
    expect(presetShareBody({ name: "Sky", includeNotes: false, picture: "data:image/png;base64,AAAA" })).toMatchObject({ includeMemory: false, presetAvatar: "data:image/png;base64,AAAA" });
  });

  it("shows what the preset file holds, what never travels, and what was removed or left out", () => {
    const document = parsePackageDocument(fixture("library-only.v2.json"));
    const preview: PresetShareResponse = {
      document, filename: "sales-skills-2.0.1.madani.json", summary: packageSummary(document),
      redacted: ["presets[support].bot.soul"], skipped: [{ part: "presets[support].skills[follow-up]", reason: "preset_skill_conflict" }],
    };
    const words = text(renderToStaticMarkup(createElement(SharePresetContents, { preview, localSkips: [] })));
    for (const line of [
      "Skills · arrive switched off 1 · objection-handling", "Starter notes None", "Pictures None",
      "Never included: model choices, folders, where bots work, approval levels, connected apps, MCP servers and routines.",
      "Removed what looked like a key or password from: Support agent · Standing instructions",
      "Support agent · Skill · follow-up (a bot in the section has a different skill with this name)",
    ]) expect(words).toContain(line);
  });

  it("previews a preset file's import as preset bots for New bot, with no team members", () => {
    const words = text(renderToStaticMarkup(createElement(TeamImportDetails, { pending: teamImportPreview(fixture("library-only.v2.json")), importedNames: [] })));
    expect(words).toContain("Preset bots: 1 · appear in new bot");
    expect(words).toContain("Preset bots (added to new bot) Support agent");
    expect(words).not.toContain("0 playbooks");
    expect(words).toContain("Offered skills (not added to any bot) follow-up");
    expect(words).toContain("The preset bots appear in new bot, above the built-in roles.");
    expect(words).not.toContain("Team members");
    expect(words).not.toContain("Group chats");
    expect(text(renderToStaticMarkup(createElement(TeamImportDetails, { pending: teamImportPreview(fixture("full-team.v2.json")), importedNames: ["Morgan", "Scout", "Quill"] }))))
      .toContain("Preset bots: 1 · appear in new bot");
  });
});
