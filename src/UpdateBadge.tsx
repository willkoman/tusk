import { createSignal, onMount, Show } from "solid-js";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Built-in updater. Checks the GitHub release manifest (latest.json, signed
// artifacts) shortly after launch; when a newer version exists, a small pill
// appears bottom-right (both the connect screen and the workspace). Clicking
// opens a panel with the release notes and an Install button — download +
// install stream through the updater plugin, then the app relaunches (on
// Windows the NSIS installer exits the app itself). Check failures (offline,
// dev build, no published release) are silent: the updater must never get in
// the way of using the app.

export function UpdateBadge() {
  const [upd, setUpd] = createSignal<Update | null>(null);
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [pct, setPct] = createSignal<number | null>(null);
  const [err, setErr] = createSignal("");

  onMount(() => {
    // Delayed so startup work (connect, schema load) wins the first seconds.
    setTimeout(() => {
      void (async () => {
        try {
          const u = await check();
          if (u) setUpd(u);
        } catch {
          /* offline / dev build / no release yet — stay silent */
        }
      })();
    }, 3000);
  });

  async function install() {
    const u = upd();
    if (!u || busy()) return;
    setBusy(true);
    setErr("");
    setPct(0);
    let total = 0;
    let got = 0;
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total) setPct(Math.min(1, got / total));
        } else if (ev.event === "Finished") setPct(1);
      });
      // Windows: the NSIS installer already exits the app; relaunch covers mac/linux.
      await relaunch();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
      setPct(null);
    }
  }

  return (
    <Show when={upd()}>
      {(u) => (
        <div class="upd-root">
          <Show when={open()}>
            <div class="upd-panel">
              <div class="upd-title">
                Update available <span class="upd-ver">{u().currentVersion} → {u().version}</span>
              </div>
              <Show when={u().body}>
                <div class="upd-notes">{u().body}</div>
              </Show>
              <Show when={err()}>
                <div class="upd-err">{err()}</div>
              </Show>
              <div class="upd-actions">
                <Show
                  when={!busy()}
                  fallback={
                    <div class="upd-progress" title="Downloading update">
                      <div class="upd-bar"><div class="upd-fill" style={{ width: `${Math.round((pct() ?? 0) * 100)}%` }} /></div>
                      <span>{pct() !== null && pct()! >= 1 ? "Installing…" : `${Math.round((pct() ?? 0) * 100)}%`}</span>
                    </div>
                  }
                >
                  <button class="ghost" onClick={() => setOpen(false)}>Later</button>
                  <button class="run" onClick={() => void install()}>Install &amp; restart</button>
                </Show>
              </div>
            </div>
          </Show>
          <button class="upd-pill" title={`Update to ${u().version}`} onClick={() => setOpen((v) => !v)}>
            ⬆ Update {u().version}
          </button>
        </div>
      )}
    </Show>
  );
}
