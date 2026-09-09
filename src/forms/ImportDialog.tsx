import { createMemo, createSignal, For, Show } from "solid-js";
import { Dialog } from "../Dialog";
import {
  autoMatch,
  buildTarget,
  conflictLabel,
  defaultImportOptions,
  existingTableMapping,
  formatForFile,
  IMPORT_COLUMN_TYPES,
  inferTypes,
  mappingIssues,
  newTableMapping,
  runOptions,
  sqlTypeFor,
  tableNameFromFile,
  type ConflictMode,
  type ImportColumnMapping,
  type ImportColumnType,
  type ImportOptions,
  type ImportPreview,
  type ImportProgress,
  type ImportSummary,
  type ImportTarget,
} from "../import";

type Step = "source" | "mapping" | "run";
type Mode = "existing" | "new";

const SKIP = "-";
/** Columns rendered in the preview grid. The mapping table still lists every one. */
const PREVIEW_COLUMNS = 60;
/** Rows rendered in the preview grid. The backend parses more (import.rs PREVIEW_ROWS). */
const PREVIEW_ROWS_SHOWN = 20;

/**
 * Multi-step file import: choose a file and parsing options, review the parsed preview,
 * map file columns onto target columns, then watch the load run. Nothing touches the
 * database until the final step; the preview is parsed by the backend with no connection.
 */
export function ImportDialog(props: {
  /** Backend kind — drives the conflict wording and the previewed CREATE types. */
  dialect: string;
  /** Whether the engine has schemas at all (SQLite does not). */
  supportsSchemas: boolean;
  schemas: string[];
  tables: { schema: string; name: string }[];
  defaultSchema: string;
  /** Pre-selected target from the Explorer's "Import data into table…". */
  initialTarget?: { schema: string; name: string } | null;
  onPickFile: () => Promise<string | null>;
  onPreview: (path: string, options: ImportOptions) => Promise<ImportPreview>;
  onTargetColumns: (
    schema: string,
    table: string,
  ) => Promise<{ name: string; data_type: string }[]>;
  onRun: (path: string, options: ImportOptions, target: ImportTarget) => Promise<ImportSummary>;
  onCancelRun: () => void | Promise<void>;
  /** Live `import-progress` payload, or null when nothing is running. */
  progress: () => ImportProgress | null;
  onClose: () => void;
}) {
  const [step, setStep] = createSignal<Step>("source");
  const [path, setPath] = createSignal("");
  const [options, setOptions] = createSignal<ImportOptions>(defaultImportOptions());
  const [preview, setPreview] = createSignal<ImportPreview | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  const [summary, setSummary] = createSignal<ImportSummary | null>(null);

  // An Explorer schema node passes its schema with no table: that means "new table HERE",
  // not "pick an existing one".
  const [mode, setMode] = createSignal<Mode>(props.initialTarget?.name ? "existing" : "new");
  const [schema, setSchema] = createSignal(props.initialTarget?.schema ?? props.defaultSchema);
  const [table, setTable] = createSignal(props.initialTarget?.name ?? "");
  const [truncate, setTruncate] = createSignal(false);
  const [conflict, setConflict] = createSignal<ConflictMode>("error");
  const [keyColumns, setKeyColumns] = createSignal<string[]>([]);
  const [mapping, setMapping] = createSignal<ImportColumnMapping[]>([]);

  const set = (patch: Partial<ImportOptions>) => setOptions({ ...options(), ...patch });
  const fileName = () => path().replace(/^.*[\\/]/, "");
  const delimited = () => options().format === "csv";

  const issues = createMemo(() =>
    mappingIssues(mapping(), { table: table(), conflict: conflict(), keyColumns: keyColumns() }, props.dialect),
  );
  const blocking = () => issues().filter((i) => i.level === "error");

  async function pickFile() {
    setErr("");
    const picked = await props.onPickFile();
    if (!picked) return;
    setPath(picked);
    const name = picked.replace(/^.*[\\/]/, "");
    const detected = formatForFile(name);
    setOptions({ ...options(), ...detected, sheet: "" });
    if (mode() === "new" && !table()) setTable(tableNameFromFile(name));
    await reparse(picked);
  }

  // Every option change fires a preview; two in-flight parses can resolve in either
  // order, so a stale one must never overwrite the preview OR the mapping derived
  // from it.
  let previewGeneration = 0;

  async function reparse(target = path()) {
    if (!target) return;
    const generation = ++previewGeneration;
    const current = () => generation === previewGeneration;
    setBusy(true);
    setErr("");
    try {
      const p = await props.onPreview(target, { ...options(), sourceColumns: [] });
      if (!current()) return;
      setPreview(p);
      // A new target table mirrors the file; an existing one keeps its own columns.
      if (mode() === "new") setMapping(newTableMapping(p.columns, inferTypes(p.columns, p.rows)));
      else if (table()) await loadTargetColumns(p, current);
    } catch (e) {
      if (!current()) return;
      setPreview(null);
      setErr(message(e));
    } finally {
      if (current()) setBusy(false);
    }
  }

  async function loadTargetColumns(p = preview(), current: () => boolean = () => true) {
    if (!p || !table()) return;
    try {
      const columns = await props.onTargetColumns(schema(), table());
      if (!current()) return;
      setMapping(existingTableMapping(p.columns, columns));
    } catch (e) {
      if (!current()) return;
      setErr(message(e));
      setMapping([]);
    }
  }

  async function pickMode(next: Mode) {
    setMode(next);
    setConflict("error");
    setKeyColumns([]);
    const p = preview();
    if (!p) return;
    if (next === "new") {
      if (!table()) setTable(tableNameFromFile(fileName()));
      setMapping(newTableMapping(p.columns, inferTypes(p.columns, p.rows)));
    } else {
      setTable(props.initialTarget?.name ?? "");
      setMapping([]);
    }
  }

  /** Table picks travel by index — a schema or table name may contain anything. */
  async function pickTable(index: number) {
    const picked = props.tables[index];
    if (!picked) {
      setTable("");
      setMapping([]);
      return;
    }
    setSchema(picked.schema);
    setTable(picked.name);
    setKeyColumns([]);
    await loadTargetColumns();
  }

  /** Entering the mapping step: derive a mapping only when there isn't one yet, so
   *  going Back and Next again doesn't discard hand-made choices. */
  async function enterMapping() {
    if (!mapping().length) await pickMode(mode());
    setStep("mapping");
  }

  const setRow = (index: number, patch: Partial<ImportColumnMapping>) =>
    setMapping(mapping().map((m, k) => (k === index ? { ...m, ...patch } : m)));

  function autoMatchAll() {
    const p = preview();
    if (!p) return;
    const matched = autoMatch(p.columns, mapping().map((m) => m.target));
    setMapping(mapping().map((m, k) => ({ ...m, source: matched[k] })));
  }

  async function run() {
    const p = preview();
    if (!p || blocking().length) return;
    setStep("run");
    setBusy(true);
    setErr("");
    setSummary(null);
    try {
      const result = await props.onRun(
        path(),
        runOptions(options(), p.columns),
        buildTarget(mapping(), {
          schema: props.supportsSchemas ? schema() : "",
          table: table(),
          create: mode() === "new",
          truncate: truncate(),
          conflict: conflict(),
          keyColumns: keyColumns(),
        }),
      );
      setSummary(result);
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  /** The preview grid is bounded; a 10,000-column file must not render 10,000 `<th>`. */
  const previewColumns = (p: ImportPreview) => p.columns.slice(0, PREVIEW_COLUMNS);

  const percent = () => {
    const p = props.progress();
    if (!p || !p.totalBytes) return 0;
    return Math.min(100, Math.round((p.bytesRead / p.totalBytes) * 100));
  };

  // Three wizard steps each own their action row, so the footer stays in the body.
  return (
    <Dialog title="Import data" size="lg" onClose={props.onClose} dismissable={!busy()}>
      <div class="import-steps">
        <For each={["source", "mapping", "run"] as Step[]}>
          {(s, i) => (
            <span class="import-step" classList={{ active: step() === s }}>
              {i() + 1}. {s === "source" ? "File" : s === "mapping" ? "Columns" : "Run"}
            </span>
          )}
        </For>
      </div>

      <Show when={step() === "source"}>
        <fieldset class="export-grid export-fieldset" disabled={busy()}>
          <section class="export-sec">
            <div class="export-label">Source file</div>
            <div class="export-row">
              <button class="ghost" onClick={() => void pickFile()}>Choose file…</button>
              <span class="import-file">{fileName() || "no file selected"}</span>
            </div>
          </section>

          <Show when={path()}>
            <section class="export-sec">
              <div class="export-label">Parsing</div>
              <div class="export-row">
                <label>Format
                  <select value={options().format} onChange={(e) => { set({ format: e.currentTarget.value as ImportOptions["format"] }); void reparse(); }}>
                    <option value="csv">Delimited text</option>
                    <option value="json">JSON / NDJSON</option>
                    <option value="xlsx">Excel (xlsx)</option>
                  </select>
                </label>
                <Show when={delimited()}>
                  <label>Delimiter
                    <select value={options().delimiter} onChange={(e) => { set({ delimiter: e.currentTarget.value as ImportOptions["delimiter"] }); void reparse(); }}>
                      <option value="comma">Comma</option>
                      <option value="tab">Tab</option>
                      <option value="semicolon">Semicolon</option>
                      <option value="pipe">Pipe</option>
                      <option value="custom">Custom…</option>
                    </select>
                  </label>
                  <Show when={options().delimiter === "custom"}>
                    <label>Char
                      <input class="export-narrow" maxLength={1} value={options().customDelimiter}
                        onChange={(e) => { set({ customDelimiter: e.currentTarget.value }); void reparse(); }} />
                    </label>
                  </Show>
                  <label title="Blank turns quoting off entirely — every delimiter and quote byte is literal field content.">Quote
                    <input class="export-narrow" maxLength={1} placeholder="none" value={options().quoteChar}
                      onChange={(e) => { set({ quoteChar: e.currentTarget.value }); void reparse(); }} />
                  </label>
                  <label title="Backslash-style escape inside a quoted field. Blank uses RFC 4180 doubled quotes; it must differ from both the quote character and the delimiter.">Escape
                    <input class="export-narrow" maxLength={1} placeholder="none" value={options().escapeChar}
                      onChange={(e) => { set({ escapeChar: e.currentTarget.value }); void reparse(); }} />
                  </label>
                </Show>
                <Show when={options().format !== "json"}>
                  <label class="export-check">
                    <input type="checkbox" checked={options().header}
                      onChange={(e) => { set({ header: e.currentTarget.checked }); void reparse(); }} />
                    First row is the header
                  </label>
                </Show>
              </div>
              <div class="export-row">
                <Show when={delimited()}>
                  <label>Encoding
                    <select value={options().encoding} onChange={(e) => { set({ encoding: e.currentTarget.value as ImportOptions["encoding"] }); void reparse(); }}>
                      <option value="utf-8">UTF-8 (BOM ok)</option>
                      <option value="latin1">Latin-1</option>
                    </select>
                  </label>
                </Show>
                <Show when={options().format !== "json"}>
                  <label>Skip rows
                    <input class="export-narrow" type="number" min="0" value={options().skipRows}
                      onChange={(e) => { set({ skipRows: Math.max(0, Number(e.currentTarget.value) || 0) }); void reparse(); }} />
                  </label>
                </Show>
                <label>NULL text
                  <input class="export-narrow" placeholder="\N" value={options().nullText}
                    onChange={(e) => { set({ nullText: e.currentTarget.value }); void reparse(); }} />
                </label>
                <Show when={options().format === "xlsx" && (preview()?.sheets.length ?? 0) > 1}>
                  <label>Sheet
                    <select value={options().sheet} onChange={(e) => { set({ sheet: e.currentTarget.value }); void reparse(); }}>
                      <For each={preview()?.sheets ?? []}>{(s) => <option value={s}>{s}</option>}</For>
                    </select>
                  </label>
                </Show>
              </div>
            </section>
          </Show>

          <Show when={preview()}>
            {(p) => (
              <section class="export-sec">
                <div class="export-label">
                  Preview: {p().columns.length} columns, {p().rows.length} row{p().rows.length === 1 ? "" : "s"} parsed
                  {p().truncated ? " (more follow)" : ""}
                  {p().rows.length > PREVIEW_ROWS_SHOWN ? `, showing ${PREVIEW_ROWS_SHOWN} rows` : ""}
                  {p().columns.length > PREVIEW_COLUMNS ? `, showing ${PREVIEW_COLUMNS} columns` : ""}
                </div>
                <div class="import-preview">
                  <table>
                    <thead><tr><For each={previewColumns(p())}>{(c) => <th>{c}</th>}</For></tr></thead>
                    <tbody>
                      <For each={p().rows.slice(0, PREVIEW_ROWS_SHOWN)}>
                        {(row) => (
                          <tr>
                            <For each={previewColumns(p())}>
                              {(_, i) => <td classList={{ "import-null": row[i()] === null }}>{row[i()] ?? "NULL"}</td>}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <Show when={p().warnings.length}>
                  <ul class="import-warnings">
                    <For each={p().warnings.slice(0, 6)}>{(w) => <li>{w}</li>}</For>
                  </ul>
                </Show>
              </section>
            )}
          </Show>
        </fieldset>

        <Show when={err()}><div class="error">{err()}</div></Show>
        <div class="form-actions">
          <button class="ghost" onClick={props.onClose}>Cancel</button>
          <button class="run" disabled={!preview() || busy()} onClick={() => void enterMapping()}>Next</button>
        </div>
      </Show>

      <Show when={step() === "mapping"}>
        <fieldset class="export-grid export-fieldset" disabled={busy()}>
          <section class="export-sec">
            <div class="export-label">Target</div>
            <div class="export-row">
              <div class="seg">
                <button classList={{ active: mode() === "existing" }} onClick={() => void pickMode("existing")}>Existing table</button>
                <button classList={{ active: mode() === "new" }} onClick={() => void pickMode("new")}>New table</button>
              </div>
              <Show when={props.supportsSchemas && mode() === "new"}>
                <label>Schema
                  <select value={schema()} onChange={(e) => setSchema(e.currentTarget.value)}>
                    <For each={props.schemas}>{(s) => <option value={s}>{s}</option>}</For>
                  </select>
                </label>
              </Show>
              <Show
                when={mode() === "existing"}
                fallback={
                  <label>Table name
                    <input value={table()} onInput={(e) => setTable(e.currentTarget.value)} placeholder="table_name" />
                  </label>
                }
              >
                <label>Table
                  <select
                    value={String(props.tables.findIndex((t) => t.schema === schema() && t.name === table()))}
                    onChange={(e) => void pickTable(Number(e.currentTarget.value))}
                  >
                    <option value="-1">choose…</option>
                    <For each={props.tables}>
                      {(t, i) => <option value={String(i())}>{props.supportsSchemas ? `${t.schema}.${t.name}` : t.name}</option>}
                    </For>
                  </select>
                </label>
              </Show>
            </div>
            <Show when={mode() === "existing"}>
              <div class="export-row">
                <label class="export-check">
                  <input type="checkbox" checked={truncate()} onChange={(e) => setTruncate(e.currentTarget.checked)} />
                  Empty the table first
                </label>
                <label>On conflict
                  <select value={conflict()} onChange={(e) => setConflict(e.currentTarget.value as ConflictMode)}>
                    <option value="error">{conflictLabel("error", props.dialect)}</option>
                    <option value="ignore">{conflictLabel("ignore", props.dialect)}</option>
                    <option value="update">{conflictLabel("update", props.dialect)}</option>
                  </select>
                </label>
                <Show when={conflict() === "update" && props.dialect === "postgres"}>
                  <label>Conflict key
                    <select
                      multiple
                      size={Math.min(4, Math.max(2, mapping().length))}
                      onChange={(e) =>
                        setKeyColumns([...e.currentTarget.selectedOptions].map((o) => o.value))
                      }
                    >
                      <For each={mapping().filter((m) => m.source !== null)}>
                        {(m) => <option value={m.target} selected={keyColumns().includes(m.target)}>{m.target}</option>}
                      </For>
                    </select>
                  </label>
                </Show>
              </div>
            </Show>
          </section>

          <section class="export-sec">
            <div class="export-label">
              Column mapping
              <span class="spacer" />
              <Show when={mode() === "existing"}>
                <button class="ghost" onClick={autoMatchAll}>Auto-match by name</button>
              </Show>
            </div>
            <div class="import-map">
              <table>
                <thead>
                  <tr>
                    <th>Target column</th>
                    <th>From file</th>
                    <th>Type</th>
                    <th title="Import an empty string as NULL">Empty → NULL</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={mapping()}>
                    {(m, i) => (
                      <tr classList={{ "import-skipped": m.source === null }}>
                        <td>
                          <Show when={mode() === "new"} fallback={<span>{m.target}</span>}>
                            <input value={m.target} onInput={(e) => setRow(i(), { target: e.currentTarget.value })} />
                          </Show>
                        </td>
                        <td>
                          <select
                            value={m.source === null ? SKIP : String(m.source)}
                            onChange={(e) =>
                              setRow(i(), {
                                source: e.currentTarget.value === SKIP ? null : Number(e.currentTarget.value),
                              })
                            }
                          >
                            <option value={SKIP}>— skip —</option>
                            <For each={preview()?.columns ?? []}>
                              {(c, k) => <option value={String(k())}>{c}</option>}
                            </For>
                          </select>
                        </td>
                        <td>
                          <Show
                            when={mode() === "new"}
                            fallback={<span class="import-type">{m.type}</span>}
                          >
                            <select value={m.type} onChange={(e) => setRow(i(), { type: e.currentTarget.value as ImportColumnType })}>
                              <For each={IMPORT_COLUMN_TYPES}>
                                {(t) => <option value={t}>{t} → {sqlTypeFor(t, props.dialect)}</option>}
                              </For>
                            </select>
                          </Show>
                        </td>
                        <td>
                          <input type="checkbox" checked={m.emptyAsNull} onChange={(e) => setRow(i(), { emptyAsNull: e.currentTarget.checked })} />
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <Show when={issues().length}>
              <ul class="import-warnings">
                <For each={issues()}>
                  {(issue) => <li classList={{ "import-error": issue.level === "error" }}>{issue.message}</li>}
                </For>
              </ul>
            </Show>
          </section>
        </fieldset>

        <Show when={err()}><div class="error">{err()}</div></Show>
        <div class="form-actions">
          <button class="ghost" onClick={() => setStep("source")}>Back</button>
          <span class="spacer" />
          <button class="ghost" onClick={props.onClose}>Cancel</button>
          <button class="run" disabled={busy() || blocking().length > 0} onClick={() => void run()}>Import</button>
        </div>
      </Show>

      <Show when={step() === "run"}>
        <section class="export-sec import-run">
          <Show when={busy()}>
            <div class="import-progress">
              <div class="import-bar"><div class="import-bar-fill" style={{ width: `${percent()}%` }} /></div>
              <div class="import-counts">
                {(props.progress()?.rowsRead ?? 0).toLocaleString()} rows read ·{" "}
                {(props.progress()?.rowsInserted ?? 0).toLocaleString()} written
              </div>
            </div>
          </Show>
          <Show when={summary()}>
            {(s) => (
              <div class="import-summary">
                <div><b>{s().rowsInserted.toLocaleString()}</b> rows written into {table()}.</div>
                <Show when={s().rowsSkipped > 0}>
                  <div>{s().rowsSkipped.toLocaleString()} row(s) skipped by the conflict rule.</div>
                </Show>
                <Show when={s().createdOutsideTransaction}>
                  <div>
                    MySQL commits DDL immediately, so <b>{table()}</b> was created as a separate,
                    already-committed step before the rows were loaded in one transaction.
                  </div>
                </Show>
                <Show when={s().warnings.length}>
                  <ul class="import-warnings">
                    <For each={s().warnings}>{(w) => <li>{w}</li>}</For>
                  </ul>
                </Show>
              </div>
            )}
          </Show>
          <Show when={err()}><div class="error">{err()}</div></Show>
        </section>
        <div class="form-actions">
          <Show
            when={busy()}
            fallback={
              <>
                <Show when={err()}>
                  <button class="ghost" onClick={() => { setErr(""); setStep("mapping"); }}>Back</button>
                </Show>
                <span class="spacer" />
                <button class="run" onClick={props.onClose}>Close</button>
              </>
            }
          >
            <span class="busy-label"><span class="spinner-sm" />Importing…</span>
            <span class="spacer" />
            <button class="ghost" onClick={() => void props.onCancelRun()}>Cancel &amp; roll back</button>
          </Show>
        </div>
      </Show>
    </Dialog>
  );
}

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
