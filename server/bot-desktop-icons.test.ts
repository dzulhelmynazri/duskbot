import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("bot desktop image icons", () => {
  it.skipIf(process.platform === "win32")("keeps installed icons, their link chains, folders and mime types while removing unrelated apps", () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-desktop-icons-"));
    const icons = join(dir, "icons");
    const applications = join(dir, "applications");
    const apps = join(icons, "Papirus", "48x48", "apps");
    const dark = join(icons, "Papirus-Dark", "48x48", "apps");
    const places = join(icons, "Papirus", "48x48", "places");
    const mimetypes = join(icons, "Papirus", "48x48", "mimetypes");
    mkdirSync(apps, { recursive: true });
    mkdirSync(dark, { recursive: true });
    mkdirSync(places, { recursive: true });
    mkdirSync(mimetypes, { recursive: true });
    mkdirSync(applications);
    writeFileSync(join(applications, "custom.desktop"), "[Desktop Entry]\nIcon=org.example.Custom\n");
    writeFileSync(join(apps, "custom-target.svg"), "<svg/>");
    symlinkSync("custom-target.svg", join(apps, "custom-link.svg"));
    symlinkSync("custom-link.svg", join(apps, "org.example.Custom.svg"));
    symlinkSync("../../../Papirus/48x48/apps/org.example.Custom.svg", join(dark, "org.example.Custom.svg"));
    writeFileSync(join(apps, "uninstalled-game.svg"), "<svg/>");
    writeFileSync(join(apps, "chromium.svg"), "<svg/>");
    writeFileSync(join(apps, "archiver.svg"), "<svg/>");
    symlinkSync("../apps/archiver.svg", join(mimetypes, "application-zip.svg"));
    writeFileSync(join(places, "folder.svg"), "<svg/>");
    try {
      execFileSync("python3", ["-I", fileURLToPath(new URL("../deploy/bot-desktop/trim-icons.py", import.meta.url)), icons, applications]);
      expect(existsSync(join(apps, "uninstalled-game.svg"))).toBe(false);
      expect(existsSync(join(dark, "org.example.Custom.svg"))).toBe(true);
      expect(readlinkSync(join(apps, "org.example.Custom.svg"))).toBe("custom-link.svg");
      expect(existsSync(join(apps, "chromium.svg"))).toBe(true);
      expect(existsSync(join(mimetypes, "application-zip.svg"))).toBe(true);
      expect(existsSync(join(places, "folder.svg"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("hides the desktop's pointer: every cursor a toolkit may ask for is one transparent pixel", () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-desktop-cursors-"));
    const adwaita = join(dir, "Adwaita", "cursors");
    const theme = join(dir, "madani-hidden");
    mkdirSync(adwaita, { recursive: true });
    writeFileSync(join(adwaita, "only-in-adwaita"), "");
    try {
      execFileSync("python3", ["-I", fileURLToPath(new URL("../deploy/bot-desktop/blank-cursors.py", import.meta.url)), adwaita, theme]);
      const file = readFileSync(join(theme, "cursors", "default"));
      expect(file.subarray(0, 4).toString("latin1")).toBe("Xcur");
      const images = file.readUInt32LE(12);
      expect(images).toBeGreaterThan(0);
      for (let index = 0; index < images; index++) {
        const at = file.readUInt32LE(16 + index * 12 + 8);
        // width, height and the one ARGB pixel of each image chunk
        expect([file.readUInt32LE(at + 16), file.readUInt32LE(at + 20), file.readUInt32LE(at + 36)]).toEqual([1, 1, 0]);
      }
      for (const name of ["left_ptr", "hand2", "xterm", "pointer", "text", "only-in-adwaita"]) {
        expect(readlinkSync(join(theme, "cursors", name))).toBe("default");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
