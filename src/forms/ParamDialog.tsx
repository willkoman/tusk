import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { Dialog, SqlPreview } from "../Dialog";
import { missingParams, substituteParams, type Param, type ParamValue } from "../sql/params";

// Pre-run parameter prompt: one row per detected `$n` / `%s` / `:name` — name in
// its own column, then the value with NULL and raw as inline toggles — plus a live
// preview of the substituted SQL. Values are remembered per tab by the caller.
// Run stays disabled while any value is blank: the preview would show `id > ''`.

export function ParamDialog(props: {
  sql: string;
  params: Param[];
  initial: Record<string, ParamValue> | undefined;
  onRun: (values: Record<string, ParamValue>, substituted: string) => void;
  onClose: () => void;
}) {
  const blank = (): ParamValue => ({ value: "", raw: false, isNull: false });
  const [values, setValues] = createSignal<Record<string, ParamValue>>(
    Object.fromEntries(props.params.map((p) => [p.name, props.initial?.[p.name] ?? blank()])),
  );
  const patch = (name: string, v: Partial<ParamValue>) =>
    setValues((m) => ({ ...m, [name]: { ...m[name], ...v } }));

  const preview = createMemo(() => substituteParams(props.sql, values()));
  const previewText = createMemo(() => {
    const text = preview();
    const limit = 20_000;
    return text.length <= limit ? text : `${text.slice(0, limit)}\n-- preview truncated; full SQL will run`;
  });

  const missing = createMemo(() => missingParams(props.params, values()));
  const uid = createUniqueId();

  const run = () => {
    if (missing().length) return;
    props.onRun(values(), preview());
  };

  return (
    <Dialog
      title="Query parameters"
      size="md"
      onClose={props.onClose}
      onEnter={run}
      footer={
        <>
          <SqlPreview sql={previewText()} />
          <div class="form-actions">
            <button type="button" class="ghost" onClick={props.onClose}>Cancel</button>
            <button
              type="button"
              class="run"
              disabled={missing().length > 0}
              title={missing().length ? `Needs a value or NULL: ${missing().join(", ")}` : undefined}
              onClick={run}
            >
              Run
            </button>
          </div>
        </>
      }
    >
        <div class="param-rows">
          <For each={props.params}>
            {(p, i) => (
              <div class="param-row">
                <label class="param-name" for={`${uid}-${i()}`}>{p.name}</label>
                <div class="param-value">
                  <input
                    id={`${uid}-${i()}`}
                    value={values()[p.name].value}
                    disabled={values()[p.name].isNull}
                    ref={(el) => { if (i() === 0) setTimeout(() => { el.focus(); el.select(); }); }}
                    onInput={(e) => patch(p.name, { value: e.currentTarget.value })}
                    placeholder={values()[p.name].isNull ? "NULL" : "value"}
                  />
                  <label class="checkbox param-flag" title="Send SQL NULL">
                    <input type="checkbox" checked={values()[p.name].isNull} onChange={(e) => patch(p.name, { isNull: e.currentTarget.checked })} />
                    NULL
                  </label>
                  <label class="checkbox param-flag" title="Inserted unquoted, exactly as typed">
                    <input type="checkbox" checked={values()[p.name].raw} disabled={values()[p.name].isNull} onChange={(e) => patch(p.name, { raw: e.currentTarget.checked })} />
                    raw
                  </label>
                </div>
              </div>
            )}
          </For>
        </div>
        <Show when={missing().length}>
          <div class="field-hint">Every parameter needs a value, NULL, or raw.</div>
        </Show>
        <Show when={props.params.some((p) => p.name.startsWith("%s #"))}>
          <div class="import-info">
            <code>%s</code> values are quoted. For PostgreSQL <code>ANY(%s)</code>, enter <code>{`{1,2}`}</code>, or tick raw and enter <code>ARRAY[1,2]</code>.
          </div>
        </Show>
    </Dialog>
  );
}
