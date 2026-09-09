import { createMemo, createSignal, For, Show } from "solid-js";
import { Dialog } from "../Dialog";
import {
  EXPORT_FORMATS,
  FORMAT_EXT,
  isDelimited,
  rememberableExportOptions,
  tablesExportOptions,
  type ExportOptions,
} from "../export";

export type TableExportResult = {
  schema: string;
  name: string;
  path: string;
  rows: number;
  error: string;
};

export type TableExportProgress = {
  index: number;
  total: number;
  table: string;
  rows: number;
  done: boolean;
};

/**
 * Explorer "Export tables…": pick tables, pick a format, write one configured file per
 * table into a chosen directory. Each file is written atomically; a table that fails is
 * reported without removing the files already written.
 */
export function ExportTablesDialog(props: {
  title: string;
  tables: { schema: string; name: string }[];
  supportsSchemas: boolean;
  /** Pre-checked tables (the schema node checks all of its own). */
  initialSelection?: { schema: string; name: string }[];
  remembered: Record<string, Record<string, unknown>>;
  onRememberOptions: (format: string, values: Record<string, unknown>) => void;
  onPickDirectory: () => Promise<string | null>;
  onRun: (
    tables: { schema: string; name: string }[],
    options: ExportOptions,
    directory: string,
  ) => Promise<TableExportResult[]>;
  onCancelRun: () => void | Promise<void>;
  progress: () => TableExportProgress | null;
  onClose: () => void;
}) {
  // A NUL separator: a schema or table name may contain any character a plainer
  // separator would collide on.
  const key = (t: { schema: string; name: string }) =>
    `${t.schema}\u0000${t.name}`;
  const [selected, setSelected] = createSignal<Set<string>>(
    new Set((props.initialSelection ?? props.tables).map(key)),
  );
  const [opts, setOpts] = createSignal<ExportOptions>(
    tablesExportOptions("csv", props.remembered),
  );
  const [filter, setFilter] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  const [results, setResults] = createSignal<TableExportResult[] | null>(null);

  const set = (patch: Partial<ExportOptions>) => setOpts({ ...opts(), ...patch });
  const visible = createMemo(() => {
    const needle = filter().trim().toLowerCase();
    if (!needle) return props.tables;
    return props.tables.filter(
      (t) => t.name.toLowerCase().includes(needle) || t.schema.toLowerCase().includes(needle),
    );
  });
  const chosen = () => props.tables.filter((t) => selected().has(key(t)));

  const toggle = (t: { schema: string; name: string }) => {
    const next = new Set(selected());
    if (next.has(key(t))) next.delete(key(t));
    else next.add(key(t));
    setSelected(next);
  };

  const pickFormat = (format: ExportOptions["format"]) => {
    setOpts(tablesExportOptions(format, props.remembered));
  };

  async function run() {
    const tables = chosen();
    if (!tables.length) {
      setErr("select at least one table");
      return;
    }
    setErr("");
    const directory = await props.onPickDirectory();
    if (!directory) return;
    setBusy(true);
    setResults(null);
    try {
      props.onRememberOptions(opts().format, rememberableExportOptions(opts()));
      setResults(await props.onRun(tables, opts(), directory));
    } catch (e) {
      setErr(e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));
    } finally {
      setBusy(false);
    }
  }

  const failures = () => (results() ?? []).filter((r) => r.error);

  /** A refused cancel must say so — the button looked dead for up to 2,000 tables. */
  async function cancelRun() {
    try {
      await props.onCancelRun();
    } catch (e) {
      setErr(e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));
    }
  }

  return (
    <Dialog title={props.title} onClose={props.onClose} width={640} dismissable={!busy()}>
      <fieldset class="export-grid export-fieldset" disabled={busy()}>
        <section class="export-sec">
          <div class="export-label">
            Tables ({chosen().length} of {props.tables.length})
            <span class="spacer" />
            <button class="ghost" onClick={() => setSelected(new Set(props.tables.map(key)))}>All</button>
            <button class="ghost" onClick={() => setSelected(new Set())}>None</button>
          </div>
          <input placeholder="Filter…" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
          <div class="export-cols export-tables">
            <For each={visible()}>
              {(t) => (
                <label class="export-check">
                  <input type="checkbox" checked={selected().has(key(t))} onChange={() => toggle(t)} />
                  {props.supportsSchemas ? `${t.schema}.${t.name}` : t.name}
                </label>
              )}
            </For>
          </div>
        </section>

        <section class="export-sec">
          <div class="export-label">Format</div>
          <div class="export-row">
            <select value={opts().format} onChange={(e) => pickFormat(e.currentTarget.value as ExportOptions["format"])}>
              <For each={EXPORT_FORMATS}>{(f) => <option value={f.value}>{f.label}</option>}</For>
            </select>
            <Show when={isDelimited(opts().format)}>
              <label>Delimiter
                <select value={opts().delimiter} onChange={(e) => set({ delimiter: e.currentTarget.value as ExportOptions["delimiter"] })}>
                  <option value="comma">Comma</option>
                  <option value="tab">Tab</option>
                  <option value="semicolon">Semicolon</option>
                  <option value="pipe">Pipe</option>
                </select>
              </label>
              <label>NULL as
                <select value={opts().nullMode} onChange={(e) => set({ nullMode: e.currentTarget.value as ExportOptions["nullMode"] })}>
                  <option value="empty">Empty</option>
                  <option value="literal">NULL</option>
                </select>
              </label>
              <label class="export-check"><input type="checkbox" checked={opts().bom} onChange={(e) => set({ bom: e.currentTarget.checked })} />UTF-8 BOM</label>
            </Show>
            <Show when={opts().format === "sql"}>
              <label class="export-check">
                <input type="checkbox" checked={opts().sql.multiRow} onChange={(e) => setOpts({ ...opts(), sql: { ...opts().sql, multiRow: e.currentTarget.checked } })} />
                Multi-row INSERT
              </label>
            </Show>
            <Show when={isDelimited(opts().format) || opts().format === "xlsx"}>
              <label class="export-check"><input type="checkbox" checked={opts().header} onChange={(e) => set({ header: e.currentTarget.checked })} />Header row</label>
            </Show>
          </div>
          <div class="export-note">
            One <code>.{FORMAT_EXT[opts().format]}</code> file per table, named <code>schema_table</code>, written into a directory you choose next.
          </div>
        </section>

        <Show when={results()}>
          {(rs) => (
            <section class="export-sec">
              <div class="export-label">Result</div>
              <ul class="import-warnings">
                <For each={rs()}>
                  {(r) => (
                    <li classList={{ "import-error": !!r.error }}>
                      {props.supportsSchemas ? `${r.schema}.${r.name}` : r.name}:{" "}
                      {r.error ? r.error : `${r.rows.toLocaleString()} rows → ${r.path}`}
                    </li>
                  )}
                </For>
              </ul>
              <Show when={failures().length}>
                <div class="export-note">
                  Files written before a failure are kept; a cancel stops the run and the
                  remaining tables are reported as skipped.
                </div>
              </Show>
            </section>
          )}
        </Show>
      </fieldset>

      <Show when={err()}><div class="error">{err()}</div></Show>
      <div class="form-actions">
        <Show
          when={busy()}
          fallback={
            <>
              <button class="ghost" onClick={props.onClose}>Close</button>
              <button class="run" onClick={() => void run()}>Export…</button>
            </>
          }
        >
          <span class="busy-label">
            <span class="spinner-sm" />
            Exporting {props.progress()?.index ?? 0}/{props.progress()?.total ?? chosen().length}
            {props.progress()?.table ? ` — ${props.progress()!.table}` : ""}
          </span>
          <span class="spacer" />
          <button class="ghost" onClick={() => void cancelRun()}>Cancel</button>
        </Show>
      </div>
    </Dialog>
  );
}
