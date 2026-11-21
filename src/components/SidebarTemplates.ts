const OPEN_TEMPLATES = "madani:open-templates";
let hosts = 0;
let handoffAt = 0;

/** True once for a Templates opened from another dialog (Connect apps): that dialog's scrim is already up and leaves in
 * the same commit, so Templates takes its place with no scrim or sheet motion instead of a flash of the bare app. */
export function takeTemplatesHandoff(): boolean {
  const fresh = Date.now() - handoffAt < 1_000;
  handoffAt = 0;
  return fresh;
}

/** Marks the next Templates open as taking over from another dialog, for a host that renders it itself. */
export function markTemplatesHandoff(): void {
  handoffAt = Date.now();
}

/** Opens the bot Templates library (TeamLibraryPanel) the sidebar hosts, with its import feedback. False when no
 * sidebar is mounted to host it. */
export function openTemplates(fromDialog = false): boolean {
  if (hosts === 0) return false;
  if (fromDialog) handoffAt = Date.now();
  window.dispatchEvent(new Event(OPEN_TEMPLATES));
  return true;
}

export function onOpenTemplates(open: () => void): () => void {
  hosts++;
  window.addEventListener(OPEN_TEMPLATES, open);
  return () => {
    hosts--;
    window.removeEventListener(OPEN_TEMPLATES, open);
  };
}
