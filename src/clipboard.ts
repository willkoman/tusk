// Clipboard helpers. Uses the WebView's async clipboard API (works in Tauri's
// secure context; reads happen inside a right-click user gesture). Returns a
// success flag / null so callers can degrade gracefully.

export async function clipWrite(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function clipRead(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
