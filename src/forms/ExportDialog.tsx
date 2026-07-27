import { createSignal, createMemo, For, Show } from "solid-js";
import { Dialog } from "../Dialog";
import { formatWithOptions } from "../formats";
import {
  defaultExportOptions,
  isDelimited,
  EXPORT_FORMATS,
  type ExportOptions,
  type ExportScope,
} from "../export";

type ColState = { idx: number; name: string; on: boolean };

/** DataGrip-style export configurator. Formats, options, column selection, scope. */
export function ExportDialog(props: {
  columns: string[];
  loadedRows: (string | null)[][];
  defaultTable: string;
  /** Source backend kind; SQL preview must use the same quoting as file/clipboard export. */
  dialect: string;
  /** Source indices of boolean columns (grid detection); exported as TRUE/FALSE. */
  boolCols?: number[];
  onClose: () => void;
  onExportFile: (opts: ExportOptions, scope: ExportScope) => Promise<boolean>;
  onExportClipboard: (opts: ExportOptions) => Promise<boolean>;
  /** Full-query export is blocked while a manual transaction owns the connection. */
  allowAllRows?: boolean;
  /** Immediately cancel + roll back an in-flight (streaming) export. */
  onCancel?: () => void | Promise<void>;
}) {
  const [opts, setOpts] = createSignal<ExportOptions>(defaultExportOptions(props.defaultTable));
  const [scope, setScope] = createSignal<ExportScope>(props.allowAllRows === false ? "loaded" : "all");
  const [dest, setDest] = createSignal<"file" | "clipboard">("file");
  const [cols, setCols] = createSignal<ColState[]>(
    props.columns.map((name, idx) => ({ idx, name, on: true })),
  );
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");

  const set = (patch: Partial<ExportOptions>) => setOpts({ ...opts(), ...patch });
  const fmt = () => opts().format;
  const delimited = () => isDelimited(fmt());
  const isXlsx = () => fmt() === "xlsx";

  // columnIndices = selected columns in current order.
  const columnIndices = () => cols().filter((c) => c.on).map((c) => c.idx);
  const move = (i: number, dir: -1 | 1) => {
    const next = [...cols()];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setCols(next);
  };

  const finalOpts = (): ExportOptions => ({ ...opts(), columnIndices: columnIndices(), boolCols: props.boolCols ?? [] });

  // Live preview of the first rows (cheap). Not shown for xlsx.
  const preview = createMemo(() => {
    if (isXlsx()) return "";
    const sample = { columns: props.columns, rows: props.loadedRows.slice(0, 12) };
    try {
      return formatWithOptions(sample, finalOpts(), props.dialect);
    } catch {
      return "";
    }
  });

  // When xlsx is chosen, clipboard isn't possible; clipboard forces loaded scope.
  const pickFormat = (f: ExportOptions["format"]) => {
    set({ format: f });
    if (f === "xlsx" && dest() === "clipboard") setDest("file");
  };
  const pickDest = (d: "file" | "clipboard") => {
    setDest(d);
    if (d === "clipboard") setScope("loaded");
  };

  async function run() {
    if (!columnIndices().length) {
      setErr("select at least one column");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const completed = dest() === "clipboard"
        ? await props.onExportClipboard(finalOpts())
        : await props.onExportFile(finalOpts(), scope());
      if (completed) props.onClose();
    } catch (e) {
      const m = e instanceof Object && "message" in e ? String((e as any).message) : String(e);
      setErr(/cancel/i.test(m) ? "Export cancelled." : m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Export" onClose={props.onClose} width={620} dismissable={!busy()}>
      <fieldset class="export-grid export-fieldset" disabled={busy()}>
        <section class="export-sec">
          <div class="export-label">Format</div>
          <select value={fmt()} onChange={(e) => pickFormat(e.currentTarget.value as ExportOptions["format"])}>
            <For each={EXPORT_FORMATS}>{(f) => <option value={f.value}>{f.label}</option>}</For>
          </select>
        </section>

        <Show when={delimited()}>
          <section class="export-sec">
            <div class="export-label">Delimited options</div>
            <div class="export-row">
              <label>Delimiter
                <select value={opts().delimiter} onChange={(e) => set({ delimiter: e.currentTarget.value as any })}>
                  <option value="comma">Comma</option>
                  <option value="tab">Tab</option>
                  <option value="semicolon">Semicolon</option>
                  <option value="pipe">Pipe</option>
                  <option value="custom">Custom…</option>
                </select>
              </label>
              <Show when={opts().delimiter === "custom"}>
                <label>Char
                  <input class="export-narrow" maxLength={1} value={opts().customDelimiter}
                    onInput={(e) => set({ customDelimiter: e.currentTarget.value })} />
                </label>
              </Show>
              <label>Quoting
                <select value={opts().quote} onChange={(e) => set({ quote: e.currentTarget.value as any })}>
                  <option value="asNeeded">As needed</option>
                  <option value="always">Always</option>
                  <option value="never">Never</option>
                </select>
              </label>
              <label>Quote char
                <input class="export-narrow" maxLength={1} value={opts().quoteChar}
                  onInput={(e) => set({ quoteChar: e.currentTarget.value })} />
              </label>
            </div>
            <div class="export-row">
              <label>NULL as
                <select value={opts().nullMode} onChange={(e) => set({ nullMode: e.currentTarget.value as any })}>
                  <option value="empty">Empty</option>
                  <option value="literal">NULL</option>
                  <option value="custom">Custom…</option>
                </select>
              </label>
              <Show when={opts().nullMode === "custom"}>
                <label>Text
                  <input class="export-narrow" value={opts().nullText} onInput={(e) => set({ nullText: e.currentTarget.value })} />
                </label>
              </Show>
              <label>Line ending
                <select value={opts().lineEnding} onChange={(e) => set({ lineEnding: e.currentTarget.value as any })}>
                  <option value="lf">LF</option>
                  <option value="crlf">CRLF</option>
                </select>
              </label>
              <label class="export-check"><input type="checkbox" checked={opts().bom} onChange={(e) => set({ bom: e.currentTarget.checked })} />UTF-8 BOM</label>
            </div>
          </section>
        </Show>

        <Show when={delimited() || isXlsx()}>
          <label class="export-check"><input type="checkbox" checked={opts().header} onChange={(e) => set({ header: e.currentTarget.checked })} />Header row</label>
        </Show>

        <Show when={fmt() === "sql"}>
          <section class="export-sec">
            <div class="export-label">SQL options</div>
            <div class="export-row">
              <label>Table
                <input value={opts().sql.table} onInput={(e) => setOpts({ ...opts(), sql: { ...opts().sql, table: e.currentTarget.value } })} />
              </label>
              <label class="export-check"><input type="checkbox" checked={opts().sql.multiRow} onChange={(e) => setOpts({ ...opts(), sql: { ...opts().sql, multiRow: e.currentTarget.checked } })} />Multi-row INSERT</label>
              <label class="export-check"><input type="checkbox" checked={opts().sql.includeCreate} onChange={(e) => setOpts({ ...opts(), sql: { ...opts().sql, includeCreate: e.currentTarget.checked } })} />Include CREATE TABLE</label>
            </div>
          </section>
        </Show>

        <Show when={isXlsx()}>
          <section class="export-sec">
            <div class="export-label">Excel options</div>
            <div class="export-row">
              <label>Sheet name
                <input value={opts().xlsx.sheetName} onInput={(e) => setOpts({ ...opts(), xlsx: { ...opts().xlsx, sheetName: e.currentTarget.value } })} />
              </label>
              <label class="export-check"><input type="checkbox" checked={opts().xlsx.headerStyling} onChange={(e) => setOpts({ ...opts(), xlsx: { ...opts().xlsx, headerStyling: e.currentTarget.checked } })} />Bold header</label>
              <label class="export-check"><input type="checkbox" checked={opts().xlsx.autoFilter} onChange={(e) => setOpts({ ...opts(), xlsx: { ...opts().xlsx, autoFilter: e.currentTarget.checked } })} />Auto-filter</label>
              <label class="export-check"><input type="checkbox" checked={opts().xlsx.freezeHeader} onChange={(e) => setOpts({ ...opts(), xlsx: { ...opts().xlsx, freezeHeader: e.currentTarget.checked } })} />Freeze header</label>
            </div>
          </section>
        </Show>

        <section class="export-sec">
          <div class="export-label">Columns</div>
          <div class="export-cols">
            <For each={cols()}>
              {(c, i) => (
                <div class="export-col">
                  <label class="export-check">
                    <input type="checkbox" checked={c.on} onChange={(e) => setCols(cols().map((x, k) => (k === i() ? { ...x, on: e.currentTarget.checked } : x)))} />
                    {c.name}
                  </label>
                  <span class="spacer" />
                  <button class="icon" title="Move up" disabled={i() === 0} onClick={() => move(i(), -1)}>↑</button>
                  <button class="icon" title="Move down" disabled={i() === cols().length - 1} onClick={() => move(i(), 1)}>↓</button>
                </div>
              )}
            </For>
          </div>
        </section>

        <section class="export-sec">
          <div class="export-label">Source &amp; destination</div>
          <div class="export-row">
            <label>Rows
              <select value={scope()} onChange={(e) => setScope(e.currentTarget.value as ExportScope)} disabled={dest() === "clipboard"}>
                <option value="all" disabled={props.allowAllRows === false}>All rows (re-run query)</option>
                <option value="loaded">Loaded rows ({props.loadedRows.length})</option>
              </select>
            </label>
            <label>To
              <select value={dest()} onChange={(e) => pickDest(e.currentTarget.value as "file" | "clipboard")}>
                <option value="file">File</option>
                <option value="clipboard" disabled={isXlsx()}>Clipboard</option>
              </select>
            </label>
          </div>
        </section>

        <Show when={preview()}>
          <section class="export-sec">
            <div class="export-label">Preview</div>
            <pre class="export-preview">{preview()}</pre>
          </section>
        </Show>

        <Show when={isXlsx()}>
          <div class="export-note">Excel streams through temporary worksheet files; rows past 1,048,576 roll into additional sheets.</div>
        </Show>
      </fieldset>

      <Show when={err()}><div class="error">{err()}</div></Show>
      <div class="form-actions">
        <Show
          when={busy()}
          fallback={
            <>
              <button class="ghost" onClick={props.onClose}>Cancel</button>
              <button class="run" onClick={run}>{dest() === "clipboard" ? "Copy" : "Export"}</button>
            </>
          }
        >
          <span class="busy-label"><span class="spinner-sm" />{dest() === "clipboard" ? "Copying…" : "Exporting…"}</span>
          <span class="spacer" />
          <button class="ghost" onClick={() => void props.onCancel?.()}>Cancel export</button>
        </Show>
      </div>
    </Dialog>
  );
}
