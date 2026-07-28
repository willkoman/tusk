import { For, Show, createEffect, createSignal, onMount, type Accessor, type JSX } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { cmpVersion, notesSince, parseChangelog, type ReleaseNotes } from "./releaseNotes";

// Post-update "What's new" panel, bottom-right on both screens (same corner as
// the update pill). Shows the CHANGELOG sections between the last version this
// profile ran and the current build — bundled at build time (`?raw`), so it's
// exact, offline-safe, and needs no network capability. A brand-new profile
// records the version quietly; a profile that clearly existed before the
// version marker did (pre-0.9.1 installs have prefs/tabs but no marker) gets
// the CURRENT version's notes — an update happened, we just can't tell from
// what. The panel can also be summoned on demand (command palette) via
// `requestShow`.

const LAST_VERSION_KEY = "tusk.lastVersion";

/** Evidence this profile ran Tusk before the version marker existed. */
function hasPriorProfile(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("tusk.") && key !== LAST_VERSION_KEY) return true;
    }
  } catch {
    /* storage denied — treat as fresh */
  }
  return false;
}

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

export function WhatsNew(props: { requestShow?: Accessor<number> }) {
  const [notes, setNotes] = createSignal<ReleaseNotes[]>([]);
  const [open, setOpen] = createSignal(false);
  const [current, setCurrent] = createSignal("");

  const loadNotes = async (version: string, last: string | null): Promise<ReleaseNotes[]> => {
    const raw = (await import("../CHANGELOG.md?raw")).default;
    const all = parseChangelog(raw);
    // Unknown starting point (pre-marker install, or explicit request): show
    // just the running version's section rather than guessing a range.
    if (!last) return all.filter((r) => r.version === version).slice(0, 1);
    return notesSince(all, last);
  };

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
        if (!last && !hasPriorProfile()) {
          writeLast(version); // genuinely fresh install — nothing is "new"
          return;
        }
        if (last && cmpVersion(version, last) <= 0) {
          if (last !== version) writeLast(version); // downgrade — just resync
          return;
        }
        try {
          const since = await loadNotes(version, last);
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

  // On-demand (command palette): show the running version's notes regardless of
  // the last-seen marker. Never writes the marker — viewing isn't dismissing.
  let lastRequest = 0;
  createEffect(() => {
    const req = props.requestShow?.();
    if (!req || req === lastRequest) return;
    lastRequest = req;
    void (async () => {
      try {
        const version = current() || (await getVersion());
        setCurrent(version);
        const shown = await loadNotes(version, null);
        if (shown.length) {
          setNotes(shown);
          setOpen(true);
        }
      } catch {
        /* no Tauri context or bundle miss — nothing to show */
      }
    })();
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
