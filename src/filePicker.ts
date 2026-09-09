import { save, open as openDialog } from "@tauri-apps/plugin-dialog";

/**
 * Guarded wrappers around the native file pickers.
 *
 * A smoke run on Windows 11 / WebView2 152 found `save()` resolving to a default path in
 * the user's Downloads folder without any picker window ever appearing — so Save wrote a
 * file the user never chose. Nothing in Tusk fabricates that path (the capability grants
 * `dialog:allow-save`/`allow-open`, the plugin is registered, and every call site already
 * treats `null` as cancel), which makes it a host-side failure of the dialog itself. That
 * is exactly the class of failure a client must not trust silently: a destination has to
 * come from the user's choice, or from a path they already own.
 *
 * Two checks, both cheap:
 *  - the result must LOOK like a real chosen file (absolute, with a file name);
 *  - the native picker must have taken focus away from the web view while it was open.
 *    A picker that is never shown never blurs the document, so a result that arrives
 *    with focus unbroken is "unverified" and the caller confirms it instead of writing.
 *
 * Unverified is deliberately not an error: on a healthy machine it should never fire, and
 * if some platform ever fails to blur, the user gets one extra confirmation showing the
 * path they just picked — never a silent write to somewhere they did not choose.
 */

export type PickedPath = {
  /** The chosen path, or null for cancel / an unusable result. */
  path: string | null;
  /** The picker demonstrably appeared (it took focus). False ⇒ confirm before using. */
  verified: boolean;
};

/**
 * A picker result usable as a destination: a non-empty ABSOLUTE path that names a file.
 * A relative or bare name means the dialog never resolved a real choice, and a trailing
 * separator means a directory — neither may be written to.
 */
export function acceptPickedPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path) return null;
  const absolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
  if (!absolute) return null;
  const base = path.split(/[\\/]/).pop() ?? "";
  return base ? path : null;
}

/** Pure verdict for one picker call: what the dialog returned, plus whether it was shown. */
export function judgePicker(raw: unknown, sawBlur: boolean): PickedPath {
  const path = acceptPickedPath(raw);
  return { path, verified: !!path && sawBlur };
}

const focused = () => typeof document !== "undefined" && typeof document.hasFocus === "function" && document.hasFocus();

/**
 * Run a picker call while watching for the web view losing focus. Sampling rather than a
 * `blur` listener: a native dialog can come and go between frames, and a listener added
 * after the window already lost focus would miss it entirely.
 */
async function watchFocus<T>(run: () => Promise<T>): Promise<{ value: T; sawBlur: boolean }> {
  let sawBlur = !focused();
  const onBlur = () => (sawBlur = true);
  if (typeof window !== "undefined") window.addEventListener("blur", onBlur);
  const timer = setInterval(() => {
    if (!focused()) sawBlur = true;
  }, 50);
  try {
    const value = await run();
    return { value, sawBlur: sawBlur || !focused() };
  } finally {
    clearInterval(timer);
    if (typeof window !== "undefined") window.removeEventListener("blur", onBlur);
  }
}

export type PickerOptions = {
  defaultPath?: string;
  /** Dialog window title, where the platform shows one. */
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  /** Open a folder rather than a file (export-to-directory). */
  directory?: boolean;
};

/** Native "save as" picker, guarded. */
export async function pickSavePath(options: PickerOptions): Promise<PickedPath> {
  const { value, sawBlur } = await watchFocus(() => save(options));
  return judgePicker(value, sawBlur);
}

/** Message for a caller that has a status line rather than a confirmation dialog. */
export const UNVERIFIED_PICKER =
  "The file picker did not open, so nothing was chosen. Try again, or check whether another window is blocking it.";

/** Native "open" picker, guarded (single selection; file or, with `directory`, folder). */
export async function pickOpenPath(options: PickerOptions): Promise<PickedPath> {
  const { value, sawBlur } = await watchFocus(() => openDialog({ multiple: false, ...options }));
  return judgePicker(value, sawBlur);
}
