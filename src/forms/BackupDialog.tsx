import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Dialog } from "../Dialog";
import {
  BACKUP_CONTENTS,
  backupBlocker,
  backupProgressLine,
  defaultBackupOptions,
  formatBytes,
  formatCount,
  formatElapsed,
  supportsSingleTransaction,
  type BackupContent,
  type BackupOptions,
  type BackupProgress,
  type BackupScope,
  type BackupSummary,
  type QualifiedName,
} from "../backup";

export type BackupTarget = {
  /** Pre-filled from the Explorer node the backup was started from. */
  scope: BackupScope;
  schemas: string[];
  tables: QualifiedName[];
  /** Suggested dump file name (no extension). */
  suggestedName: string;
};

/**
 * Backup configurator + live progress view. Owns only UI state: App performs the
 * save dialog (`onPickPath`) and the command (`onRun`), and the backend streams
 * `backup-progress` events which this dialog subscribes to directly.
 */
export function BackupDialog(props: {
  driverKind: string;
  database: string;
  /** Every schema in the loaded tree with its table names, for the checklists. */
  catalog: { name: string; tables: string[] }[];
  target: BackupTarget;
  onClose: () => void;
  onPickPath: (suggested: string) => Promise<string | null>;
  onRun: (opts: BackupOptions, path: string) => Promise<BackupSummary>;
  onCancel: () => void;
}) {
  const [opts, setOpts] = createSignal<BackupOptions>({
    ...defaultBackupOptions(props.driverKind),
    scope: props.target.scope,
    schemas: props.target.schemas,
    tables: props.target.tables,
  });
  const [path, setPath] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal<BackupProgress | null>(null);
  const [elapsed, setElapsed] = createSignal(0);
  const [done, setDone] = createSignal<BackupSummary | null>(null);
  const [err, setErr] = createSignal("");

  let unlisten: UnlistenFn | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let mounted = true;
  onMount(async () => {
    try {
      const off = await listen<BackupProgress>("backup-progress", (e) => setProgress(e.payload));
      if (mounted) unlisten = off;
      else off();
    } catch {
      /* progress is advisory — a failed subscription must not block the backup */
    }
  });
  onCleanup(() => {
    mounted = false;
    unlisten?.();
    if (timer !== undefined) clearInterval(timer);
  });

  const set = (patch: Partial<BackupOptions>) => setOpts({ ...opts(), ...patch });
  const canWrap = () => supportsSingleTransaction(props.driverKind);
  const hasSchemas = () => props.driverKind !== "sqlite";

  const schemaMatches = createMemo(() => {
    const needle = filter().trim().toLowerCase();
    return props.catalog.filter((s) => !needle || s.name.toLowerCase().includes(needle));
  });
  const tableMatches = createMemo(() => {
    const needle = filter().trim().toLowerCase();
    const out: QualifiedName[] = [];
    for (const s of props.catalog) {
      for (const t of s.tables) {
        const label = `${s.name}.${t}`.toLowerCase();
        if (!needle || label.includes(needle)) out.push({ schema: s.name, name: t });
      }
    }
    return out;
  });

  const schemaChecked = (name: string) => opts().schemas.includes(name);
  const toggleSchema = (name: string, on: boolean) =>
    set({ schemas: on ? [...opts().schemas, name] : opts().schemas.filter((s) => s !== name) });
  const tableChecked = (t: QualifiedName) =>
    opts().tables.some((x) => x.schema === t.schema && x.name === t.name);
  const toggleTable = (t: QualifiedName, on: boolean) =>
    set({
      tables: on
        ? [...opts().tables, t]
        : opts().tables.filter((x) => !(x.schema === t.schema && x.name === t.name)),
    });

  const blocker = () => backupBlocker(opts()) || (path() ? "" : "Choose where to write the dump.");

  async function pick() {
    setErr("");
    try {
      const chosen = await props.onPickPath(props.target.suggestedName);
      if (chosen) setPath(chosen);
    } catch (e) {
      setErr(message(e));
    }
  }

  async function run() {
    const stop = blocker();
    if (stop) {
      setErr(stop);
      return;
    }
    setErr("");
    setDone(null);
    setProgress(null);
    setBusy(true);
    const started = performance.now();
    setElapsed(0);
    timer = setInterval(() => setElapsed(performance.now() - started), 500);
    try {
      setDone(await props.onRun(opts(), path()));
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
      title="Backup"
      size="lg"
      onClose={props.onClose}
      dismissable={!busy()}
      footer={
        <>
          {/* A disabled <button> fires no hover events on WebView2, so its `title` never
              appears. The reason why Back up is unavailable is visible text instead. */}
          <Show when={blocker() && !busy() && !done()}><div class="field-error">{blocker()}</div></Show>
          <Show when={err() && !busy() && !done()}><div class="error">{err()}</div></Show>
          <div class="form-actions">
            <Show
              when={busy()}
              fallback={
                <>
                  <button class="ghost" onClick={props.onClose}>{done() ? "Close" : "Cancel"}</button>
                  <Show when={!done()}>
                    <button class="run" disabled={!!blocker()} onClick={() => void run()}>
                      Back up
                    </button>
                  </Show>
                </>
              }
            >
              <span class="busy-label"><span class="spinner-sm" />Backing up…</span>
              <span class="spacer" />
              <button class="ghost" onClick={() => props.onCancel()}>Cancel backup</button>
            </Show>
          </div>
        </>
      }
    >
      <Show
        when={!busy() && !done()}
        fallback={
          <div class="export-grid">
            <section class="export-sec">
              <div class="export-label">{done() ? "Finished" : "Backing up"}</div>
              <Show
                when={done()}
                fallback={<div class="busy-label"><span class="spinner-sm" />{backupProgressLine(progress())}</div>}
              >
                {(s) => (
                  <div class="export-note">
                    {formatCount(s().tables)} table(s), {formatCount(s().objects)} object(s),{" "}
                    {formatCount(s().rows)} row(s), {formatBytes(s().bytes)} → {s().path}
                  </div>
                )}
              </Show>
              <div class="export-note">Elapsed {formatElapsed(elapsed())}</div>
            </section>
            <Show when={done()?.warnings.length}>
              <section class="export-sec">
                <div class="export-label">Warnings</div>
                <pre class="export-preview">{done()!.warnings.join("\n")}</pre>
              </section>
            </Show>
            <Show when={err()}><div class="error">{err()}</div></Show>
          </div>
        }
      >
        <fieldset class="export-grid export-fieldset">
          <section class="export-sec">
            <div class="export-label">Source</div>
            <div class="export-note">
              {props.driverKind} · {props.database || "(unnamed database)"}
            </div>
          </section>

          <section class="export-sec">
            <div class="export-label">Scope</div>
            <div class="export-row">
              <label>
                Back up
                <select
                  value={opts().scope}
                  onChange={(e) => {
                    set({ scope: e.currentTarget.value as BackupScope });
                    setFilter("");
                  }}
                >
                  <option value="database">Whole database</option>
                  <option value="schemas" disabled={!hasSchemas()}>Selected schemas</option>
                  <option value="tables">Selected tables</option>
                </select>
              </label>
              <Show when={opts().scope !== "database"}>
                <label>
                  Filter
                  <input
                    placeholder="type to narrow…"
                    value={filter()}
                    onInput={(e) => setFilter(e.currentTarget.value)}
                  />
                </label>
              </Show>
            </div>
            <Show when={opts().scope === "schemas"}>
              <div class="export-cols">
                <For each={schemaMatches()}>
                  {(s) => (
                    <div class="export-col">
                      <label class="export-check">
                        <input
                          type="checkbox"
                          checked={schemaChecked(s.name)}
                          onChange={(e) => toggleSchema(s.name, e.currentTarget.checked)}
                        />
                        {s.name}
                      </label>
                      <span class="spacer" />
                      <span class="export-note">{s.tables.length} table(s)</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={opts().scope === "tables"}>
              <div class="export-cols">
                <For each={tableMatches()}>
                  {(t) => (
                    <div class="export-col">
                      <label class="export-check">
                        <input
                          type="checkbox"
                          checked={tableChecked(t)}
                          onChange={(e) => toggleTable(t, e.currentTarget.checked)}
                        />
                        {hasSchemas() ? `${t.schema}.${t.name}` : t.name}
                      </label>
                    </div>
                  )}
                </For>
              </div>
              <div class="export-note">
                Covers the selected tables, their rows, and on PostgreSQL the sequences their{" "}
                <code>serial</code> and identity columns own. Views, other sequences and
                routines need a schema or database backup.
              </div>
            </Show>
          </section>

          <section class="export-sec">
            <div class="export-label">Contents</div>
            <For each={BACKUP_CONTENTS}>
              {(c) => (
                <label class="export-check">
                  <input
                    type="radio"
                    name="backup-content"
                    checked={opts().content === c.value}
                    onChange={() => set({ content: c.value as BackupContent })}
                  />
                  {c.label} <span class="export-note">{c.hint}</span>
                </label>
              )}
            </For>
          </section>

          <section class="export-sec">
            <div class="export-label">Options</div>
            <label class="export-check">
              <input
                type="checkbox"
                checked={opts().includeDrop}
                onChange={(e) => set({ includeDrop: e.currentTarget.checked })}
                disabled={opts().content === "data"}
              />
              Emit DROP … IF EXISTS before each CREATE
            </label>
            <label class="export-check">
              <input
                type="checkbox"
                checked={opts().singleTransaction && canWrap()}
                disabled={!canWrap()}
                onChange={(e) => set({ singleTransaction: e.currentTarget.checked })}
              />
              Wrap the dump in one transaction
              <Show when={!canWrap()}>
                <span class="export-note">Not available on {props.driverKind}.</span>
              </Show>
            </label>
          </section>

          <section class="export-sec">
            <div class="export-label">Destination</div>
            <div class="export-row">
              <button class="ghost export-btn" onClick={() => void pick()}>Choose file…</button>
              <span class="export-note">{path() || "no file chosen"}</span>
            </div>
          </section>
        </fieldset>
      </Show>

    </Dialog>
  );
}

function message(e: unknown): string {
  return e instanceof Object && "message" in e ? String((e as { message: unknown }).message) : String(e);
}
