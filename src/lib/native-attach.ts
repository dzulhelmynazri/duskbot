/** The phone app's own pickers for the composer's + menu, where it has them: each opens straight on its system picker and
 * resolves the chosen files (none when the person cancels). */
export interface NativeAttach {
  photos(): Promise<File[]>;
  files(): Promise<File[]>;
}

let native: NativeAttach | null = null;

export function setNativeAttach(next: NativeAttach | null): void {
  native = next;
}

export function nativeAttach(): NativeAttach | null {
  return native;
}

const ATTACH_FILES_EVENT = "madani:attach-files";

/** Files for the open chat's composer from outside the page's own field (an image pasted into the phone's native one). */
export function attachToComposer(files: File[]): void {
  if (files.length) window.dispatchEvent(new CustomEvent<File[]>(ATTACH_FILES_EVENT, { detail: files }));
}

export function onAttachToComposer(listener: (files: File[]) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<File[]>).detail);
  window.addEventListener(ATTACH_FILES_EVENT, handle);
  return () => window.removeEventListener(ATTACH_FILES_EVENT, handle);
}
