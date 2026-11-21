/** Asks the sidebar for its new group chat flow, from anywhere (Create New Bot's "Start a group chat instead"). */
export const NEW_GROUP_EVENT = "madani:open-new-group";

export function openNewGroup(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NEW_GROUP_EVENT));
}
