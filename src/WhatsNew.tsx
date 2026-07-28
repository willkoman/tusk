import { For, Show, createSignal, onMount, type JSX } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { cmpVersion, notesSince, parseChangelog, type ReleaseNotes } from "./releaseNotes";

// Post-update "What's new" panel, bottom-right on both screens (same corner as
// the update pill). Shows the CHANGELOG sections between the last version this
// profile ran and the current build — bundled at build time (`?raw`), so it's
// exact, offline-safe, and needs no network capability. First launch just
// records the version quietly; the panel appears only after a real update.

const LAST_VERSION_KEY = "tusk.lastVersion";

const readLast = (): string | null => {
  try {
    const raw = localStorage.getItem(LAST_VERSION_KEY);
    return raw && /^\d+\.\d+\.\d+$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
};
const writeLast = (v: string) => {
  try {
    localStorage.setItem(LAST_VERSION_KEY, v);
  } catch {
    /* storage denied — the panel may reappear next launch; harmless */
  }
};

/** Minimal inline markdown for changelog bullets: **bold** and `code`. */
function inline(md: string): JSX.Element {
  const parts: JSX.Element[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) parts.push(md.slice(last, m.index));
    if (m[1] !== undefined) parts.push(<strong>{m[1]}</strong>);
    else parts.push(<code>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < md.length) parts.push(md.slice(last));
  return <>{parts}</>;
}

export function WhatsNew() {
  const [notes, setNotes] = createSignal<ReleaseNotes[]>([]);
  const [open, setOpen] = createSignal(false);
  const [current, setCurrent] = createSignal("");

  onMount(() => {
    // Delayed like the update check — startup work wins the first seconds.
    setTimeout(() => {
      void (async () => {
        let version: string;
        try {
          version = await getVersion();
        } catch {
          return; // no Tauri context (plain vite preview) — nothing to show
        }
        setCurrent(version);
        const last = readLast();
        if (!last) {
          writeLast(version); // fresh install/profile — nothing is "new"
          return;
        }
        if (cmpVersion(version, last) <= 0) {
          if (last !== version) writeLast(version); // downgrade — just resync
          return;
        }
        try {
          const raw = (await import("../CHANGELOG.md?raw")).default;
          const since = notesSince(parseChangelog(raw), last);
          if (!since.length) {
            writeLast(version);
            return;
          }
          setNotes(since);
          setOpen(true);
        } catch {
          writeLast(version); // bundle miss — never block startup over release notes
        }
      })();
    }, 2000);
  });

  const dismiss = () => {
    writeLast(current());
    setNotes([]);
    setOpen(false);
  };

  return (
    <Show when={notes().length > 0}>
      <div class="wn-root">
        <Show when={open()}>
          <div class="upd-panel wn-panel">
            <div class="upd-title">
              What's new in Tusk <span class="upd-ver">{notes()[0].version}</span>
            </div>
            <div class="wn-body">
              <For each={notes()}>
                {(rel, i) => (
                  <div class="wn-release">
                    <Show when={i() > 0}>
                      <div class="wn-relhead">{rel.version}{rel.date ? ` — ${rel.date}` : ""}</div>
                    </Show>
                    <For each={rel.groups}>
                      {(g) => (
                        <div class="wn-group">
                          <div class="wn-grouphead">{g.title}</div>
                          <ul class="wn-list">
                            <For each={g.items}>{(item) => <li>{inline(item)}</li>}</For>
                          </ul>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
            <div class="upd-actions">
              <button class="run" onClick={dismiss}>Got it</button>
            </div>
          </div>
        </Show>
        <button class="upd-pill" title="Changes in this update" onClick={() => setOpen((v) => !v)}>
          ✨ What's new
        </button>
      </div>
    </Show>
  );
}
