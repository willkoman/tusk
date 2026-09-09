import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Dialog } from "../Dialog";
import {
  defaultRestoreOptions,
  engineMismatch,
  formatBytes,
  formatCount,
  formatElapsed,
  parseBackupHeader,
  restoreProgressLine,
  restoreResultLine,
  supportsSingleTransaction,
  type RestoreOptions,
  type RestoreProgress,
  type RestoreSummary,
} from "../backup";

/** What `read_backup_header` reports about the chosen file. */
export type BackupFileInfo = {
  path: string;
  bytes: number;
  text: string;
  tooLarge: boolean;
  /**
   * A psql meta-command found in the dump's header (a backslash directive such
   * as restrict or connect). Tusk executes SQL, not psql directives, so the
   * replay would stop at that line: say so before the user starts rather than
   * after the first statement fails.
   */
  metaCommand: string | null;
};

/**
 * Restore configurator: file picker, pre-flight summary parsed from the dump header,
 * options, live progress and a result summary carrying the first error.
 */
export function RestoreDialog(props: {
  driverKind: string;
  database: string;
  onClose: () => void;
  onPickFile: () => Promise<BackupFileInfo | null>;
  onRun: (path: string, opts: RestoreOptions) => Promise<RestoreSummary>;
  onCancel: () => void;
}) {
  const [file, setFile] = createSignal<BackupFileInfo | null>(null);
  const [opts, setOpts] = createSignal<RestoreOptions>(defaultRestoreOptions());
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal<RestoreProgress | null>(null);
  const [elapsed, setElapsed] = createSignal(0);
  const [result, setResult] = createSignal<RestoreSummary | null>(null);
  const [err, setErr] = createSignal("");

  let unlisten: UnlistenFn | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let mounted = true;
  onMount(async () => {
    try {
      const off = await listen<RestoreProgress>("restore-progress", (e) => setProgress(e.payload));
      if (mounted) unlisten = off;
      else off();
    } catch {
      /* progress is advisory */
    }
  });
  onCleanup(() => {
    mounted = false;
    unlisten?.();
    if (timer !== undefined) clearInterval(timer);
  });

  const header = createMemo(() => {
    const f = file();
    return f ? parseBackupHeader(f.text) : null;
  });
  const mismatch = () => engineMismatch(header(), props.driverKind);
  const canWrap = () => supportsSingleTransaction(props.driverKind);
  const set = (patch: Partial<RestoreOptions>) => setOpts({ ...opts(), ...patch });

  async function pick() {
    setErr("");
    setResult(null);
    try {
      const chosen = await props.onPickFile();
      if (chosen) setFile(chosen);
    } catch (e) {
      setErr(message(e));
    }
  }

  async function run() {
    const f = file();
    if (!f) {
      setErr("Choose a dump file first.");
      return;
    }
    setErr("");
    setResult(null);
    setProgress(null);
    setBusy(true);
    const started = performance.now();
    setElapsed(0);
    timer = setInterval(() => setElapsed(performance.now() - started), 500);
    try {
      setResult(await props.onRun(f.path, opts()));
    } catch (e) {
      setErr(message(e));
    } finally {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      setElapsed(performance.now() - started);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Restore from file"
      size="lg"
      onClose={props.onClose}
      dismissable={!busy()}
      footer={
        <>
          <Show when={err()}><div class="error">{err()}</div></Show>
          <div class="form-actions">
            <Show
              when={busy()}
              fallback={
                <>
                  <button class="ghost" onClick={props.onClose}>Close</button>
                  <button
                    class="run"
                    disabled={!file() || !!file()?.tooLarge}
                    onClick={() => void run()}
                  >
                    {result() ? "Restore again" : "Restore"}
                  </button>
                </>
              }
            >
              <span class="busy-label"><span class="spinner-sm" />Restoring…</span>
              <span class="spacer" />
              <button class="ghost" onClick={() => props.onCancel()}>Cancel restore</button>
            </Show>
          </div>
        </>
      }
    >
      <Show
        when={!busy()}
        fallback={
          <div class="export-grid">
            <section class="export-sec">
              <div class="export-label">Restoring</div>
              <div class="busy-label"><span class="spinner-sm" />{restoreProgressLine(progress())}</div>
              <div class="export-note">Elapsed {formatElapsed(elapsed())}</div>
            </section>
          </div>
        }
      >
        <fieldset class="export-grid export-fieldset">
          <section class="export-sec">
            <div class="export-label">Target</div>
            <div class="export-note">
              {props.driverKind} · {props.database || "(unnamed database)"}. Statements from the
              file run against this connection.
            </div>
          </section>

          <section class="export-sec">
            <div class="export-label">Dump file</div>
            <div class="export-row">
              <button class="ghost export-btn" onClick={() => void pick()}>Choose file…</button>
              <span class="export-note">{file()?.path || "no file chosen"}</span>
            </div>
            <Show when={file()}>
              {(f) => (
                <div class="export-note">
                  {formatBytes(f().bytes)}
                  <Show when={header()} fallback=" · no Tusk header, replayed as plain SQL">
                    {(h) => ` · ${h().engine || "unknown engine"} · ${h().database || "unknown database"} · ${h().content || "unknown content"}${h().generated ? ` · ${h().generated}` : ""}`}
                  </Show>
                </div>
              )}
            </Show>
            <Show when={file()?.tooLarge}>
              <div class="error">This file is larger than the 2 GiB restore limit.</div>
            </Show>
            <Show when={mismatch()}>
              <div class="error">{mismatch()}</div>
            </Show>
            <Show when={file()?.metaCommand}>
              <div class="error">
                This dump contains the psql command <code>{file()!.metaCommand}</code>, which will
                fail here. Restore the file with <code>psql</code>, or remove the directive first.
              </div>
            </Show>
          </section>

          <section class="export-sec">
            <div class="export-label">Options</div>
            <label class="export-check">
              <input
                type="checkbox"
                checked={opts().stopOnError}
                onChange={(e) =>
                  set({
                    stopOnError: e.currentTarget.checked,
                    // The backend refuses continue-on-error inside one transaction:
                    // the first failure aborts the unit, so the rest is theatre.
                    singleTransaction: e.currentTarget.checked && opts().singleTransaction,
                  })
                }
              />
              Stop at the first error
            </label>
            <label
              class="export-check"
              title={canWrap() ? undefined : "MySQL commits DDL implicitly"}
            >
              <input
                type="checkbox"
                checked={opts().singleTransaction && canWrap()}
                disabled={!canWrap() || !opts().stopOnError}
                onChange={(e) => set({ singleTransaction: e.currentTarget.checked })}
              />
              Run everything in one transaction
              <Show when={!canWrap()}>
                <span class="export-note">Not available on {props.driverKind}.</span>
              </Show>
            </label>
          </section>

          <Show when={result()}>
            {(r) => (
              <section class="export-sec">
                <div class="export-label">Result</div>
                <div class="export-note">{restoreResultLine(r())}</div>
                <Show when={r().firstError}>
                  {(e) => (
                    <pre class="export-preview">
                      {`statement ${formatCount(e().statementIndex)} (line ${formatCount(e().line)})\n${e().preview}\n\n${e().message}`}
                    </pre>
                  )}
                </Show>
              </section>
            )}
          </Show>
        </fieldset>
      </Show>
    </Dialog>
  );
}

function message(e: unknown): string {
  return e instanceof Object && "message" in e ? String((e as { message: unknown }).message) : String(e);
}
